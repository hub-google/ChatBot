import {type BotSecrets,type LineEvent,type PendingTask,type LineReply,type OutboundMessage,PROJECT_URL,adminKey,IMAGE_TAG,VOICE_QUOTA_TEXT,later,rest,restJson,digestId} from "./runtime.ts";
import {insertReceipt,markReceipt,insertChat,fetchHistory,cleanupExpired,latestQuestion} from "./messages.ts";
import {sendReply,sendFreePush,shouldRespond,messageIdentity} from "./line.ts";
import {generateText,loadKnowledge,generateGroundedAnswer} from "./generation.ts";
import {needsWebSearch,searchWebContext} from "./search.ts";
import {makeVoiceAnswer,VoiceError,cleanupOldVoiceFiles,parseVoiceCommand} from "./voice.ts";
import {makeImageAnswer,ImageError,cleanupOldImageFiles} from "./image.ts";

/**
 * One pending row per conversation. Every new incoming text bumps revision.
 * Database conditional transitions are the concurrency boundary: an answer
 * produced for a superseded revision must never enter the send path.
 */
const PENDING_TABLE=encodeURIComponent("ChatBot_Line_pending");
const RETRY_DELAYS_MS=[2000,4000,8000,15000,30000];
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const retryDelay=(attempt:number)=>RETRY_DELAYS_MS[Math.min(Math.max(attempt-1,0),RETRY_DELAYS_MS.length-1)];
function taskFilter(task:PendingTask,status:string):string{
  return PENDING_TABLE+"?user_hash=eq."+encodeURIComponent(task.user_hash)+
    "&revision=eq."+task.revision+"&lease_id=eq."+encodeURIComponent(task.lease_id)+
    "&status=eq."+status;
}
async function changeTask(task:PendingTask,from:string,patch:Record<string,unknown>):Promise<boolean>{
  const r=await rest(taskFilter(task,from),{
    method:"PATCH",headers:{"Prefer":"return=representation"},
    body:JSON.stringify({...patch,updated_at:new Date().toISOString()})
  });
  const rows=await r.json();
  return Array.isArray(rows)&&rows.length===1;
}
async function enqueueTask(hash:string,eventId:string,messageId:number,eventAt:string,
                           replyToken:string,targetId:string,targetType:string):Promise<void>{
  await restJson("rpc/ChatBot_Line_enqueue",{
    method:"POST",body:JSON.stringify({
      p_user_hash:hash,p_event_id:eventId,p_message_id:messageId,
      p_event_at:eventAt,p_reply_token:replyToken,
      p_target_id:targetId,p_target_type:targetType
    })
  });
}
async function claimTasks(hash:string|null,limit:number):Promise<PendingTask[]>{
  const rows=await restJson("rpc/ChatBot_Line_claim",{
    method:"POST",body:JSON.stringify({p_user_hash:hash,p_limit:limit})
  });
  return Array.isArray(rows)?rows:[];
}
async function reschedule(task:PendingTask,delayMs:number,code:string):Promise<void>{
  await changeTask(task,"processing",{
    status:"pending",attempts:task.attempts+1,
    next_retry_at:new Date(Date.now()+delayMs).toISOString(),
    lease_id:null,leased_until:null,error_code:code.slice(0,100)
  });
}
async function rescheduleSending(task:PendingTask,delayMs:number,code:string):Promise<void>{
  await changeTask(task,"sending",{
    status:"pending",attempts:task.attempts+1,
    next_retry_at:new Date(Date.now()+delayMs).toISOString(),
    lease_id:null,leased_until:null,error_code:code.slice(0,100)
  });
}
async function processClaimed(task:PendingTask,secrets:BotSecrets):Promise<number|null>{
  const originalQuestion=await latestQuestion(task.latest_message_id);
  const imageRequested=originalQuestion.includes(IMAGE_TAG);
  const voiceCommand=parseVoiceCommand(originalQuestion);
  const voiceRequested=!imageRequested&&voiceCommand.requested;
  const question=imageRequested
    ?(voiceCommand.text.replaceAll(IMAGE_TAG,"").trim()||"一張可愛的插畫")
    :voiceRequested
      ?(voiceCommand.text||"和我聊幾句")
      :originalQuestion;
  if(!question){
    await reschedule(task,3600000,"empty_or_missing_question");
    return null;
  }
  const hist=await fetchHistory(task.user_hash);
  // The newest text is already in the persisted history. Don't send it twice.
  if(hist.length&&hist[hist.length-1].role==="user"&&hist[hist.length-1].content===originalQuestion)hist.pop();
  let response:{text:string;model:string};
  let picture:{originalContentUrl:string;previewImageUrl:string}|null=null;
  try{
    if(imageRequested){
      const generated=await makeImageAnswer(secrets.gemini_api_key!,PROJECT_URL,adminKey,question);
      picture={originalContentUrl:generated.originalContentUrl,previewImageUrl:generated.previewImageUrl};
      response={text:"【已產生圖片】"+question,model:generated.model};
      if(Math.random()<0.05)later(cleanupOldImageFiles(PROJECT_URL,adminKey));
    }else{
      if(needsWebSearch(question)){
        const lookup=await searchWebContext(question);
        if(lookup.status==="location_required"){
          response={text:"你想查哪個城市的天氣？例如台北、台中或高雄。",model:"Web Search：待指定地點"};
        }else if(lookup.status==="unavailable"&&!lookup.answer){
          // Transient external network failure: keep the existing durable task and retry.
          // Never tell a LINE user that an API timeout is a permanent inability to search.
          const delay=retryDelay(task.attempts+1);
          await reschedule(task,delay,lookup.kind==="weather"?"weather_sources_unavailable":"web_sources_unavailable");
          console.warn("chatbot_web_retry",lookup.kind,"attempt",task.attempts+1);
          return delay;
        }else if(lookup.status==="unavailable"){
          // Unsupported historical data; no fabricated lookup result.
          response={text:lookup.answer!,model:"Web Search：歷史資料不支援"};
        }else{
          response=await generateGroundedAnswer(secrets.gemini_api_key!,question,hist,lookup);
        }
      }else{
        response=await generateText(secrets.gemini_api_key!,question,hist,await loadKnowledge(question));
      }
    }
  }catch(e){
    if(imageRequested){
      const isQuota=e instanceof ImageError&&e.reason==="quota";
      response={text:isQuota?"Gemini 產圖額度不足，這次無法產圖。":"Gemini 產圖暫時失敗，請稍後再試。",
        model:isQuota?"Gemini Image：配額不足":"Gemini Image：產圖失敗"};
      console.warn("chatbot_image_fallback",e instanceof Error?e.message:"image_error");
    }else{
      const code=String(e instanceof Error?e.message:"model_error").slice(0,80);
      const delay=code==="gemma_403"?3600000:code==="gemma_429"?120000:retryDelay(task.attempts+1);
      await reschedule(task,delay,code);
      console.warn("chatbot_model_retry",code,"attempt",task.attempts+1);
      return delay;
    }
  }
  // Critical latest-wins check: an older revision cannot transition to sending.
  if(!(await changeTask(task,"processing",{status:"sending"})))return null;
  let delivery:"sent"|"no_free_quota"="no_free_quota";
  let outbound:OutboundMessage=picture
    ?{type:"image",originalContentUrl:picture.originalContentUrl,previewImageUrl:picture.previewImageUrl}
    :response.text;
  let voiceModel="";
  if(voiceRequested){
    try{
      // Speak only the conversational answer; follow it with citations as text.
      const citationAt=response.text.indexOf("\n\n來源：");
      const spoken=citationAt>=0?response.text.slice(0,citationAt):response.text;
      const audio=await makeVoiceAnswer(secrets.gemini_api_key!,PROJECT_URL,adminKey,spoken,voiceCommand.voiceName);
      const audioMessage={type:"audio" as const,originalContentUrl:audio.originalContentUrl,duration:audio.duration};
      outbound=citationAt>=0?[audioMessage,{type:"text",text:response.text.slice(citationAt+2)}]:audioMessage;
      voiceModel=" | TTS:"+audio.voiceName;
      // Small, best-effort storage cleanup; never interrupt an actual reply.
      if(Math.random()<0.05)later(cleanupOldVoiceFiles(PROJECT_URL,adminKey));
    }catch(e){
      const isQuota=e instanceof VoiceError && e.reason==="quota";
      outbound=(isQuota?VOICE_QUOTA_TEXT:"語音暫時無法送出，先用文字回覆你：")+
        "\n"+response.text;
      console.warn("chatbot_voice_fallback",e instanceof Error?e.message:"voice_error");
    }
  }
  const token=secrets.line_access_token!;
  const canReply=Date.now()-Date.parse(task.queued_at)<40000;
  if(canReply){
    try{
      await sendReply(token,task.reply_token,outbound);
      delivery="sent";
    }catch(e){
      const code=String(e instanceof Error?e.message:"line_reply_error");
      if(code!=="line_reply_400"){
        // A timeout/5xx is ambiguous: never risk sending a duplicate via push.
        console.error("chatbot_delivery_uncertain",code);
        await changeTask(task,"sending",{status:"uncertain",error_code:code});
        return null;
      }
    }
  }
  if(delivery!=="sent"){
    try{
      delivery=await sendFreePush(token,task,outbound);
    }catch(e){
      const code=String(e instanceof Error?e.message:"line_push_error");
      // Stable LINE retry key prevents duplicates if the push result was unknown.
      console.warn("chatbot_push_retry",code);
      await rescheduleSending(task,code==="line_push_429"?3600000:30000,code);
      return null;
    }
  }
  if(delivery==="no_free_quota"){
    await rescheduleSending(task,6*3600000,"line_push_free_quota_exhausted");
    return null;
  }
  // Mark delivery before writing the transcript: a logging failure must not
  // resend an already-delivered LINE response.
  if(!(await changeTask(task,"sending",{status:"sent",sent_at:new Date().toISOString(),
    error_code:null,lease_id:null,leased_until:null})))return null;
  try{
    const orig=await restJson(encodeURIComponent("ChatBot_Line_對話紀錄")+
      "?id=eq."+task.latest_message_id+"&select="+
      ["群組名稱","群組 UUID","發送者暱稱","發送者 UUID"].map(encodeURIComponent).join(",")+"&limit=1");
    const x=orig?.[0]||{};
    await insertChat(task.user_hash,"model",typeof outbound==="string"?outbound:response.text,{
      groupName:x["群組名稱"]||"",groupUuid:x["群組 UUID"]||"",
      senderName:"BOT回應"+(x["發送者暱稱"]||""),
      senderUuid:"BOT回應"+(x["發送者 UUID"]||""),
      messageTime:new Date().toISOString(),aiModel:response.model+voiceModel
    });
  }catch(e){console.error("chatbot_sent_log_failed",String(e).slice(0,120));}
  return null;
}
async function processConversation(hash:string,secrets:BotSecrets,fast:boolean):Promise<void>{
  const started=Date.now();
  for(let round=0;round<(fast?4:1);round++){
    if(Date.now()-started>43000)break;
    const claimed=await claimTasks(hash,1);
    const task=claimed[0];
    if(!task)break;
    const delay=await processClaimed(task,secrets);
    if(delay===null||!fast||delay>15000||Date.now()-started+delay>44000)break;
    await sleep(delay);
  }
}
export async function processCron(secrets:BotSecrets):Promise<void>{
  const claimed=await claimTasks(null,4);
  await Promise.allSettled(claimed.map(t=>processClaimed(t,secrets))).then(results=>{
    for(const x of results)if(x.status==="rejected")
      console.error("chatbot_worker_task_failed",String(x.reason).slice(0,150));
  });
}
export async function processEvent(event:LineEvent,secrets:BotSecrets):Promise<void>{
  if(event.type!=="message"||!event.replyToken)return;
  const conversationId=event.source?.groupId||event.source?.roomId||event.source?.userId;
  const eventId=event.webhookEventId||event.replyToken;
  if(!conversationId||!eventId||!secrets.line_channel_secret||!secrets.line_access_token||
     !secrets.gemini_api_key)return;
  const hash=await digestId(secrets.line_channel_secret,conversationId);
  if(!(await insertReceipt(eventId,hash)))return;
  let completed=false,error:string|null=null;
  try{
    const identity=await messageIdentity(event,secrets.line_access_token);
    const messageType=event.message?.type||"unknown";
    const originalText=messageType==="text"?(event.message?.text||""):"["+messageType+" 訊息]";
    const eventAt=typeof event.timestamp==="number"&&Number.isFinite(event.timestamp)
      ?new Date(event.timestamp).toISOString():new Date().toISOString();
    const messageId=await insertChat(hash,"user",originalText||"[空訊息]",{
      ...identity,messageTime:eventAt,aiModel:""
    });
    if(!(await shouldRespond(event,secrets.line_access_token))||messageType!=="text"||
       !originalText.trim()){completed=true;return;}
    await enqueueTask(hash,eventId,messageId,eventAt,event.replyToken,
      conversationId,event.source?.type||"user");
    completed=true; // Already saved durably; retries are independent of webhook receipt.
    await processConversation(hash,secrets,true);
  }catch(e){
    error=String(e instanceof Error?e.message:"unexpected_error").slice(0,100);
    console.error("chatbot_webhook_task_error",error);
  }finally{
    try{await markReceipt(eventId,completed?"completed":"failed",error);}
    catch(e){console.error("chatbot_receipt_update_failed",String(e).slice(0,100));}
    await cleanupExpired();
  }
}
