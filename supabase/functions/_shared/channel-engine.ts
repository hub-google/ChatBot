/** Common AI conversation pipeline for official chat-platform adapters. */
import { generateText, loadKnowledge, generateGroundedAnswer } from "../line-ai-chatbot/generation.ts";
import { needsWebSearch, searchWebContext } from "../line-ai-chatbot/search.ts";
import { getSecrets, rest, restJson } from "../line-ai-chatbot/runtime.ts";

export type Channel = "telegram" | "discord";
export async function chatHash(channel:Channel, conversation:string) {
  const id = channel + ":" + conversation;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return Array.from(new Uint8Array(bytes), n=>n.toString(16).padStart(2,"0")).join("");
}
const table = encodeURIComponent("ChatBot_Channel_messages");
export async function channelReply(channel:Channel, conversation:string, eventId:string, question:string) {
  const hash = await chatHash(channel,conversation);
  const p = "?channel=eq."+channel+"&conversation_hash=eq."+hash+"&event_id=eq."+encodeURIComponent(eventId);
  const existing = await restJson(table+p+"&role=eq.model&select=content,model&limit=1");
  if(existing?.[0])return {text:existing[0].content as string,model:existing[0].model as string,cached:true};
  const historyRows = await restJson(table+"?channel=eq."+channel+"&conversation_hash=eq."+hash+
    "&select=role,content&order=id.desc&limit=20");
  const history = (Array.isArray(historyRows)?historyRows:[]).reverse().map(
    (x:{role:"user"|"model";content:string})=>({role:x.role,content:x.content}));
  // Ignore-duplicates keeps event logging idempotent on HTTP webhook redelivery.
  await rest(table+"?on_conflict=channel,conversation_hash,event_id,role",{
    method:"POST",headers:{"Prefer":"return=minimal,resolution=ignore-duplicates"},
    body:JSON.stringify([{channel,conversation_hash:hash,event_id:eventId,role:"user",content:question.slice(0,2000),model:null}])
  });
  const secrets=await getSecrets();
  if(!secrets.gemini_api_key)throw Error("model_not_configured");
  let answer:{text:string;model:string};
  if(needsWebSearch(question)){
    const lookup=await searchWebContext(question);
    if(lookup.status==="location_required")answer={text:"你想查哪個城市的天氣？例如台北、台中或高雄。",model:"weather-location"};
    else if(lookup.status==="unavailable"&&!lookup.answer)throw Error("search_temporarily_unavailable");
    else if(lookup.status==="unavailable")answer={text:lookup.answer||"目前查不到這項資訊。",model:"search-unavailable"};
    else answer=await generateGroundedAnswer(secrets.gemini_api_key,question,history,lookup);
  }else answer=await generateText(secrets.gemini_api_key,question,history,await loadKnowledge(question));
  await rest(table+"?on_conflict=channel,conversation_hash,event_id,role",{
    method:"POST",headers:{"Prefer":"return=minimal,resolution=ignore-duplicates"},
    body:JSON.stringify([{channel,conversation_hash:hash,event_id:eventId,role:"model",content:answer.text.slice(0,4000),model:answer.model}])
  });
  return {...answer,cached:false};
}
export function safeEqual(a:string,b:string){
  if(!a||!b)return false;
  let mismatch=a.length^b.length;
  for(let i=0;i<Math.max(a.length,b.length);i++)mismatch|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);
  return mismatch===0;
}
export function json(x:unknown,status=200){return new Response(JSON.stringify(x),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});}
