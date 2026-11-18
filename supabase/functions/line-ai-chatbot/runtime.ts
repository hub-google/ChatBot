export type BotSecrets = {gemini_api_key:string|null;line_channel_secret:string|null;line_access_token:string|null};
export type LineEvent = {type?:string;webhookEventId?:string;replyToken?:string;source?:{type?:string;userId?:string;groupId?:string;roomId?:string};message?:{type?:string;text?:string;mention?:{mentionees?:Array<{type?:string;userId?:string;isSelf?:boolean}>}};timestamp?:number;deliveryContext?:{isRedelivery?:boolean}};
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void } | undefined;

export const PROJECT_URL = Deno.env.get("SUPABASE_URL") || "";
export const MODELS = ["gemma-4-26b-a4b-it", "gemma-4-31b-it"] as const;
export const VOICE_TAG="#說話";
export const IMAGE_TAG="#圖片";
export const VOICE_QUOTA_TEXT="沒有Token說話了，只能打字回覆你啦。";
const DEFAULT_KNOWLEDGE_INDEX = "https://raw.githubusercontent.com/hub-google/ChatBot/main/Data/index.json";
export const KNOWLEDGE_INDEX = Deno.env.get("LINE_AI_KNOWLEDGE_INDEX") || DEFAULT_KNOWLEDGE_INDEX;
const textHeaders = {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"};
export const adminKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  (() => { try { return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || ""; } catch { return ""; } })();
const authHeaders:Record<string,string> = {"apikey":adminKey,"Content-Type":"application/json"};
if (adminKey && !adminKey.startsWith("sb_secret_")) authHeaders.Authorization = "Bearer " + adminKey;

export function replyJson(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:textHeaders});}
export function later(p:Promise<unknown>) {
  if(typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
    EdgeRuntime.waitUntil(p);
    return true;
  }
  return false;
}
export async function rest(path:string, options:RequestInit={}): Promise<Response> {
  if (!adminKey || !PROJECT_URL) throw new Error("database_not_configured");
  const res = await fetch(PROJECT_URL + "/rest/v1/" + path, {
    ...options,
    headers: {...authHeaders,...(options.headers as Record<string,string> || {})},
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error("database_" + res.status);
  return res;
}
export async function restJson(path:string, options:RequestInit={}) {
  return (await rest(path,options)).json();
}
export async function getSecrets(): Promise<BotSecrets> {
  return await restJson("rpc/ChatBot_Line_runtime_secrets", {method:"POST",body:"{}"});
}
export async function digestId(secret:string,id:string):Promise<string> {
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const hash=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode("line-ai-user-v1:"+id));
  return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
export async function verifyLine(secret:string, raw:string, signature:string|null):Promise<boolean> {
  if(!signature) return false;
  let signatureBytes:Uint8Array;
  try { signatureBytes=Uint8Array.from(atob(signature),c=>c.charCodeAt(0)); } catch { return false; }
  if(signatureBytes.length!==32) return false;
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
  return crypto.subtle.verify("HMAC",key,signatureBytes,new TextEncoder().encode(raw));
}

export type LineReply={type:"text";text:string}|{type:"audio";originalContentUrl:string;duration:number}|{type:"image";originalContentUrl:string;previewImageUrl:string};

export type PendingTask={
  user_hash:string; revision:number; event_id:string; latest_message_id:number;
  reply_token:string; target_id:string; target_type:"user"|"group"|"room";
  queued_at:string; attempts:number; status:string; lease_id:string;
};

export function safeEqual(a:string,b:string):boolean{
  const enc=new TextEncoder(),x=enc.encode(a),y=enc.encode(b);
  let diff=x.length^y.length;
  for(let i=0;i<Math.max(x.length,y.length);i++)diff|=(x[i]||0)^(y[i]||0);
  return diff===0;
}