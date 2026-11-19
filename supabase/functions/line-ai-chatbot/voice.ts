import * as lame from "npm:@breezystack/lamejs@1.2.7";
import {createClient} from "npm:@supabase/supabase-js@2.78.0";
const VOICE_MODEL="gemini-2.5-flash-preview-tts";
export type VoiceName="Zephyr"|"Leda"|"Aoede"|"萌妹";
export const DEFAULT_VOICE_NAME:VoiceName="萌妹";
const VOICE_COMMAND=/#說話(?:[：:]\s*(Zephyr|Leda|Aoede|萌妹))?/gi;
export function parseVoiceCommand(input:string):{requested:boolean;voiceName:VoiceName;text:string}{
  let requested=false;
  let voiceName:VoiceName=DEFAULT_VOICE_NAME;
  const text=input.replace(VOICE_COMMAND,(_match,selected:string|undefined)=>{
    requested=true;
    if(selected){
      const selectedLower=selected.toLowerCase();
      voiceName=selectedLower==="萌妹"?"萌妹":selectedLower==="leda"?"Leda":selectedLower==="aoede"?"Aoede":"Zephyr";
    }
    return "";
  }).trim();
  return {requested,voiceName,text};
}
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
async function generatePcm(key:string,text:string,voiceName:VoiceName):Promise<{audio:string;rate:number}>{
  const prompt=[
    "請用自然的台灣華語朗讀以下回覆，就像二十多歲的甜美女生在 LINE 傳語音給熟朋友。",
    "語氣親切、輕盈、俏皮，帶一點自然笑意。依句子情緒自然變化語調，語速略輕快、停頓自然。",
    "不要客服、新聞播報、配音員或機械朗讀的口吻，也不要刻意提高音調、裝嗲或拖長尾音。",
    "只說出下方回覆本身，不要念出指令、添加句子或改動資訊。",
    "【回覆】",
    text.slice(0,240)
  ].join("\n");
  const data={contents:[{parts:[{text:prompt}]}],generationConfig:{
    responseModalities:["AUDIO"],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName}}}
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

// Fish Audio S2.1 Pro Free. Never omit/change the explicit free-model header:
// the provider's default model is billable s2.1-pro.
const FISH_TTS_URL="https://api.fish.audio/v1/tts";
const FISH_FREE_MODEL="s2.1-pro-free";
const CUTE_VOICE_ID="8289a1de1c9448719c9ccaf12fe96492";
const MAX_FISH_MP3=850000;

function mp3DurationMs(bytes:Uint8Array):number{
  let i=0;
  if(bytes.length>10&&bytes[0]===0x49&&bytes[1]===0x44&&bytes[2]===0x33){
    i=10+((bytes[6]&0x7f)<<21)+((bytes[7]&0x7f)<<14)+((bytes[8]&0x7f)<<7)+(bytes[9]&0x7f);
    if((bytes[5]&0x10)!==0)i+=10;
  }
  let seconds=0,frames=0;
  while(i+4<=bytes.length){
    const a=bytes[i],b=bytes[i+1],c=bytes[i+2];
    const version=(b>>3)&3,layer=(b>>1)&3,rateIndex=(c>>2)&3,bitrateIndex=(c>>4)&15;
    if(a!==0xff||(b&0xe0)!==0xe0||version===1||layer!==1||
       rateIndex===3||bitrateIndex===0||bitrateIndex===15){if(frames)break;i++;continue;}
    const rates=version===3?[44100,48000,32000]:version===2?[22050,24000,16000]:[11025,12000,8000];
    const bitrates=version===3
      ?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]
      :[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
    const hz=rates[rateIndex],kbps=bitrates[bitrateIndex],padding=(c>>1)&1;
    const frameSize=Math.floor((version===3?144:72)*kbps*1000/hz)+padding;
    if(i+frameSize>bytes.length)break;
    seconds+=(version===3?1152:576)/hz;
    frames++;
    i+=frameSize;
  }
  const duration=Math.round(seconds*1000);
  if(frames<2||duration<100||duration>40000)throw new VoiceError("unavailable","fish_mp3_duration_invalid");
  return duration;
}
async function generateFishMp3(key:string,text:string):Promise<{bytes:Uint8Array;duration:number}>{
  const response=await fetch(FISH_TTS_URL,{
    method:"POST",
    headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json","model":FISH_FREE_MODEL},
    body:JSON.stringify({
      text:text.slice(0,240),reference_id:CUTE_VOICE_ID,format:"mp3",
      mp3_bitrate:64,latency:"normal",temperature:0.75
    }),
    signal:AbortSignal.timeout(23000)
  });
  if(response.status===429||response.status===402)
    throw new VoiceError("quota","fish_free_quota_"+response.status);
  if(!response.ok)throw new VoiceError("unavailable","fish_http_"+response.status);
  const size=Number(response.headers.get("content-length")||0);
  if(size>MAX_FISH_MP3)throw new VoiceError("unavailable","fish_mp3_too_large");
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length<100||bytes.length>MAX_FISH_MP3)
    throw new VoiceError("unavailable","fish_mp3_invalid_size");
  return {bytes,duration:mp3DurationMs(bytes)};
}

export async function makeVoiceAnswer(
  geminiKey:string,supabaseUrl:string,serviceKey:string,text:string,voiceName:VoiceName=DEFAULT_VOICE_NAME,
  fishKey:string|null=null
):Promise<{originalContentUrl:string;duration:number;voiceName:VoiceName}>{
  let mp3:{bytes:Uint8Array;duration:number};
  let actualVoiceName:VoiceName=voiceName;
  if(voiceName==="萌妹"&&fishKey){
    try{
      mp3=await generateFishMp3(fishKey,text);
    }catch(e){
      // Never retry with a paid Fish model. Preserve the existing Gemini fallback.
      console.warn("fish_tts_fallback",e instanceof Error?e.message:"fish_tts_error");
      const pcm=await generatePcm(geminiKey,text,"Leda");
      mp3=pcmToMp3(pcm.audio,pcm.rate);
      actualVoiceName="Leda";
    }
  }else{
    const selected=voiceName==="萌妹"?"Leda":voiceName;
    const pcm=await generatePcm(geminiKey,text,selected);
    mp3=pcmToMp3(pcm.audio,pcm.rate);
    actualVoiceName=selected;
  }
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
  return {originalContentUrl:data.signedUrl,duration:mp3.duration,voiceName:actualVoiceName};
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
