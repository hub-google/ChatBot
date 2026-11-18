/**
 * ChatBot LINE webhook entrypoint.
 * Auth and request dispatch only. Domain logic lives in dedicated modules:
 * runtime, messages, line, generation, search, tasks, voice, image.
 */
import {type BotSecrets,type LineEvent,MODELS,BACKUP_MODELS,replyJson,later,restJson,getSecrets,safeEqual,verifyLine} from "./runtime.ts";
import {processCron,processEvent} from "./tasks.ts";
import {needsWebSearch,searchWebContext,lookupWeather} from "./search.ts";
import {generateGroundedAnswer} from "./generation.ts";

Deno.serve(async(request:Request):Promise<Response>=>{
  if(request.method==="GET"){
    // Authenticated, read-only diagnostic: exercises the same search router as LINE
    // without creating a chat record, consuming Gemini tokens, or sending a LINE reply.
    const probe=new URL(request.url).searchParams.get("weather_probe");
    if(probe!==null){
      if(probe.length>120||!/(?:天氣|氣溫|下雨)/.test(probe))
        return replyJson({error:"invalid_probe"},400);
      try{
        const provided=request.headers.get("x-chatbot-worker")||"";
        const allowed=String(await restJson("rpc/ChatBot_Line_scheduler_secret",{method:"POST",body:"{}"})||"");
        if(!provided||!allowed||!safeEqual(provided,allowed))
          return replyJson({error:"forbidden"},403);
        const routed=needsWebSearch(probe);
        const lookup=routed?(new URL(request.url).searchParams.get("provider")==="backup"?await lookupWeather(probe,"backup"):await searchWebContext(probe)):null;
        const render=new URL(request.url).searchParams.get("render")==="1";
        let rendered:string|null=null;
        if(render&&lookup?.status==="ok"){
          const secrets=await getSecrets();
          if(!secrets.gemini_api_key)return replyJson({error:"model_not_configured"},503);
          const reply=await generateGroundedAnswer(secrets.gemini_api_key,probe,[],lookup);
          rendered=reply.text;
        }
        return replyJson({routed,kind:lookup?.kind||null,status:lookup?.status||null,
          provider:lookup?.provider||null,answer:lookup?.answer||null,rendered,
          has_sources:Boolean(lookup?.sources.length)});
      }catch{
        return replyJson({error:"probe_unavailable"},503);
      }
    }
    let configured=false;
    try{
      const x=await getSecrets();
      configured=Boolean(x.gemini_api_key&&x.line_access_token&&x.line_channel_secret);
    }catch{/* keep diagnostics private */}
    return replyJson({service:"line-ai-chatbot",models:MODELS,backup_models:BACKUP_MODELS,deployed:true,configured});
  }
  if(request.method!=="POST")return replyJson({error:"method_not_allowed"},405);
  const workerHeader=request.headers.get("x-chatbot-worker");
  if(workerHeader!==null){
    try{
      const allowed=String(await restJson("rpc/ChatBot_Line_scheduler_secret",
        {method:"POST",body:"{}"})||"");
      if(!allowed||!safeEqual(workerHeader,allowed))return replyJson({error:"forbidden"},403);
      const secrets=await getSecrets();
      if(!secrets.gemini_api_key||!secrets.line_access_token)return replyJson({error:"not_configured"},503);
      const job=processCron(secrets);
      if(later(job))return replyJson({ok:true,worker:true});
      await job;
      return replyJson({ok:true,worker:true});
    }catch(e){
      console.error("chatbot_worker_failed",String(e).slice(0,150));
      return replyJson({error:"worker_unavailable"},503);
    }
  }
  if(Number(request.headers.get("content-length")||0)>200000)return replyJson({error:"too_large"},413);
  if((request.headers.get("content-type")||"").split(";")[0].trim()!=="application/json")
    return replyJson({error:"content_type"},415);
  let secrets:BotSecrets;
  try{secrets=await getSecrets();}catch{return replyJson({error:"not_ready"},503);}
  if(!secrets.line_channel_secret||!secrets.line_access_token||!secrets.gemini_api_key)
    return replyJson({error:"not_configured"},503);
  let raw="";
  try{raw=await request.text();}catch{return replyJson({error:"bad_request"},400);}
  if(raw.length>200000)return replyJson({error:"too_large"},413);
  if(!(await verifyLine(secrets.line_channel_secret,raw,request.headers.get("x-line-signature"))))
    return replyJson({error:"invalid_signature"},401);
  let payload:{events?:LineEvent[]};
  try{payload=JSON.parse(raw);}catch{return replyJson({error:"bad_json"},400);}
  if(!Array.isArray(payload.events))return replyJson({error:"missing_events"},400);
  if(payload.events.length===0)return replyJson({ok:true});
  const events=payload.events.slice(0,30);
  const job=Promise.allSettled(events.map(e=>processEvent(e,secrets))).then(results=>{
    for(const x of results)if(x.status==="rejected")
      console.error("chatbot_event_unhandled",String(x.reason).slice(0,150));
  });
  if(later(job))return replyJson({ok:true,queued:events.length});
  await job;
  return replyJson({ok:true,processed:events.length});
});
