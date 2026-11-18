(() => {
  'use strict';
  if (globalThis.__CHATBOT_SITE_ASSISTANT__) return;
  globalThis.__CHATBOT_SITE_ASSISTANT__ = true;
  const origin = location.origin;
  let settings = null;
  let session = crypto.randomUUID().replaceAll('-', '');
  let baseline = '', busy = false, pendingTimer = null, picker = null, pickerHighlight = null, panel = null;
  const seen = new Set();
  function select(css) {
    try { return css ? [...document.querySelectorAll(css)] : []; } catch { return []; }
  }
  function cleanText(element) { return (element?.innerText || element?.textContent || '').trim().slice(0, 2000); }
  function latestMessage() {
    const list = select(settings?.messageSelector).filter(el => cleanText(el));
    const last = list.at(-1);
    return last ? { text: cleanText(last), count: list.length } : null;
  }
  function signature(msg) { return msg ? msg.count + '\u0001' + msg.text : ''; }
  async function reload() {
    const data = await chrome.runtime.sendMessage({ type: 'GET_SITE', origin });
    settings = data?.site || null;
  }
  function selectorFor(el) {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    for (const attr of ['data-testid', 'data-role', 'data-message-type']) {
      const value = el.getAttribute(attr);
      if (value) return el.localName + '[' + attr + '="' + value.replaceAll('"', '\\"') + '"]';
    }
    const ownClass = [...el.classList].find(c => !/^(active|selected|hover|focus|open)$/i.test(c) && c.length < 80);
    if (ownClass) return el.localName + '.' + CSS.escape(ownClass);
    const parts = [];
    for (let n = el, depth = 0; n && n !== document.body && depth < 7; n = n.parentElement, depth++) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const siblings = n.parentElement ? [...n.parentElement.children].filter(x => x.localName === n.localName) : [];
      parts.unshift(n.localName + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(n) + 1) + ')' : ''));
    }
    return parts.join(' > ');
  }
  function removePicker() {
    document.removeEventListener('pointermove', hover, true);
    document.removeEventListener('click', pick, true);
    document.removeEventListener('keydown', cancelOnEscape, true);
    if (pickerHighlight) pickerHighlight.remove();
    pickerHighlight = null; picker = null;
  }
  function hover(e) {
    if (!pickerHighlight) return;
    const r = e.target.getBoundingClientRect();
    Object.assign(pickerHighlight.style, {
      left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px'
    });
  }
  function cancelOnEscape(e) { if (e.key === 'Escape') removePicker(); }
  async function pick(e) {
    if (!picker) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const target = e.target;
    const selector = selectorFor(target);
    const key = picker === 'message' ? 'messageSelector' : picker === 'input' ? 'inputSelector' : 'sendSelector';
    removePicker();
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SAVE_SELECTOR', origin, key, selector });
      if (!result?.ok) throw new Error(result?.error || 'save_failed');
      settings = result.site;
      baseline = signature(latestMessage());
      showPanel('已儲存「' + (key === 'messageSelector' ? '對方訊息' : key === 'inputSelector' ? '輸入框' : '送出按鈕') + '」選取規則。');
    } catch(error) { showPanel('儲存失敗：' + String(error?.message || error)); }
  }
  function startPick(kind) {
    removePicker(); picker = kind;
    pickerHighlight = document.createElement('div');
    pickerHighlight.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #356dd5;background:#356dd524;box-sizing:border-box;';
    document.documentElement.appendChild(pickerHighlight);
    document.addEventListener('pointermove', hover, true);
    document.addEventListener('click', pick, true);
    document.addEventListener('keydown', cancelOnEscape, true);
    showPanel('請點選「' + ({ message:'對方訊息泡泡', input:'文字輸入框', send:'傳送按鈕' })[kind] + '」，按 Esc 可取消。');
  }
  function inputAnswer(answer) {
    const node = select(settings?.inputSelector)[0];
    if (!node) return showPanel('找不到輸入框，請先在擴充功能重新選取。');
    node.focus();
    if (node.isContentEditable) {
      node.textContent = answer;
      node.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:answer }));
    } else if ('value' in node) {
      const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(node, answer); else node.value = answer;
      node.dispatchEvent(new Event('input', { bubbles:true }));
      node.dispatchEvent(new Event('change', { bubbles:true }));
    } else return showPanel('不支援此輸入框，請用複製功能。');
    showPanel('已填入輸入框，請由你確認後送出。', answer);
  }
  function showPanel(text, answer = null) {
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.style.cssText = 'all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483646;max-width:360px;box-shadow:0 12px 40px #0003;border-radius:12px;background:#fff;font:14px system-ui,sans-serif;color:#17233d;';
    const shadow = panel.attachShadow({ mode:'closed' });
    const root = document.createElement('div');
    root.style.cssText = 'padding:15px;line-height:1.5;';
    const head = document.createElement('div');
    head.textContent = 'CHATBOT AI 助手'; head.style.cssText = 'font-weight:700;margin-bottom:8px;';
    const desc = document.createElement('div');
    desc.textContent = text; desc.style.cssText = 'white-space:pre-wrap;max-height:160px;overflow:auto;';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-top:12px;';
    const button = (title, click) => {
      const el = document.createElement('button');
      el.textContent = title;
      el.style.cssText = 'cursor:pointer;border:1px solid #b6c3d2;border-radius:7px;padding:6px 10px;background:white;color:#17233d;';
      el.addEventListener('click', click); actions.appendChild(el);
    };
    if (answer) {
      if (settings?.mode === 'fill') button('填入', () => inputAnswer(answer));
      button('複製', async () => {
        try { await navigator.clipboard.writeText(answer); }
        catch { showPanel('複製失敗，請手動選取文字複製。', answer); }
      });
    }
    button('關閉', () => { panel.remove(); panel = null; });
    root.append(head, desc, actions);
    shadow.append(root);
    document.documentElement.appendChild(panel);
  }
  async function runSuggestion(msg) {
    if (busy || !msg?.text) return;
    busy = true;
    const eventId = crypto.randomUUID().replaceAll('-', '');
    showPanel('AI 正在整理回覆…');
    try {
      const result = await chrome.runtime.sendMessage({
        type:'SUGGEST', text:msg.text, conversationId:session, eventId
      });
      if (!result?.ok) throw new Error(result?.error || 'unknown_error');
      showPanel(result.text, result.text);
    } catch(error) { showPanel('產生回覆失敗：' + String(error?.message || error)); }
    finally { busy = false; }
  }
  async function detect() {
    if (!settings?.enabled || !settings?.messageSelector || picker) return;
    const msg = latestMessage(), next = signature(msg);
    if (!next || next === baseline) return;
    if (!baseline) { baseline = next; return; }
    baseline = next;
    if (seen.has(next)) return;
    seen.add(next);
    if (seen.size > 80) seen.clear();
    await runSuggestion(msg);
  }
  const observer = new MutationObserver(() => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => void detect(), 380);
  });
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    (async() => {
      if (msg.type === 'PICK') { startPick(msg.kind); return {ok:true}; }
      if (msg.type === 'SITE_RELOAD') { await reload(); baseline = signature(latestMessage()); return {ok:true}; }
      if (msg.type === 'TEST') {
        const current = latestMessage(); if (!current) throw new Error('message_not_found');
        await runSuggestion(current); return {ok:true};
      }
      if (msg.type === 'RESET') {
        session = crypto.randomUUID().replaceAll('-', '');
        seen.clear(); baseline = signature(latestMessage()); return {ok:true};
      }
      if (msg.type === 'STATUS') return {ok:true,active:Boolean(settings?.enabled),matched:select(settings?.messageSelector).length};
      throw new Error('unknown_action');
    })().then(respond).catch(e => respond({ok:false,error:String(e?.message || e)}));
    return true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.chatbotSites) void reload().then(() => { baseline = signature(latestMessage()); });
  });
  void reload().then(() => {
    baseline = signature(latestMessage());
    observer.observe(document.documentElement, {subtree:true,childList:true,characterData:true});
  });
})();
