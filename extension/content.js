(() => {
  'use strict';
  if (globalThis.__CHATBOT_SITE_ASSISTANT__) return;
  globalThis.__CHATBOT_SITE_ASSISTANT__ = true;
  const origin = location.origin;
  let settings = null;
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  const SESSION_KEY = '__chatbot_session_v1__';
  function safeSessionGet() { try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } }
  function safeSessionSet(value) { try { sessionStorage.setItem(SESSION_KEY, value); } catch { /* unsupported origin */ } }
  let session = safeSessionGet() || newId();
  safeSessionSet(session);
  let baseline = '', baselineReady = false, generation = 0, busy = false, pendingMessage = null, lastAutoAnswer = null, pendingTimer = null, picker = null, pickerHighlight = null, panel = null;
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
  function writeAnswer(answer) {
    const node = select(settings?.inputSelector)[0];
    if (!node) return false;
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
    } else return false;
    return true;
  }
  function inputAnswer(answer) {
    if (!writeAnswer(answer)) return showPanel('找不到可用的輸入框，請重新選取或手動複製。', answer);
    showPanel('已填入輸入框，請由你確認後送出。', answer);
  }
  function isRestricted() { return /(^|\.)wootalk\.today$/i.test(location.hostname); }
  function autoSend(answer) {
    if (settings?.mode !== 'auto' || !settings?.autoAuthorized || isRestricted()) return false;
    const send = select(settings.sendSelector)[0];
    const input = select(settings?.inputSelector)[0];
    if (!send || !input) {
      showPanel('此網站的輸入框或送出鍵尚未設定，請改用人工發送。', answer);
      return true;
    }
    const existing = input.isContentEditable ? input.textContent : ('value' in input ? input.value : '');
    if (typeof existing === 'string' && existing.trim()) {
      showPanel('輸入框已有手動輸入的文字，已保留原文並停止自動發送。', answer);
      return true;
    }
    if (!writeAnswer(answer)) {
      showPanel('無法填入這個輸入框，請改用人工發送。', answer);
      return true;
    }
    try {
      lastAutoAnswer = answer; send.click();
      showPanel('已觸發網站的送出按鈕，請確認訊息是否成功送出。', answer);
    } catch(e) { showPanel('網站發送失敗，請改用人工送出。', answer); }
    return true;
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
      if (settings?.mode === 'fill' || isRestricted()) button('填入', () => inputAnswer(answer));
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
    if (!msg?.text) return { ok:false, error:'message_not_found' };
    if (busy) {
      pendingMessage = msg;
      return { ok:false, error:'request_in_progress' };
    }
    busy = true;
    const currentKey = signature(msg);
    const ticket = generation;
    const requestSession = session;
    const eventId = newId();
    showPanel('AI 正在整理回覆…');
    try {
      const result = await chrome.runtime.sendMessage({
        type:'SUGGEST', text:msg.text, conversationId:requestSession, eventId
      });
      // A response from a previous room, disabled site, or superseded message must never be delivered.
      if (ticket !== generation || requestSession !== session || !settings?.enabled ||
          (pendingMessage && signature(pendingMessage) !== currentKey)) {
        return {ok:false,error:'request_cancelled'};
      }
      if (!result?.ok) throw new Error(result?.error || 'unknown_error');
      if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('empty_ai_reply');
      if (!autoSend(result.text)) showPanel(result.text, result.text);
      return {ok:true};
    } catch(error) {
      const message = String(error?.message || error);
      if (ticket === generation && requestSession === session &&
          (!pendingMessage || signature(pendingMessage) === currentKey))
        showPanel('產生回覆失敗：' + message);
      return {ok:false,error:message};
    } finally {
      busy = false;
      const next = pendingMessage;
      pendingMessage = null;
      if (next && signature(next) !== currentKey) void runSuggestion(next);
    }
  }
  async function detect() {
    if (!settings?.enabled || !settings?.messageSelector || picker || isRestricted()) return;
    const msg = latestMessage(), next = signature(msg);
    // Initial empty rooms should answer the first *new* message, not discard it.
    if (!baselineReady) { baseline = next; baselineReady = true; return; }
    if (!next || next === baseline) return;
    if (settings?.mode === 'auto' && lastAutoAnswer && msg?.text === lastAutoAnswer) { baseline = next; return; }
    baseline = next;
    if (seen.has(next)) return;
    seen.add(next);
    if (seen.size > 80) seen.clear();
    await runSuggestion(msg);
  }
  function invalidate() {
    generation++;
    pendingMessage = null;
    lastAutoAnswer = null;
  }
  function refreshBaseline() {
    baseline = signature(latestMessage());
    baselineReady = true;
  }
  const observer = new MutationObserver(() => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => void detect(), 380);
  });
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    (async() => {
      if (msg.type === 'PICK') { startPick(msg.kind); return {ok:true}; }
      if (msg.type === 'SITE_RELOAD') { invalidate(); await reload(); refreshBaseline(); return {ok:true}; }
      if (msg.type === 'TEST') {
        const current = latestMessage(); if (!current) throw new Error('message_not_found');
        return await runSuggestion(current);
      }
      if (msg.type === 'RESET') {
        invalidate();
        session = newId(); safeSessionSet(session);
        seen.clear(); refreshBaseline(); return {ok:true};
      }
      if (msg.type === 'STATUS') return {ok:true,active:Boolean(settings?.enabled),matched:select(settings?.messageSelector).length};
      throw new Error('unknown_action');
    })().then(respond).catch(e => respond({ok:false,error:String(e?.message || e)}));
    return true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.chatbotSites) {
      invalidate();
      void reload().then(refreshBaseline);
    }
  });
  void reload().then(() => {
    refreshBaseline();
    observer.observe(document.documentElement, {subtree:true,childList:true,characterData:true});
  });
})();
