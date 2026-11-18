/** Telegram official Bot API webhook. No browser automation, no polling. */
import {channelReply, safeEqual, json} from "../_shared/channel-engine.ts";
type TelegramEvent={update_id?:number,message?:{message_id?:number,text?:string,chat?:{id?:number;type?:string},message_thread_id?:number;from?:{is_bot?:boolean}}};
Deno.serve(async(request:Request)=>{
  if(request.method==="GET")return json({service:"chatbot-telegram",ready:Boolean(Deno.env.get("CHATBOT_TELEGRAM_TOKEN")&&Deno.env.get("CHATBOT_TELEGRAM_WEBHOOK_SECRET"))});
  if(request.method!=="POST")return json({error:"method_not_allowed"},405);
  const token=Deno.env.get("CHATBOT_TELEGRAM_TOKEN")||"";
  const expected=Deno.env.get("CHATBOT_TELEGRAM_WEBHOOK_SECRET")||"";
  if(!token||!expected)return json({error:"telegram_not_configured"},503);
  if(!safeEqual(request.headers.get("x-telegram-bot-api-secret-token")||"",expected))return json({error:"unauthorized"},401);
  if(Number(request.headers.get("content-length")||0)>16000)return json({error:"too_large"},413);
  let event:TelegramEvent;
  try{event=await request.json();}catch{return json({error:"invalid_json"},400);}
  const msg=event.message,chatId=msg?.chat?.id,raw=String(msg?.text||"").trim();
  if(!Number.isSafeInteger(event.update_id)||!Number.isSafeInteger(chatId)||!Number.isSafeInteger(msg?.message_id))return json({ok:true,ignored:true});
  if(msg?.from?.is_bot||!raw)return json({ok:true,ignored:true});
  // Groups respond only to explicit /ask or /chat; private chats are conversational.
  const isPrivate=msg?.chat?.type==="private";
  if(!isPrivate && !/^\/(?:ask|chat)(?:@\w+)?(?:\s|$)/i.test(raw))return json({ok:true,ignored:true});
  const question=raw.replace(/^\/(?:ask|chat)(?:@\w+)?\s*/i,"").trim();
  if(!question)return json({ok:true,ignored:true});
  try{
    const chatKey=String(chatId)+":"+String(msg?.message_thread_id||0);
    const answer=await channelReply("telegram",chatKey,String(event.update_id),question.slice(0,2000));
    const reply={chat_id:chatId,text:answer.text.slice(0,4000),reply_to_message_id:msg?.message_id,
      ...(msg?.message_thread_id?{message_thread_id:msg.message_thread_id}:{})};
    const response=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(reply),signal:AbortSignal.timeout(10000)
    });
    if(!response.ok){console.error("telegram_send_failed",response.status);return json({error:"telegram_send_failed"},502);}
    return json({ok:true});
  }catch(e){console.error("telegram_processing_error",String(e instanceof Error?e.message:e).slice(0,100));return json({error:"temporary_failure"},503);}
});
