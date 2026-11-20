import {createClient} from "npm:@supabase/supabase-js@2.78.0";
const MODEL="gemini-2.5-flash-image";
const BUCKET="chatbot-line-image";
const TTL=7*86400;
const MAX_BYTES=8*1024*1024;
export class ImageError extends Error{
  constructor(readonly reason:"quota"|"unavailable",message:string){super(message);}
}
async function generateGemini(key:string,prompt:string):Promise<{bytes:Uint8Array;mime:string}>{
  let r:Response;
  try{
    r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+MODEL+":generateContent",{
      method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":key},
      body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt.slice(0,1200)}]}],
        generationConfig:{responseModalities:["TEXT","IMAGE"]}}),
      signal:AbortSignal.timeout(30000)
    });
  }catch{throw new ImageError("unavailable","image_request_failed");}
  if(!r.ok){
    const details=(await r.text()).slice(0,1200);
    const quota=r.status===429||(r.status===403&&/quota|RESOURCE_EXHAUSTED|free.tier.limit/i.test(details));
    throw new ImageError(quota?"quota":"unavailable","image_http_"+r.status);
  }
  const json=await r.json();
  const parts=json?.candidates?.[0]?.content?.parts||[];
  const found=parts.find((p:{inlineData?:{data?:string;mimeType?:string}})=>
    typeof p.inlineData?.data==="string"&&/^image\/(png|jpeg|webp)$/i.test(p.inlineData.mimeType||""))?.inlineData;
  if(!found?.data)throw new ImageError("unavailable","image_no_data");
  if(found.data.length>Math.ceil(MAX_BYTES*4/3)+100)throw new ImageError("unavailable","image_too_large");
  const raw=atob(found.data);
  if(raw.length<100||raw.length>MAX_BYTES)throw new ImageError("unavailable","image_size_invalid");
  return {bytes:Uint8Array.from(raw,c=>c.charCodeAt(0)),mime:found.mimeType.toLowerCase()};
}

// Optional self-hosted ChatGPT2API provider. OFF until explicitly configured.
// No provider fallback when enabled: gateway errors are retried by the existing queue,
// never replaced by a paid OpenAI API call.
export async function generateViaChatGPT2API(prompt:string):Promise<{bytes:Uint8Array;mime:string}>{
  const base=(Deno.env.get("CHATGPT2API_URL")||"").trim();
  const key=Deno.env.get("CHATGPT2API_API_KEY")||"";
  const model=Deno.env.get("CHATGPT2API_IMAGE_MODEL")||"gpt-image-2.6";
  if(!base||!key)throw new ImageError("unavailable","chatgpt2api_not_configured");
  let url:URL;
  try{
    url=new URL(base);
    if(url.protocol!=="https:"||url.username||url.password)throw new Error("insecure_url");
  }catch{throw new ImageError("unavailable","chatgpt2api_invalid_https_url");}
  let response:Response;
  try{
    response=await fetch(url.origin+"/v1/images/generations",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+key},
      body:JSON.stringify({model,prompt:prompt.slice(0,1200),n:1,response_format:"b64_json"}),
      signal:AbortSignal.timeout(110000)
    });
  }catch{throw new ImageError("unavailable","chatgpt2api_request_failed");}
  if(!response.ok)throw new ImageError(response.status===429?"quota":"unavailable","chatgpt2api_http_"+response.status);
  const length=Number(response.headers.get("content-length")||0);
  if(length>MAX_BYTES*2)throw new ImageError("unavailable","chatgpt2api_response_too_large");
  let encoded:unknown;
  try{
    const json=await response.json();
    encoded=json?.data?.[0]?.b64_json;
  }catch{throw new ImageError("unavailable","chatgpt2api_invalid_json");}
  if(typeof encoded!=="string"||encoded.length>Math.ceil(MAX_BYTES*4/3)+100)
    throw new ImageError("unavailable","chatgpt2api_image_missing_or_too_large");
  let raw:string;
  try{raw=atob(encoded);}catch{throw new ImageError("unavailable","chatgpt2api_invalid_base64");}
  if(raw.length<100||raw.length>MAX_BYTES)throw new ImageError("unavailable","chatgpt2api_image_invalid_size");
  let mime="";
  if(raw.startsWith("\x89PNG\r\n\x1a\n"))mime="image/png";
  else if(raw.charCodeAt(0)===0xff&&raw.charCodeAt(1)===0xd8&&raw.charCodeAt(2)===0xff)mime="image/jpeg";
  else if(raw.startsWith("RIFF")&&raw.slice(8,12)==="WEBP")mime="image/webp";
  if(!mime)throw new ImageError("unavailable","chatgpt2api_unsupported_image");
  return {bytes:Uint8Array.from(raw,c=>c.charCodeAt(0)),mime};
}
async function generate(key:string,prompt:string):Promise<{bytes:Uint8Array;mime:string}>{
  if(Deno.env.get("CHATGPT2API_ENABLED")==="1")return generateViaChatGPT2API(prompt);
  return generateGemini(key,prompt);
}

export async function makeImageAnswer(key:string,url:string,serviceKey:string,prompt:string):
Promise<{originalContentUrl:string;previewImageUrl:string;model:string}>{
  const image=await generate(key,prompt);
  const client=createClient(url,serviceKey,{auth:{autoRefreshToken:false,persistSession:false}});
  const ext=image.mime==="image/jpeg"?"jpg":image.mime==="image/webp"?"webp":"png";
  const name=new Date().toISOString().slice(0,10).replaceAll("-","")+"-"+crypto.randomUUID()+"."+ext;
  const {error}=await client.storage.from(BUCKET).upload(name,image.bytes,{upsert:false,contentType:image.mime,cacheControl:"3600"});
  if(error)throw new ImageError("unavailable","image_upload_failed");
  const {data,error:signErr}=await client.storage.from(BUCKET).createSignedUrl(name,TTL);
  if(signErr||!data?.signedUrl)throw new ImageError("unavailable","image_sign_failed");
  return {originalContentUrl:data.signedUrl,previewImageUrl:data.signedUrl,model:Deno.env.get("CHATGPT2API_ENABLED")==="1"?(Deno.env.get("CHATGPT2API_IMAGE_MODEL")||"gpt-image-2.6"):MODEL};
}
export async function cleanupOldImageFiles(url:string,serviceKey:string):Promise<void>{
  try{
    const c=createClient(url,serviceKey,{auth:{autoRefreshToken:false,persistSession:false}});
    const {data,error}=await c.storage.from(BUCKET).list("",{limit:100,sortBy:{column:"created_at",order:"asc"}});
    if(error||!data)return;
    const old=data.filter(x=>/\.(png|jpe?g|webp)$/i.test(x.name||"")&&x.created_at&&Date.parse(x.created_at)<Date.now()-TTL*1000).map(x=>x.name);
    if(old.length)await c.storage.from(BUCKET).remove(old);
  }catch{}
}