/** Discord Interactions endpoint: /ask slash command using verified Ed25519 signatures. */
import {channelReply,json} from "../_shared/channel-engine.ts";
declare const EdgeRuntime: {waitUntil:(p:Promise<unknown>)=>void}|undefined;
const unhex=(s:string)=>Uint8Array.from(s.match(/.{2}/g)||[],h=>parseInt(h,16));
async function validSignature(raw:string,signature:string,timestamp:string,publicKey:string):Promise<boolean>{
 if(!/^[a-f0-9]{128}$/i.test(signature)||!/^[a-f0-9]{64}$/i.test(publicKey)||!/^\d{10}$/.test(timestamp))return false;
 // Drop old signatures to limit replays.
 if(Math.abs(Date.now()/1000-Number(timestamp))>300)return false;
 try{
  const key=await crypto.subtle.importKey("raw",unhex(publicKey),{name:"Ed25519"},false,["verify"]);
  return await crypto.subtle.verify({name:"Ed25519"},key,unhex(signature),new TextEncoder().encode(timestamp+raw));
 }catch{return false;}
}
type Interaction={id?:string;application_id?:string;token?:string;type?:number;channel_id?:string;user?:{id?:string};member?:{user?:{id?:string}};data?:{name?:string;options?:Array<{name?:string;value?:unknown}>}};
Deno.serve(async(request:Request)=>{
 if(request.method==="GET")return json({service:"chatbot-discord",ready:Boolean(Deno.env.get("CHATBOT_DISCORD_PUBLIC_KEY"))});
 if(request.method!=="POST")return json({error:"method_not_allowed"},405);
 const publicKey=Deno.env.get("CHATBOT_DISCORD_PUBLIC_KEY")||"";
 if(!publicKey)return json({error:"discord_not_configured"},503);
 if(Number(request.headers.get("content-length")||0)>16000)return json({error:"too_large"},413);
 const raw=await request.text();
 if(!(await validSignature(raw,request.headers.get("x-signature-ed25519")||"",request.headers.get("x-signature-timestamp")||"",publicKey)))
   return json({error:"invalid_signature"},401);
 let event:Interaction;
 try{event=JSON.parse(raw);}catch{return json({error:"invalid_json"},400);}
 if(event.type===1)return json({type:1});
 if(event.type!==2||event.data?.name!=="ask")return json({type:4,data:{content:"請使用 /ask 指令。",flags:64}});
 const question=event.data.options?.find(x=>x.name==="question")?.value;
 if(typeof question!=="string"||!question.trim()||!event.id||!event.application_id||!event.token)
   return json({type:4,data:{content:"請輸入問題。",flags:64}});
 const send=async()=>{
  try{
   const chatKey=(event.channel_id||"dm")+":"+(event.member?.user?.id||event.user?.id||"unknown");
   const result=await channelReply("discord",chatKey,event.id!,question.trim().slice(0,2000));
   const endpoint="https://discord.com/api/v10/webhooks/"+encodeURIComponent(event.application_id!)+"/"+encodeURIComponent(event.token!)+"/messages/@original";
   const res=await fetch(endpoint,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:result.text.slice(0,1900)}),signal:AbortSignal.timeout(10000)});
   if(!res.ok)console.error("discord_response_failed",res.status);
  }catch(e){console.error("discord_processing_error",String(e instanceof Error?e.message:e).slice(0,100));}
 };
 if(typeof EdgeRuntime!=="undefined"&&typeof EdgeRuntime.waitUntil==="function")EdgeRuntime.waitUntil(send());
 else await send();
 return json({type:5,data:{flags:64}});
});
