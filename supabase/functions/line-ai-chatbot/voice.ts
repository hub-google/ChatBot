import * as lame from "npm:@breezystack/lamejs@1.2.7";
import {createClient} from "npm:@supabase/supabase-js@2.78.0";
const VOICE_MODEL="gemini-2.5-flash-preview-tts";
const VOICE_NAME="Leda";
const VOICE_BUCKET="chatbot-line-voice";
const MAX_OUTPUT=270000;
const TTL_SECONDS=604800;
export class VoiceError extends Error{
  constructor(readonly reason:"quota"|"unavailable",message:string){super(message);}
}
function pcmToMp3(base64:string,sampleRate:number):{bytes:Uint8Array;duration:number}{
  if(!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>48000)
    throw new VoiceError("unavailable","invalid_sample_rate");
  if(base64.length>3000000)throw new VoiceError("unavailable","pcm_too_long");
  const raw=atob(base64);
  const samples=new Int16Array(Math.floor(raw.length/2));
  for(let i=0;i<samples.length;i++){
    const value=raw.charCodeAt(i*2)|(raw.charCodeAt(i*2+1)<<8);
    samples[i]=value>=32768?value-65536:value;
  }
  const duration=Math.round(samples.length*1000/sampleRate);
  if(duration<100||duration>40000)throw new VoiceError("unavailable","audio_duration_invalid");
  const encoder=new lame.Mp3Encoder(1,sampleRate,64);
  const result:Uint8Array[]=[];
  let total=0;
  for(let i=0;i<samples.length;i+=1152){
    const encoded=encoder.encodeBuffer(samples.subarray(i,i+1152));
    if(encoded.length){const part=new Uint8Array(encoded);result.push(part);total+=part.length;}
  }
  const end=encoder.flush();
  if(end.length){const part=new Uint8Array(end);result.push(part);total+=part.length;}
  if(total<100||total>MAX_OUTPUT)throw new VoiceError("unavailable","mp3_size_invalid");
  const bytes=new Uint8Array(total);
  let offset=0;for(const part of result){bytes.set(part,offset);offset+=part.length;}
  return {bytes,duration};
}
async function generatePcm(key:string,text:string):Promise<{audio:string;rate:number}>{
  const prompt="用台灣繁體中文，活潑可愛的年輕少女語氣，自然清楚地朗讀以下內容，請勿添加額外文字：\n"+text.slice(0,240);
  const data={contents:[{parts:[{text:prompt}]}],generationConfig:{
    responseModalities:["AUDIO"],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:VOICE_NAME}}}
  }};
  for(let n=0;n<2;n++){
    let response:Response;
    try{
      response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+VOICE_MODEL+":generateContent",{
        method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":key},
        body:JSON.stringify(data),signal:AbortSignal.timeout(14000)
      });
    }catch{
      if(n===1)throw new VoiceError("unavailable","tts_request_failed");
      continue;
    }
    if(response.status===429)throw new VoiceError("quota","tts_quota_429");
    if(!response.ok){
      const detail=(await response.text()).slice(0,1000);
      if(response.status===403&&/quota|limit|RESOURCE_EXHAUSTED/i.test(detail))
        throw new VoiceError("quota","tts_quota_403");
      if(n===1)throw new VoiceError("unavailable","tts_http_"+response.status);
      continue;
    }
    const output=await response.json();
    const parts=output?.candidates?.[0]?.content?.parts||[];
    const clip=parts.find((part:{inlineData?:{data?:string;mimeType?:string}})=>
      typeof part.inlineData?.data==="string")?.inlineData;
    if(clip?.data){
      const match=/rate=(\d+)/.exec(clip.mimeType||"");
      return {audio:clip.data,rate:match?Number(match[1]):24000};
    }
    if(n===1)throw new VoiceError("unavailable","tts_empty_audio");
  }
  throw new VoiceError("unavailable","tts_unavailable");
}
export async function makeVoiceAnswer(
  geminiKey:string,supabaseUrl:string,serviceKey:string,text:string
):Promise<{originalContentUrl:string;duration:number}>{
  const pcm=await generatePcm(geminiKey,text);
  const mp3=pcmToMp3(pcm.audio,pcm.rate);
  const client=createClient(supabaseUrl,serviceKey,{
    auth:{autoRefreshToken:false,persistSession:false}
  });
  const name=new Date().toISOString().slice(0,10).replaceAll("-","")+"-"+crypto.randomUUID()+".mp3";
  const {error}=await client.storage.from(VOICE_BUCKET).upload(name,mp3.bytes,{
    upsert:false,contentType:"audio/mpeg",cacheControl:"3600"
  });
  if(error)throw new VoiceError("unavailable","storage_upload_failed");
  const {data, error:signError}=await client.storage.from(VOICE_BUCKET).createSignedUrl(name,TTL_SECONDS);
  if(signError||!data?.signedUrl)throw new VoiceError("unavailable","storage_sign_failed");
  return {originalContentUrl:data.signedUrl,duration:mp3.duration};
}
export async function cleanupOldVoiceFiles(supabaseUrl:string,serviceKey:string):Promise<void>{
  try{
    const client=createClient(supabaseUrl,serviceKey,{auth:{autoRefreshToken:false,persistSession:false}});
    const {data,error}=await client.storage.from(VOICE_BUCKET).list("",{
      limit:100,sortBy:{column:"created_at",order:"asc"}
    });
    if(error||!data)return;
    const cutoff=Date.now()-TTL_SECONDS*1000;
    const stale=data.filter(item=>item.name?.endsWith(".mp3")&&item.created_at&&
      Date.parse(item.created_at)<cutoff).map(item=>item.name);
    if(stale.length)await client.storage.from(VOICE_BUCKET).remove(stale);
  }catch{/* best effort */}
}
