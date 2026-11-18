'use strict';
const API = 'https://unapiwajmgqqtdkixaab.supabase.co/functions/v1/chatbot-api';
const KEY = 'chatbotDeviceToken';
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(console.error);
});
async function requestAPI(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(API + path, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || ('HTTP_' + response.status));
  return result;
}
function normalizeOrigin(url) {
  const u = new URL(url);
  if (!['https:', 'http:'].includes(u.protocol) || !u.hostname) throw new Error('unsupported_site');
  return u.origin;
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== 'string') throw new Error('invalid_request');
    if (message.type === 'GET_SITE') {
      if (!sender.tab || normalizeOrigin(sender.tab.url) !== message.origin) throw new Error('forbidden');
      const { chatbotSites = {} } = await chrome.storage.local.get('chatbotSites');
      return { ok: true, site: chatbotSites[message.origin] || null };
    }
    if (message.type === 'SAVE_SELECTOR') {
      if (!sender.tab || normalizeOrigin(sender.tab.url) !== message.origin) throw new Error('forbidden');
      if (!['messageSelector', 'inputSelector', 'sendSelector'].includes(message.key) ||
          typeof message.selector !== 'string' || message.selector.length > 500) throw new Error('invalid_selector');
      const { chatbotSites = {} } = await chrome.storage.local.get('chatbotSites');
      const entry = { ...(chatbotSites[message.origin] || {}), [message.key]: message.selector };
      if (!entry.enabled) throw new Error('site_not_enabled');
      await chrome.storage.local.set({ chatbotSites: { ...chatbotSites, [message.origin]: entry } });
      return { ok: true, site: entry };
    }
    if (message.type === 'PAIR') {
      if (sender.tab || typeof message.code !== 'string') throw new Error('forbidden');
      const data = await requestAPI('/pair', { code: message.code.trim(), deviceName: 'Chrome 擴充功能' });
      await chrome.storage.local.set({ [KEY]: data.token });
      return { ok: true, deviceId: data.deviceId };
    }
    if (message.type === 'PAIR_STATUS') {
      if (sender.tab) throw new Error('forbidden');
      const data = await chrome.storage.local.get(KEY);
      return { ok: true, paired: Boolean(data[KEY]) };
    }
    if (message.type === 'DISCONNECT') {
      if (sender.tab) throw new Error('forbidden');
      const data = await chrome.storage.local.get(KEY);
      if (data[KEY]) await requestAPI('/revoke', {}, data[KEY]);
      await chrome.storage.local.remove(KEY);
      return { ok: true };
    }
    if (message.type === 'SUGGEST') {
      if (!sender.tab || typeof sender.tab.url !== 'string') throw new Error('forbidden');
      const origin = normalizeOrigin(sender.tab.url);
      const settings = (await chrome.storage.local.get('chatbotSites')).chatbotSites || {};
      if (!settings[origin]?.enabled) throw new Error('site_not_enabled');
      if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 2000) throw new Error('invalid_message');
      if (typeof message.conversationId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(message.conversationId)) throw new Error('invalid_conversation');
      if (typeof message.eventId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(message.eventId)) throw new Error('invalid_event');
      const data = await chrome.storage.local.get(KEY);
      if (!data[KEY]) throw new Error('not_paired');
      return { ok: true, ...(await requestAPI('/reply', {
        origin, conversationId: message.conversationId, eventId: message.eventId, message: message.text.trim()
      }, data[KEY])) };
    }
    throw new Error('unknown_action');
  })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
