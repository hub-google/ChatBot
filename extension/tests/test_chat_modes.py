"""Chromium fixture for CHATBOT extension modes. No external requests, real users, or AI credits used."""
from pathlib import Path
import json
import shutil
from playwright.sync_api import sync_playwright

source = (Path(__file__).resolve().parents[1] / "content.js").read_text(encoding="utf-8")
guard = "function isRestricted() { return /(^|\\.)wootalk\\.today$/i.test(location.hostname); }"
assert guard in source, "WooTalk restricted-domain guard missing"
html = """<!doctype html><meta charset="utf-8">
<div id="chat"><div class="incoming">舊的訊息</div></div>
<textarea id="input"></textarea><button id="send">送出</button><span id="counter">0</span>
<script>document.querySelector('#send').onclick=()=>{
  document.querySelector('#counter').textContent=String(+document.querySelector('#counter').textContent+1);
  const outgoing=document.createElement('div');outgoing.className='outgoing';
  outgoing.textContent=document.querySelector('#input').value;
  document.querySelector('#chat').appendChild(outgoing);
}</script>"""
setup = """(opts) => {
 window._calls=[];window._handlers=[];window._roots=[];
 window._site={enabled:true,messageSelector:'.incoming',inputSelector:'#input',sendSelector:'#send',
               mode:opts.mode,autoAuthorized:opts.authorized};
 const native=Element.prototype.attachShadow;
 Element.prototype.attachShadow=function(init){const root=native.call(this,init);window._roots.push(root);return root;};
 window.chrome={
   runtime:{onMessage:{addListener:f=>window._handlers.push(f)},
     sendMessage:async msg=>{
       window._calls.push(msg);
       if(msg.type==='GET_SITE')return {ok:true,site:window._site};
       if(msg.type==='SUGGEST')return window._fail?{ok:false,error:'mock_backend_failed'}:{ok:true,text:'AI 自動回覆'};
       return {ok:true};
     }},
   storage:{onChanged:{addListener:()=>{}}}
 };
}"""

def make_page(browser, mode, authorized=False, restricted=False):
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    page.goto("about:blank")
    page.set_content(html)
    page.evaluate(setup, {"mode": mode, "authorized": authorized})
    content = source.replace(guard, "function isRestricted() { return true; }") if restricted else source
    page.add_script_tag(content=content)
    page.wait_for_timeout(150)
    return page

def incoming(page, message):
    page.locator("#chat").evaluate("""(chat, msg) => {
      const div=document.createElement('div');div.className='incoming';div.textContent=msg;chat.appendChild(div);
    }""", message)
    page.wait_for_timeout(650)

def requests(page):
    return page.evaluate("window._calls.filter(c => c.type === 'SUGGEST').length")

def sends(page):
    return int(page.locator("#counter").inner_text())

def fill_click(page):
    page.evaluate("""() => {
      const b=[...(window._roots.at(-1)?.querySelectorAll('button') || [])].find(x=>x.textContent==='填入');
      if(!b)throw Error('Fill button missing');
      b.click();
    }""")

options = {"headless": True}
if shutil.which("chromium"):
    options.update({"executable_path": shutil.which("chromium"), "args": ["--no-sandbox"]})
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(**options)

    page = make_page(browser, "auto", authorized=True)
    incoming(page, "你好")
    incoming(page, "第二則")
    page.wait_for_timeout(550)
    assert requests(page) == 2 and sends(page) == 2, "Auto reply failed on a permitted site"
    results.append("permitted_auto_two_turns: PASS")
    page.close()

    page = make_page(browser, "auto", authorized=False)
    incoming(page, "你好")
    assert requests(page) == 1 and sends(page) == 0, "Unauthorized auto-send"
    results.append("unauthorized_auto_no_send: PASS")
    page.close()

    page = make_page(browser, "fill")
    incoming(page, "你好")
    assert requests(page) == 1 and sends(page) == 0 and not page.locator("#input").input_value()
    fill_click(page)
    assert page.locator("#input").input_value() == "AI 自動回覆" and sends(page) == 0
    results.append("fill_does_not_send: PASS")
    page.close()

    page = make_page(browser, "fill", restricted=True)
    incoming(page, "你好")
    assert requests(page) == 0, "WooTalk background AI request must be disabled"
    response = page.evaluate("""async () => await new Promise(resolve =>
      window._handlers[0]({type:'TEST'}, {}, resolve))""")
    assert response["ok"] and requests(page) == 1 and sends(page) == 0
    fill_click(page)
    assert page.locator("#input").input_value() == "AI 自動回覆" and sends(page) == 0
    page.evaluate("window._site.mode='auto'")
    page.evaluate("""async () => await new Promise(resolve =>
      window._handlers[0]({type:'SITE_RELOAD'}, {}, resolve))""")
    incoming(page, "第二則")
    assert requests(page) == 1 and sends(page) == 0
    results.append("wootalk_manual_only: PASS")
    page.close()

    page = make_page(browser, "auto", authorized=True)
    page.evaluate("window._fail=true")
    incoming(page, "你好")
    assert requests(page) == 1 and sends(page) == 0, "Failed AI response was sent"
    results.append("api_error_no_send: PASS")
    page.close()
    browser.close()
print(json.dumps({"mode": "offline_chromium_fixture", "results": results}, ensure_ascii=False))
