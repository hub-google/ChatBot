import {createClient} from "npm:@supabase/supabase-js@2.78.0";
const MODEL="gemini-2.5-flash-image";
const BUCKET="chatbot-line-image";
const TTL=7*86400;
const MAX_BYTES=8*1024*1024;
export class ImageError extends Error{
  constructor(readonly reason:"quota"|"unavailable",message:string){super(message);}
}
async function generate(key:string,prompt:string):Promise<{bytes:Uint8Array;mime:string}>{
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
  return {originalContentUrl:data.signedUrl,previewImageUrl:data.signedUrl,model:MODEL};
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