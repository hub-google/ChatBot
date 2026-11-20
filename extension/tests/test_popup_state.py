"""Exercise popup permissions and stored mode state with a real Chromium DOM fixture."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html = (root / "popup.html").read_text(encoding="utf-8")
script = (root / "popup.js").read_text(encoding="utf-8")

def setup(browser, url, mode="auto", authorized=True):
    page = browser.new_page(viewport={"width": 430, "height": 780})
    page.goto("about:blank")
    # Script element refers to a relative URL in the real popup; set_content does not
    # load it in about:blank, and we inject the actual source explicitly below.
    page.set_content(html)
    page.evaluate("""config => {
      window._site = {enabled:true,mode:config.mode,autoAuthorized:config.authorized,
        messageSelector:'.incoming',inputSelector:'#input',sendSelector:'#send'};
      window._store = {chatbotSites:{[new URL(config.url).origin]:window._site}};
      window.chrome={
        tabs:{query:async()=>[{id:5,url:config.url}]},
        runtime:{sendMessage:async m=>{
          if(m.type==='PAIR_STATUS')return {ok:true,paired:true};
          return {ok:true};
        }},
        storage:{local:{
          get:async()=>window._store,
          set:async data=>{Object.assign(window._store,data);}
        }}
      };
    }""", {"url":url,"mode":mode,"authorized":authorized})
    page.add_script_tag(content=script)
    page.wait_for_function("document.querySelector('#origin').textContent.startsWith('http')")
    return page

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    wootalk = setup(browser, "https://wootalk.today/")
    assert wootalk.locator("#replyMode").input_value() == "fill"
    assert wootalk.locator("#replyMode option[value='auto']").is_disabled()
    assert wootalk.locator("#autoAuthorized").is_disabled()
    assert not wootalk.locator("#autoAuthorized").is_checked()
    wootalk.close()

    permitted = setup(browser, "https://example.com/")
    assert permitted.locator("#replyMode").input_value() == "auto"
    assert not permitted.locator("#replyMode option[value='auto']").is_disabled()
    assert permitted.locator("#autoAuthorized").is_checked()
    permitted.close()
    browser.close()

print(json.dumps({"mode":"offline_chromium_fixture","popup_tests":[
    "wootalk_auto_mode_disabled: PASS",
    "permitted_site_saved_authorization_restored: PASS"
]},ensure_ascii=False))
