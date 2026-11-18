/**
 * Free, no API-key web lookup for LINE ChatBot.
 * Search: Bing RSS, Google News RSS, Wikimedia fallback. Weather: Open-Meteo.
 * Best-effort public endpoints: no paid quota, no guarantee of uptime.
 * External content is untrusted and may not issue instructions to the model.
 */
export type SearchSource={title:string;url:string;snippet:string;published?:string};
export type WebLookup={kind:"weather"|"web";context:string;sources:SearchSource[];status:"ok"|"unavailable"|"location_required";answer?:string};
const cache=new Map<string,{until:number;value:WebLookup}>();
const LIVE_TIME=/(?:今天|今日|現在|目前|最新|即時|剛剛|剛才|最近|近期|昨天|昨日|明天|後天|大後天|本週|這週|本月|今年|今年度|此刻|剛發生|剛公布)/;
const LIVE_TOPIC=/(?:天氣|氣溫|溫度|下雨|降雨|新聞|消息|快訊|股價|股市|匯率|幣價|行情|報價|價格|油價|地震|颱風|台風|選舉|民調|比分|賽程|戰績|停班停課|開盤|收盤|公告|票房|航班|班次|空氣品質|PM2\.?5|運勢|幾點|幾度)/i;
const QUESTION=/(?:[?？]|嗎|呢|什麼|甚麼|誰|哪|幾|多少|如何|怎樣|怎麼|告訴我|查|看一下|看下|給我|有沒有|是否|會不會|狀況|情況|結果)/;
const WEATHER=/(?:天氣|氣溫|溫度|降雨|下雨|幾度|會不會下雨)/;
const NEWS=/(?:新聞|消息|快訊|頭條|發生什麼|發生甚麼|最新動態|最新消息)/;
const CITIES:{[key:string]:[number,number,string]}={
 "台北":[25.033,121.565,"台北"],"臺北":[25.033,121.565,"台北"],"新北":[25.014,121.465,"新北"],
 "桃園":[24.993,121.301,"桃園"],"台中":[24.147,120.673,"台中"],"臺中":[24.147,120.673,"台中"],
 "台南":[22.997,120.213,"台南"],"臺南":[22.997,120.213,"台南"],"高雄":[22.627,120.301,"高雄"],
 "基隆":[25.128,121.741,"基隆"],"新竹":[24.804,120.972,"新竹"],"宜蘭":[24.757,121.753,"宜蘭"],
 "花蓮":[23.987,121.601,"花蓮"],"台東":[22.755,121.144,"台東"],"臺東":[22.755,121.144,"台東"],
 "嘉義":[23.480,120.449,"嘉義"],"苗栗":[24.560,120.822,"苗栗"],"彰化":[24.075,120.541,"彰化"],
 "南投":[23.914,120.685,"南投"],"雲林":[23.708,120.543,"雲林"],"屏東":[22.676,120.494,"屏東"],
 "澎湖":[23.571,119.579,"澎湖"],"金門":[24.437,118.318,"金門"],"馬祖":[26.161,119.950,"馬祖"],
};
export function needsWebSearch(text:string):boolean{
 const q=text.trim();
 if(!q) return false;
 if(/#(?:搜尋|查詢|上網)\b/u.test(q)||q.includes("#搜尋")||q.includes("#查詢"))return true;
 if(WEATHER.test(q) && (QUESTION.test(q)||LIVE_TIME.test(q)))return true;
 if(NEWS.test(q) && (QUESTION.test(q)||LIVE_TIME.test(q)))return true;
 if(LIVE_TOPIC.test(q)&&QUESTION.test(q))return true;
 if(LIVE_TIME.test(q)&&QUESTION.test(q))return true;
 return false;
}
export function cleanupSearchQuery(text:string):string{
 return text.replace(/#(?:搜尋|查詢|上網)/gu,"").trim().slice(0,160);
}
const BAD_URL=/^(?:javascript|data|file|ftp):/i;
function safeLink(raw:string):string{
 try{const u=new URL(raw.trim());return (u.protocol==="https:"&&!BAD_URL.test(raw))?u.href:"";}catch{return "";}
}
function decodeXml(text:string):string{
 return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1")
  .replace(/&(?:amp|lt|gt|quot|apos|#(\d+)|#x([a-f\d]+));/gi,(match,dec,hex)=>{
   if(dec||hex){const cp=parseInt(dec||hex,hex?16:10);return cp>0&&cp<=0x10ffff?String.fromCodePoint(cp):"";}
   return ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"})[match.toLowerCase()]||match;
  });
}
function xmlValue(item:string,name:string):string{
 const m=item.match(new RegExp("<"+name+"(?:\\s[^>]*)?>([\\s\\S]*?)<\\/"+name+">","i"));
 return m?decodeXml(m[1]).replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim():"";
}
export function parseRss(xml:string,max=5):SearchSource[]{
 if(!/<rss[\s>]|<feed[\s>]/i.test(xml))return [];
 const items=xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)||[];
 const out:SearchSource[]=[];
 for(const item of items){
  const title=xmlValue(item,"title").slice(0,140);
  const url=safeLink(xmlValue(item,"link"));
  const snippet=xmlValue(item,"description").slice(0,360);
  const published=xmlValue(item,"pubDate").slice(0,70);
  if(!url||!title||out.some(s=>s.url===url))continue;
  out.push({title,url,snippet,published});
  if(out.length>=max)break;
 }
 return out;
}
async function getText(url:string,ms=3900):Promise<string>{
 const response=await fetch(url,{headers:{"Accept":"application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5","User-Agent":"Mozilla/5.0 (compatible; LINEChatBot/1.0)"},signal:AbortSignal.timeout(ms)});
 if(!response.ok)throw new Error("search_http_"+response.status);
 const type=response.headers.get("content-type")||"";
 if(type.includes("text/html"))throw new Error("search_html_not_rss");
 const body=await response.text();
 if(body.length>850000)throw new Error("search_feed_too_large");
 return body;
}
async function rssLookup(url:string):Promise<SearchSource[]>{
 try{return parseRss(await getText(url),5);}catch{return [];}
}
const weatherDescription=(n:number):string=>{
 if(n===0)return "晴朗";
 if(n<=3)return "晴時多雲";
 if(n<=48)return "霧";
 if(n<=57)return "毛毛雨";
 if(n<=67)return "降雨";
 if(n<=77)return "降雪";
 if(n<=82)return "陣雨";
 if(n<=86)return "陣雪";
 if(n<=99)return "雷雨";
 return "未知";
};
function cityFromQuestion(question:string):[number,number,string]|null{
 const q=question.replace(/台北市|臺北市/g,"台北").replace(/臺灣/g,"台灣");
 for(const name of Object.keys(CITIES).sort((a,b)=>b.length-a.length)){
  if(q.includes(name))return CITIES[name];
 }
 return null;
}
function requestedForecastDay(question:string):{offset:number;label:string}|null{
 if(/(?:前天|昨天|昨日)/.test(question))return null;
 if(question.includes("大後天"))return {offset:3,label:"大後天"};
 if(question.includes("後天"))return {offset:2,label:"後天"};
 if(question.includes("明天"))return {offset:1,label:"明天"};
 return {offset:0,label:"今天"};
}
function weatherNumber(value:unknown,suffix:string):string{
 return typeof value==="number"&&Number.isFinite(value)?value+suffix:"未提供";
}
export async function lookupWeather(question:string):Promise<WebLookup>{
 const city=cityFromQuestion(question);
 if(!city)return {kind:"weather",status:"location_required",context:"使用者未指定可辨識的台灣縣市，請先詢問城市。",sources:[]};
 const forecast=requestedForecastDay(question);
 if(!forecast)return {kind:"weather",status:"unavailable",context:"目前只有未來天氣預報，不能把今天資料當成昨天資料。",answer:"我目前只能查即時或未來預報，過去的天氣需要另外查歷史氣象資料喔。",sources:[]};
 const [lat,lon,name]=city;
 const url="https://api.open-meteo.com/v1/forecast?latitude="+lat+"&longitude="+lon+
 "&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code"+
 "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum"+
 "&forecast_days=5&timezone=Asia%2FTaipei";
 try{
  const response=await fetch(url,{signal:AbortSignal.timeout(4800)});
  if(!response.ok)throw new Error("weather_http_"+response.status);
  const data=await response.json();
  const daily=data?.daily;
  const day=data?.daily?.time?.[forecast.offset];
  const high=daily?.temperature_2m_max?.[forecast.offset];
  const low=daily?.temperature_2m_min?.[forecast.offset];
  const rain=daily?.precipitation_probability_max?.[forecast.offset];
  const code=daily?.weather_code?.[forecast.offset];
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(day||""))||!Number.isFinite(high)||!Number.isFinite(low)){
   throw new Error("weather_no_forecast");
  }
  const dateLabel=day.slice(5).replace("-","/");  // e.g. 11/20, Asia/Taipei local date
  const summary=name+forecast.label+"（"+dateLabel+"）預報："+weatherDescription(Number(code))+
   "，氣溫 "+low+"～"+high+"°C，最高降雨機率 "+weatherNumber(rain,"%")+"。";
  const now= data?.current;
  const currentLine=forecast.offset===0&&Number.isFinite(now?.temperature_2m)?
   "\n目前氣溫 "+weatherNumber(now.temperature_2m,"°C")+"，資料時間 "+String(now.time||"未知")+"（台灣時間）。":"";
  const answer=summary+currentLine+"\n資料：Open-Meteo 氣象模式預報（非氣象署測站觀測）。\n來源：https://open-meteo.com/en/docs";
  return {kind:"weather",status:"ok",context:summary+currentLine+"\n預報日期："+day+"\n氣象服務 API："+url,
    answer,sources:[{title:"Open-Meteo "+name+"預報",url,snippet:summary}]};
 }catch(e){
  console.warn("chatbot_weather_fetch_failed",String(e instanceof Error?e.message:"weather_error").slice(0,80));
  return {kind:"weather",status:"unavailable",context:"氣象來源暫時無法取得資料，不得使用過時資訊猜測。",sources:[]};
 }
}
async function wikiFallback(q:string):Promise<SearchSource[]>{
 try{
  const u="https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch="+encodeURIComponent(q);
  const r=await fetch(u,{signal:AbortSignal.timeout(3100)});
  if(!r.ok)return [];
  const json=await r.json();
  const rows=json?.query?.search;
  if(!Array.isArray(rows))return [];
  return rows.slice(0,3).map((x:{title?:string;snippet?:string})=>({
   title:String(x.title||"").slice(0,140),
   url:"https://zh.wikipedia.org/wiki/"+encodeURIComponent(String(x.title||"").replaceAll(" ","_")),
   snippet:decodeXml(String(x.snippet||"")).replace(/<[^>]+>/g," ").replace(/\s+/g," ").slice(0,300)
  })).filter((x:SearchSource)=>x.title);
 }catch{return [];}
}
export async function searchWebContext(question:string):Promise<WebLookup>{
 const query=cleanupSearchQuery(question);
 if(!query)return {kind:"web",status:"unavailable",context:"沒有搜尋關鍵字。",sources:[]};
 const key=query.toLowerCase();
 const old=cache.get(key);
 if(old&&old.until>Date.now())return old.value;
 let result:WebLookup;
 if(WEATHER.test(query)){
  result=await lookupWeather(query);
 }else{
  const bing="https://www.bing.com/search?q="+encodeURIComponent(query)+"&format=rss&setlang=zh-Hant";
  const gnews="https://news.google.com/rss/search?q="+encodeURIComponent(query+" when:7d")+"&hl=zh-TW&gl=TW&ceid=TW:zh-Hant";
  const isNews=NEWS.test(query);
  const [primary,secondary]=await Promise.all([
   rssLookup(isNews?gnews:bing),
   rssLookup(isNews?bing:gnews)
  ]);
  let sources=[...primary,...secondary].filter((s,i,arr)=>arr.findIndex(x=>x.url===s.url)===i).slice(0,5);
  // Wikipedia is a background source only; never present it as current news.
  if(!sources.length&&!isNews)sources=await wikiFallback(query);
  result=sources.length?{kind:"web",status:"ok",
    context:"現在時間（Asia/Taipei）："+new Date().toLocaleString("zh-TW",{timeZone:"Asia/Taipei"})+
    "\n以下是公開搜尋索引的摘要，不代表原始網站已獲驗證，也不保證股價、比數等為即時報價：\n"+
    sources.map((s,i)=>"["+ (i+1) +"] "+s.title+"\n"+(s.published?"發布標記："+s.published+"\n":"")+
    "摘要："+s.snippet+"\n網址："+s.url).join("\n\n").slice(0,3800),
    sources
   }:{kind:"web",status:"unavailable",context:"目前無法取得可核對的即時搜尋結果，不能依舊知識猜測。",sources:[]};
 }
 if(cache.size>80)cache.clear();
 cache.set(key,{until:Date.now()+(result.status==="ok"?(result.kind==="weather"?300000:180000):25000),value:result});
 return result;
}
