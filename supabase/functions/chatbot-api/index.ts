/** CHATBOT cross-platform adapter. This does not change LINE Webhook or LINE delivery. */
import { generateText, loadKnowledge, generateGroundedAnswer } from '../line-ai-chatbot/generation.ts';
import { needsWebSearch, searchWebContext } from '../line-ai-chatbot/search.ts';
const url=Deno.env.get("SUPABASE_URL")||"";
const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||(()=>{try{return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}").default||"";}catch{return "";}})();
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, content-type, apikey","Access-Control-Allow-Methods":"POST, OPTIONS, GET","Cache-Control":"no-store"};
const out=(v:unknown,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{...cors,"Content-Type":"application/json; charset=utf-8"}});
async function db(path:string,opts:RequestInit={}):Promise<Response>{
 if(!url||!key)throw Error("database_not_configured");
 const headers:Record<string,string>={"apikey":key,"Content-Type":"application/json",...(opts.headers as Record<string,string>||{})};
 if(!key.startsWith("sb_secret_"))headers.Authorization="Bearer "+key;
 const r=await fetch(url+"/rest/v1/"+path,{...opts,headers,signal:AbortSignal.timeout(9000)});
 if(!r.ok)throw Error("database_"+r.status);
 return r;
}
const rows=async(path:string,opts:RequestInit={})=>(await db(path,opts)).json();
const digest=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,"0")).join("");
const newToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("");
const messageTable=encodeURIComponent("ChatBot_Bridge_messages"),deviceTable=encodeURIComponent("ChatBot_Bridge_devices");
async function authorize(req:Request):Promise<string|null>{
 const m=/^Bearer ([a-f0-9]{64})$/i.exec(req.headers.get("Authorization")||"");
 if(!m)return null;
 const users=await rows(deviceTable+"?token_hash=eq."+await digest(m[1])+"&revoked_at=is.null&select=id&limit=1");
 return Array.isArray(users)&&users.length?users[0].id:null;
}
async function getHistory(device:string,session:string){
 const x=await rows(messageTable+"?device_id=eq."+device+"&conversation_id=eq."+session+"&select=role,content&order=id.desc&limit=20");
 return (Array.isArray(x)?x:[]).reverse().map((v:{role:"user"|"model";content:string})=>({role:v.role,content:v.content}));
}
async function lookupReply(device:string,session:string,eventId:string){
 const x=await rows(messageTable+"?device_id=eq."+device+"&conversation_id=eq."+session+"&event_id=eq."+eventId+"&role=eq.model&select=content,model&limit=1");
 return Array.isArray(x)?x[0]:null;
}
async function save(device:string,origin:string,session:string,eventId:string,role:"user"|"model",content:string,model:string){
 const r=await db(messageTable+"?on_conflict=device_id,conversation_id,event_id,role",{method:"POST",headers:{"Prefer":"return=representation,resolution=ignore-duplicates"},
 body:JSON.stringify([{device_id:device,origin,conversation_id:session,event_id:eventId,role,content:content.slice(0,4000),model}])});
 return (await r.json()).length===1;
}
function isOrigin(v:unknown):v is string{
 try{if(typeof v!=="string"||v.length>300)return false;const u=new URL(v);return(u.protocol==="https:"||u.protocol==="http:")&&u.origin===v;}catch{return false;}
}
Deno.serve(async(req:Request):Promise<Response>=>{
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
 if(req.method==="GET")return out({service:"chatbot-api",active:true});
 if(req.method!=="POST")return out({error:"method_not_allowed"},405);
 const path=new URL(req.url).pathname.replace(/\/+$/,"");
 if(!path.endsWith("/pair")&&!path.endsWith("/reply"))return out({error:"not_found"},404);
 if(Number(req.headers.get("content-length")||0)>16000)return out({error:"payload_too_large"},413);
 let body:Record<string,unknown>;
 try{body=await req.json();if(!body||typeof body!=="object")throw Error();}catch{return out({error:"invalid_json"},400);}
 if(path.endsWith("/pair")){
  if(typeof body.code!=="string"||!/^[A-Za-z0-9_-]{20,100}$/.test(body.code))return out({error:"invalid_pair_code"},400);
  try{
   const token=newToken();
   const deviceId=await rows("rpc/ChatBot_Bridge_redeem",{method:"POST",body:JSON.stringify({
    p_code_hash:await digest(body.code),p_token_hash:await digest(token),
    p_name:typeof body.deviceName==="string"?body.deviceName.slice(0,100):"Chrome"})});
   return deviceId?out({token,deviceId}):out({error:"pair_code_expired_or_used"},403);
  }catch(e){console.error("chatbot_pair_failed",String(e).slice(0,80));return out({error:"pair_unavailable"},503);}
 }
 let device:string|null;
 try{device=await authorize(req);}catch{return out({error:"authentication_unavailable"},503);}
 if(!device)return out({error:"unauthorized"},401);
 if(!isOrigin(body.origin)||typeof body.message!=="string"||!body.message.trim()||body.message.length>2000||
 typeof body.conversationId!=="string"||!/^[A-Za-z0-9_-]{8,100}$/.test(body.conversationId)||
 typeof body.eventId!=="string"||!/^[A-Za-z0-9_-]{8,100}$/.test(body.eventId))
 return out({error:"invalid_message"},400);
 const origin=body.origin,session=await digest(origin+"\n"+body.conversationId),eventId=body.eventId;
 try{
  const done=await lookupReply(device,session,eventId);
  if(done)return out({text:done.content,model:done.model,deduplicated:true});
  await save(device,origin,session,eventId,"user",body.message,"");
  const hist=await getHistory(device,session);
  if(hist.at(-1)?.role==="user"&&hist.at(-1)?.content===body.message)hist.pop();
  const config=await rows("rpc/ChatBot_Line_runtime_secrets",{method:"POST",body:"{}"});
  if(!config?.gemini_api_key)return out({error:"model_not_configured"},503);
  let answer:{text:string;model:string};
  if(needsWebSearch(body.message)){
   const info=await searchWebContext(body.message);
   if(info.status==="location_required")answer={text:"你想查哪個城市的天氣？例如台北、台中或高雄。",model:"weather-location"};
   else if(info.status==="unavailable"&&!info.answer)return out({error:"search_temporarily_unavailable"},503);
   else if(info.status==="unavailable")answer={text:info.answer||"目前查不到這項資訊。",model:"search-unavailable"};
   else answer=await generateGroundedAnswer(config.gemini_api_key,body.message,hist,info);
  }else answer=await generateText(config.gemini_api_key,body.message,hist,await loadKnowledge(body.message));
  await save(device,origin,session,eventId,"model",answer.text,answer.model);
  return out({text:answer.text,model:answer.model});
 }catch(e){console.error("chatbot_bridge_failed",String(e).slice(0,100));return out({error:"generation_unavailable"},503);}
});
