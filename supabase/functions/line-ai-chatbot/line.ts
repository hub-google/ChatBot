import {type LineEvent,type LineReply,type OutboundMessage,type PendingTask,restJson} from "./runtime.ts";

const cachedLineNames=new Map<string,{value:string;until:number}>();
async function lineLabel(key:string,url:string,token:string,property:string,fallback:string):Promise<string>{
  const old=cachedLineNames.get(key);
  if(old && old.until>Date.now())return old.value;
  try{
    const response=await fetch(url,{headers:{"Authorization":"Bearer "+token},signal:AbortSignal.timeout(2200)});
    if(!response.ok)return fallback;
    const obj=await response.json();
    const value=typeof obj?.[property]==="string"?obj[property].slice(0,200):fallback;
    if(cachedLineNames.size>1000)cachedLineNames.clear();
    cachedLineNames.set(key,{value,until:Date.now()+3600000});
    return value;
  }catch{return fallback;}
}
export async function messageIdentity(event:LineEvent,token:string){
  const source=event.source||{};
  const userId=source.userId||"";
  const groupId=source.groupId||"";
  const roomId=source.roomId||"";
  const groupUuid=groupId||roomId||userId||"未知";
  const groupPromise=groupId
    ?lineLabel("group:"+groupId,"https://api.line.me/v2/bot/group/"+encodeURIComponent(groupId)+"/summary",token,"groupName","未知群組")
    :Promise.resolve(roomId?"聊天室":"個人私訊");
  const profileUrl=groupId
    ?"https://api.line.me/v2/bot/group/"+encodeURIComponent(groupId)+"/member/"+encodeURIComponent(userId)
    :roomId?"https://api.line.me/v2/bot/room/"+encodeURIComponent(roomId)+"/member/"+encodeURIComponent(userId)
    :"https://api.line.me/v2/bot/profile/"+encodeURIComponent(userId);
  const senderPromise=userId
    ?lineLabel("profile:"+groupUuid+":"+userId,profileUrl,token,"displayName","未知用戶")
    :Promise.resolve("未知用戶");
  const [groupName,senderName]=await Promise.all([groupPromise,senderPromise]);
  return {groupName,groupUuid,senderName,senderUuid:userId||"未知"};
}
export async function shouldRespond(event:LineEvent,token:string):Promise<boolean>{
  // Only one-to-one conversations reply automatically.
  if(event.source?.type==="user") return true;
  // Group/room messages must explicitly mention THIS bot, not another user
  // or @all. LINE's isSelf is authoritative for bot mentions.
  if(event.source?.type!=="group"&&event.source?.type!=="room") return false;
  if(event.message?.type!=="text") return false;
  const mentions=event.message?.mention?.mentionees;
  if(!Array.isArray(mentions)||mentions.length===0) return false;
  if(mentions.some(m=>m?.type==="user"&&m.isSelf===true)) return true;
  const botUserId=await lineLabel("bot-info","https://api.line.me/v2/bot/info",token,"userId","");
  return Boolean(botUserId&&mentions.some(m=>m?.type==="user"&&m.userId===botUserId));
}

/** Split long text across LINE's five-message reply batch; never silently discard text. */
export function replyMessages(answer:OutboundMessage):LineReply[]{
  const provided:LineReply[]=Array.isArray(answer)?answer:
    [typeof answer==="string"?{type:"text",text:answer}:answer];
  const messages:LineReply[]=[];
  for(const item of provided){
    if(item.type!=="text"){messages.push(item);continue;}
    const body=item.text;
    for(let pos=0;pos<body.length;){
      let end=Math.min(pos+4500,body.length);
      if(end<body.length){
        const newline=body.lastIndexOf("\n",end-1);
        if(newline>pos+2800)end=newline+1;
        else if(/[\uD800-\uDBFF]/.test(body[end-1]))end--;
      }
      messages.push({type:"text",text:body.slice(pos,end)});
      pos=end;
    }
  }
  if(messages.length===0||messages.length>5)
    throw new Error("line_message_count_exceeded");
  return messages;
}
export async function sendReply(token:string,replyToken:string,answer:OutboundMessage):Promise<void> {
  const r=await fetch("https://api.line.me/v2/bot/message/reply",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},
    body:JSON.stringify({replyToken,messages:replyMessages(answer)}),
    signal:AbortSignal.timeout(10000)
  });
  if(!r.ok) throw new Error("line_reply_"+r.status);
}

async function retryKey(eventId:string,revision:number):Promise<string>{
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode("chatbot-line-send:"+eventId+":"+revision)));
  const b=digest.slice(0,16);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
  const h=Array.from(b,v=>v.toString(16).padStart(2,"0")).join("");
  return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20);
}
/** Monthly push is intentionally conservative: never buy overage messages. */
export async function sendFreePush(token:string,task:PendingTask,answer:OutboundMessage):Promise<"sent"|"no_free_quota">{
  const headers={"Authorization":"Bearer "+token};
  const [quotaRes,usedRes]=await Promise.all([
    fetch("https://api.line.me/v2/bot/message/quota",{headers,signal:AbortSignal.timeout(6500)}),
    fetch("https://api.line.me/v2/bot/message/quota/consumption",{headers,signal:AbortSignal.timeout(6500)})
  ]);
  if(!quotaRes.ok||!usedRes.ok)throw new Error("line_quota_lookup_failed");
  const quota=await quotaRes.json(),usage=await usedRes.json();
  const included=Number(quota?.value),consumed=Number(usage?.totalUsage);
  // If quota isn't explicit/limited, never assume the account can push for free.
  if(quota?.type!=="limited"||!Number.isFinite(included)||
     !Number.isFinite(consumed)||consumed>=Math.min(included,190))return "no_free_quota";
  // Reserve atomically for concurrent conversations; conservative double counting
  // against LINE's consumption total prevents accidental paid overages.
  const available=Math.min(included,190)-consumed;
  const reserved=await restJson("rpc/ChatBot_Line_reserve_push",{
    method:"POST",body:JSON.stringify({p_limit:Math.floor(available)})
  });
  if(reserved!==true)return "no_free_quota";
  const r=await fetch("https://api.line.me/v2/bot/message/push",{
    method:"POST",signal:AbortSignal.timeout(10000),
    headers:{"Content-Type":"application/json","Authorization":"Bearer "+token,
      "X-Line-Retry-Key":await retryKey(task.event_id,task.revision)},
    body:JSON.stringify({to:task.target_id,messages:replyMessages(answer)})
  });
  if(!r.ok)throw new Error("line_push_"+r.status);
  return "sent";
}