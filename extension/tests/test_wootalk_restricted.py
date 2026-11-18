"""
WooTalk restricted-mode regression fixture.
This test NEVER connects to WooTalk or sends to real users. 
Usage: python -m pip install playwright; playwright install chromium; python extension/tests/test_wootalk_restricted.py
"""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

content = (Path(__file__).resolve().parents[1] / "content.js").read_text(encoding="utf-8")
original = "function isRestricted() { return /(^|\\.)wootalk\\.today$/i.test(location.hostname); }"
assert original in content, "WooTalk guard missing; update regression fixture"
# Simulate location.hostname == wootalk.today without navigating to the external website.
content = content.replace(original, "function isRestricted() { return true; }")
html = """<!doctype html><meta charset="utf-8">
<div id="chat"><div class="incoming">原有訊息</div></div>
<textarea id="input"></textarea><button id="send">送出</button>
<span id="counter">0</span>
<script>document.querySelector('#send').onclick=()=>document.querySelector('#counter').textContent=String(+document.querySelector('#counter').textContent+1)</script>"""
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, viewport=None)
    page = browser.new_page(viewport={"width":1280, "height":720})
    page.goto("about:blank")
    page.set_content(html)
    page.evaluate("""() => {
        window._calls=[];window._handlers=[];window._saved=[];
        window._site={enabled:true,messageSelector:'.incoming',inputSelector:'#input',sendSelector:'#send',mode:'fill',autoAuthorized:true};
        window.chrome={
            runtime:{
                onMessage:{addListener:f=>window._handlers.push(f)},
                sendMessage:async m=>{
                    window._calls.push(m);
                    if(m.type==='GET_SITE')return {ok:true,site:window._site};
                    if(m.type==='SAVE_SELECTOR'){window._site[m.key]=m.selector;window._saved.push(m);return {ok:true,site:window._site};}
                    if(m.type==='SUGGEST')return {ok:true,text:'AI 建議測試文字'};
                    return {ok:true};
                }
            },
            storage:{onChanged:{addListener:()=>{}}}
        };
    }""")
    page.add_script_tag(content=content)
    page.wait_for_timeout(400)
    page.locator("#chat").evaluate("e=>e.insertAdjacentHTML('beforeend','<div class=\"incoming\">新的聊天訊息</div>')")
    page.wait_for_timeout(750)
    assert page.evaluate("window._calls.filter(x=>x.type==='SUGGEST').length")==0, "Restricted site sent background AI request"
    response = page.evaluate("async()=>await new Promise(r=>window._handlers[0]({type:'TEST'}, {}, r))")
    assert response["ok"]
    assert page.evaluate("window._calls.filter(x=>x.type==='SUGGEST').length")==1
    assert page.locator("#counter").inner_text()=="0"
    assert page.locator("#input").input_value()==""
    # The assistant panel is intentionally a closed Shadow DOM. Click its visible Fill button.
    page.mouse.click(1058,670)
    page.wait_for_timeout(150)
    assert page.locator("#input").input_value()=="AI 建議測試文字", "Fill action failed"
    assert page.locator("#counter").inner_text()=="0", "Fill action must not send"
    page.evaluate("window._site.mode='auto'")
    page.evaluate("async()=>await new Promise(r=>window._handlers[0]({type:'SITE_RELOAD'}, {}, r))")
    page.locator("#chat").evaluate("e=>e.insertAdjacentHTML('beforeend','<div class=\"incoming\">第二則訊息</div>')")
    page.wait_for_timeout(750)
    assert page.evaluate("window._calls.filter(x=>x.type==='SUGGEST').length")==1
    assert page.locator("#counter").inner_text()=="0", "WooTalk auto-send guard failed"
    page.evaluate("async()=>await new Promise(r=>window._handlers[0]({type:'PICK',kind:'message'}, {}, r))")
    page.locator(".incoming").last.click(force=True)
    page.wait_for_timeout(100)
    assert len(page.evaluate("window._saved"))==1, "Selector not saved"
    print(json.dumps({"mode":"offline_fixture","result":"PASS","manual_ai_requests":1,"automatic_ai_requests":0,"send_clicks":0,"selector_saved":True}))
    browser.close()
