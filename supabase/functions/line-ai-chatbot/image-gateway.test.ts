import {generateViaChatGPT2API,ImageError} from "./image.ts";

function check(value:unknown,message:string):asserts value {
  if(!value)throw new Error(message);
}
const img=new Uint8Array(120);
img.set([137,80,78,71,13,10,26,10]);
const IMAGE_B64=btoa(String.fromCharCode(...img));

Deno.test("ChatGPT2API image: HTTPS and bearer auth, valid image payload",async()=>{
  const previousFetch=globalThis.fetch;
  const oldUrl=Deno.env.get("CHATGPT2API_URL");
  const oldKey=Deno.env.get("CHATGPT2API_API_KEY");
  const oldModel=Deno.env.get("CHATGPT2API_IMAGE_MODEL");
  try{
    Deno.env.set("CHATGPT2API_URL","https://example.com");
    Deno.env.set("CHATGPT2API_API_KEY","test-only");
    Deno.env.set("CHATGPT2API_IMAGE_MODEL","gpt-image-2.6");
    globalThis.fetch=async (input,options)=>{
      check(String(input)==="https://example.com/v1/images/generations","exact API path");
      check(new Headers(options?.headers).get("Authorization")==="Bearer test-only","bearer token");
      const body=JSON.parse(String(options?.body));
      check(body.model==="gpt-image-2.6"&&body.n===1&&body.response_format==="b64_json","model and image contract");
      return new Response(JSON.stringify({data:[{b64_json:IMAGE_B64}]}),{status:200,headers:{"Content-Type":"application/json"}});
    };
    const result=await generateViaChatGPT2API("白貓");
    check(result.mime==="image/png"&&result.bytes.length===120,"PNG image accepted");
  }finally{
    globalThis.fetch=previousFetch;
    if(oldUrl===undefined)Deno.env.delete("CHATGPT2API_URL");else Deno.env.set("CHATGPT2API_URL",oldUrl);
    if(oldKey===undefined)Deno.env.delete("CHATGPT2API_API_KEY");else Deno.env.set("CHATGPT2API_API_KEY",oldKey);
    if(oldModel===undefined)Deno.env.delete("CHATGPT2API_IMAGE_MODEL");else Deno.env.set("CHATGPT2API_IMAGE_MODEL",oldModel);
  }
});

Deno.test("ChatGPT2API image: rejects HTTP, never requests insecure endpoints",async()=>{
  const oldUrl=Deno.env.get("CHATGPT2API_URL");
  const oldKey=Deno.env.get("CHATGPT2API_API_KEY");
  try{
    Deno.env.set("CHATGPT2API_URL","http://untrusted.example");
    Deno.env.set("CHATGPT2API_API_KEY","test-only");
    let rejected=false;
    try{await generateViaChatGPT2API("圖");}catch(err){
      rejected=err instanceof ImageError && err.message==="chatgpt2api_invalid_https_url";
    }
    check(rejected,"must reject plain HTTP before sending bearer credentials");
  }finally{
    if(oldUrl===undefined)Deno.env.delete("CHATGPT2API_URL");else Deno.env.set("CHATGPT2API_URL",oldUrl);
    if(oldKey===undefined)Deno.env.delete("CHATGPT2API_API_KEY");else Deno.env.set("CHATGPT2API_API_KEY",oldKey);
  }
});

Deno.test("ChatGPT2API image: quota failure remains quota failure",async()=>{
  const oldUrl=Deno.env.get("CHATGPT2API_URL");
  const oldKey=Deno.env.get("CHATGPT2API_API_KEY");
  const oldFetch=globalThis.fetch;
  try{
    Deno.env.set("CHATGPT2API_URL","https://example.com");
    Deno.env.set("CHATGPT2API_API_KEY","test-only");
    globalThis.fetch=async ()=>new Response("rate limited",{status:429});
    let quota=false;
    try{await generateViaChatGPT2API("圖");}catch(err){quota=err instanceof ImageError && err.reason==="quota";}
    check(quota,"429 must not trigger a paid API fallback");
  }finally{
    globalThis.fetch=oldFetch;
    if(oldUrl===undefined)Deno.env.delete("CHATGPT2API_URL");else Deno.env.set("CHATGPT2API_URL",oldUrl);
    if(oldKey===undefined)Deno.env.delete("CHATGPT2API_API_KEY");else Deno.env.set("CHATGPT2API_API_KEY",oldKey);
  }
});
