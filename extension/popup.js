'use strict';
let origin = null, tabId = null;
const $ = id => document.getElementById(id);
function notice(text, ok = false) { $('notice').textContent = text; $('notice').className = ok ? 'ok' : ''; }
function address(url) {
  try { const u = new URL(url); return ['https:', 'http:'].includes(u.protocol) ? u.origin : null; }
  catch { return null; }
}
async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null; origin = address(tab?.url);
  $('origin').textContent = origin || '此頁面不支援擴充功能';
  $('enableSite').disabled = !origin;
}
async function load() {
  const status = await chrome.runtime.sendMessage({ type: 'PAIR_STATUS' });
  $('connection').textContent = status.paired ? '已配對' : '未配對';
  $('connection').className = status.paired ? 'chip connected' : 'chip';
  $('pairArea').hidden = status.paired;
  await currentTab();
  const { chatbotSites = {} } = await chrome.storage.local.get('chatbotSites');
  const site = chatbotSites[origin] || {};
  $('enableSite').hidden = !!site.enabled; $('disableSite').hidden = !site.enabled;
  $('siteArea').hidden = !site.enabled; $('replyMode').value = site.mode || 'suggest';
  const labels = [['messageSelector', '訊息'], ['inputSelector', '輸入框'], ['sendSelector', '傳送鍵']];
  $('selectorStatus').textContent = labels.map(([key, name]) => name + '：' + (site[key] ? '已選取' : '未設定')).join('　');
}
async function sendTab(message) {
  if (!tabId) throw new Error('沒有網頁分頁');
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch { throw new Error('頁面尚未載入，請重新整理此網站後再操作。'); }
}
$('pairBtn').addEventListener('click', async () => {
  $('pairBtn').disabled = true;
  try {
    const code = $('pairCode').value.trim();
    if (code.length < 16) throw new Error('配對碼格式不正確');
    const result = await chrome.runtime.sendMessage({ type: 'PAIR', code });
    if (!result.ok) throw new Error(result.error);
    $('pairCode').value = ''; notice('連接成功', true); await load();
  } catch (e) { notice('配對失敗：' + e.message); }
  finally { $('pairBtn').disabled = false; }
});
$('enableSite').addEventListener('click', async () => {
  try {
    if (!origin) throw new Error('不支援此網頁');
    const allowed = await chrome.permissions.request({ origins: [origin + '/*'] });
    if (!allowed) throw new Error('未取得網站授權');
    await chrome.scripting.registerContentScripts([{
      id: 'chatbot-' + btoa(origin).replaceAll('=', '').replaceAll('/', '_').replaceAll('+', '-'),
      matches: [origin + '/*'], js: ['content.js'], runAt: 'document_idle', persistAcrossSessions: true
    }]).catch(async e => {
      if (!/Duplicate script ID|already exists/i.test(String(e))) throw e;
    });
    const { chatbotSites = {} } = await chrome.storage.local.get('chatbotSites');
    await chrome.storage.local.set({ chatbotSites: {
      ...chatbotSites, [origin]: { ...(chatbotSites[origin] || {}), enabled: true, mode: 'suggest' }
    } });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    notice('網站已啟用，請依序選取網頁元素。', true); await load();
  } catch (e) { notice(e.message); }
});
$('disableSite').addEventListener('click', async () => {
  try {
    const { chatbotSites = {} } = await chrome.storage.local.get('chatbotSites');
    chatbotSites[origin] = { ...(chatbotSites[origin] || {}), enabled: false };
    await chrome.storage.local.set({ chatbotSites });
    notice('網站已停用', true); await load();
  } catch (e) { notice(e.message); }
});
document.querySelectorAll('[data-pick]').forEach(button => button.addEventListener('click', async () => {
  try { const r = await sendTab({ type: 'PICK', kind: button.dataset.pick }); if (!r.ok) throw new Error(r.error); window.close(); }
  catch (e) { notice(e.message); }
}));
async function saveSite(changes) {
  const { chatbotSites = {} } = await chrome.storage.local.get('chatbotSites');
  await chrome.storage.local.set({ chatbotSites: { ...chatbotSites, [origin]: { ...chatbotSites[origin], ...changes } } });
}
$('replyMode').addEventListener('change', async () => {
  const mode = $('replyMode').value;
  if (mode === 'auto' && !$('autoAuthorized').checked) {
    $('replyMode').value = 'suggest';
    return notice('必須先確認已獲網站自動化許可，才能啟用自動發送。');
  }
  await saveSite({ mode }); notice('模式已儲存', true);
});
$('autoAuthorized').addEventListener('change', async () => {
  const checked = $('autoAuthorized').checked;
  await saveSite({ autoAuthorized: checked, ...(!checked ? { mode:'suggest' } : {}) });
  if (!checked) $('replyMode').value = 'suggest';
  notice('授權設定已更新', true);
});
$('testBtn').addEventListener('click', async () => {
  try { const r = await sendTab({ type: 'TEST' }); if (!r.ok) throw new Error(r.error); notice('已送出測試，請查看網頁右下方。', true); }
  catch (e) { notice(e.message); }
});
$('resetBtn').addEventListener('click', async () => {
  try { const r = await sendTab({ type: 'RESET' }); if (!r.ok) throw new Error(r.error); notice('新對話已開始', true); }
  catch (e) { notice(e.message); }
});
$('disconnectBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'DISCONNECT' });
  notice('本機配對已取消。伺服器端如需撤銷金鑰，請另行撤銷。', true); await load();
});
load().catch(e => notice(e.message));
