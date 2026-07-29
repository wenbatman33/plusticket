// popup 設定頁邏輯

const DEFAULT_SETTINGS = {
  enabled: false,
  sessionKeyword: '',
  ticketRules: '全票 1',
  autoAgree: true,
  autoNext: false,
};

const els = {
  enabled: document.getElementById('enabled'),
  sessionKeyword: document.getElementById('sessionKeyword'),
  ticketRules: document.getElementById('ticketRules'),
  autoAgree: document.getElementById('autoAgree'),
  autoNext: document.getElementById('autoNext'),
  save: document.getElementById('save'),
  run: document.getElementById('run'),
  status: document.getElementById('status'),
};

// 載入現有設定
chrome.storage.sync.get(DEFAULT_SETTINGS).then((s) => {
  els.enabled.checked = s.enabled;
  els.sessionKeyword.value = s.sessionKeyword;
  els.ticketRules.value = s.ticketRules;
  els.autoAgree.checked = s.autoAgree;
  els.autoNext.checked = s.autoNext;
});

function collect() {
  return {
    enabled: els.enabled.checked,
    sessionKeyword: els.sessionKeyword.value.trim(),
    ticketRules: els.ticketRules.value,
    autoAgree: els.autoAgree.checked,
    autoNext: els.autoNext.checked,
  };
}

function flash(msg) {
  els.status.textContent = msg;
  setTimeout(() => { els.status.textContent = ''; }, 2000);
}

els.save.addEventListener('click', async () => {
  await chrome.storage.sync.set(collect());
  flash('✅ 已儲存');
});

// 儲存後對目前分頁送「立即執行」訊息
els.run.addEventListener('click', async () => {
  await chrome.storage.sync.set(collect());
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('ticketplus.com.tw')) {
    flash('⚠️ 請先開啟 ticketplus 頁面');
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'RUN_NOW' });
    flash('▶ 已觸發執行');
  } catch (e) {
    flash('⚠️ 請重新整理頁面後再試');
  }
});
