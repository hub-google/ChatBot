import {rest,restJson} from "./runtime.ts";

export async function insertReceipt(eventId:string,userHash:string):Promise<boolean> {
  const response=await rest("ChatBot_Line_events?on_conflict=event_id",{
    method:"POST",
    headers:{"Prefer":"return=representation,resolution=ignore-duplicates"},
    body:JSON.stringify([{event_id:eventId.slice(0,160),user_hash:userHash}])
  });
  const rows=await response.json();
  return Array.isArray(rows) && rows.length === 1;
}
export async function markReceipt(eventId:string,status:"completed"|"failed",err:string|null=null):Promise<void> {
  await rest("ChatBot_Line_events?event_id=eq."+encodeURIComponent(eventId.slice(0,160)),{
    method:"PATCH",
    headers:{"Prefer":"return=minimal"},
    body:JSON.stringify({status,completed_at:new Date().toISOString(),error_code:err})
  });
}

type ChatMeta={groupName:string;groupUuid:string;senderName:string;senderUuid:string;messageTime:string;aiModel:string};
export async function insertChat(hash:string,role:"user"|"model",content:string,meta:ChatMeta):Promise<number>{
  const response=await rest(encodeURIComponent("ChatBot_Line_對話紀錄"),{
    method:"POST",headers:{"Prefer":"return=representation"},
    body:JSON.stringify({
      user_hash:hash,role,"對話內容":content.slice(0,4000),
      "對話時間":meta.messageTime,"群組名稱":meta.groupName,"群組 UUID":meta.groupUuid,
      "發送者暱稱":meta.senderName,"發送者 UUID":meta.senderUuid,"AI 模型":meta.aiModel
    })
  });
  const rows=await response.json();
  const id=Number(rows?.[0]?.id);
  if(!Number.isSafeInteger(id)||id<=0)throw new Error("chat_insert_missing_id");
  return id;
}

export async function fetchHistory(userHash:string):Promise<{role:"user"|"model";content:string}[]> {
  const path=encodeURIComponent("ChatBot_Line_對話紀錄")+"?user_hash=eq."+userHash+"&select=role,"+encodeURIComponent("對話內容")+"&order=id.desc&limit=20";
  const rows=await restJson(path);
  return (Array.isArray(rows)?rows:[]).reverse().map(r=>({role:r.role,content:r["對話內容"]}));
}
export async function countUserMessages(userHash:string,since:string,max:number):Promise<number> {
  const path=encodeURIComponent("ChatBot_Line_對話紀錄")+"?select=id&user_hash=eq."+userHash+"&role=eq.user&created_at=gte."+encodeURIComponent(since)+"&limit="+(max+1);
  const rows=await restJson(path);
  return Array.isArray(rows)?rows.length:0;
}
export async function countGlobalReplies(since:string,max:number):Promise<number> {
  const path=encodeURIComponent("ChatBot_Line_對話紀錄")+"?select=id&role=eq.model&created_at=gte."+encodeURIComponent(since)+"&limit="+(max+1);
  const rows=await restJson(path);
  return Array.isArray(rows)?rows.length:0;
}

export async function cleanupExpired():Promise<void>{
  // Keep conversations, as the original Google Sheet did. Only prune event receipts.
  if(Math.random()>=0.001)return;
  try{await rest("ChatBot_Line_events?received_at=lt."+encodeURIComponent(new Date(Date.now()-7*86400000).toISOString()),{method:"DELETE"});}
  catch{/* best effort */}
}

export async function latestQuestion(id:number):Promise<string>{
  const path=encodeURIComponent("ChatBot_Line_對話紀錄")+
    "?id=eq."+id+"&select="+encodeURIComponent("對話內容")+"&limit=1";
  const rows=await restJson(path);
  return String(rows?.[0]?.["對話內容"]||"").slice(0,2000).trim();
}