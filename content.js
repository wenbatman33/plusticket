// TicketPlus 購票小幫手 - content script
// 因為 ticketplus 是 Vue/Vuetify SPA，路由切換不會重新載入頁面，
// 所以用輪詢 + 網址變化偵測的方式，在對的頁面執行對的動作。
//
// 實測 DOM 結構（2026-07 驗證）：
// - 選票頁（/order/...）：每個票種一列，數量是「−」「＋」按鈕（mdi-minus/mdi-plus
//   圖示、外層 .count-button）夾著一個純文字 div，不是 input。
// - 「我已經閱讀並同意…」checkbox 不在選票步驟，是按「下一步」後的
//   「填寫資料」步驟才出現，且 SPA 換步驟時網址不變 → 用獨立監看處理。

(() => {
  'use strict';

  // 版本號會顯示在右下角提示，方便確認插件已重新載入
  const VERSION = 'v1.1.0';

  // ===== 預設設定 =====
  const DEFAULT_SETTINGS = {
    enabled: false,        // 總開關（自動模式）
    sessionKeyword: '',    // 場次關鍵字（比對日期或場次名稱，空 = 第一個可購買場次）
    ticketRules: '全票 1', // 票種規則，一行一條：「票種關鍵字 張數」，* 代表第一個票種
    autoAgree: true,       // 自動勾選同意條款
    autoNext: false,       // 填完票數後自動按「下一步」
  };

  let settings = { ...DEFAULT_SETTINGS };
  let lastUrl = '';
  // 每個頁面只自動執行一次，避免重複狂點（換頁後重置）
  let doneFlags = { session: false, ticket: false };
  // 按「立即執行」後的接續期限：期限內即使自動模式關閉，
  // 換頁／換步驟也會繼續把流程做完（選場次→填票→勾條款）
  let manualUntil = 0;
  // 已自動勾過的 checkbox（若使用者手動取消勾選，不要再幫他勾回去）
  const agreedBoxes = new WeakSet();

  // ===== 小工具 =====
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const visible = (el) => !!(el && el.offsetParent !== null);
  const textOf = (el) => ((el && el.innerText) || '').replace(/\s+/g, ' ').trim();

  function log(msg) {
    console.log('[TicketPlus小幫手]', msg);
    showToast(msg);
  }

  // 右下角浮動提示，讓使用者知道插件做了什麼
  let toastEl = null;
  let toastTimer = null;
  function showToast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:99999',
        'background:rgba(30,30,30,.92)', 'color:#fff', 'padding:10px 16px',
        'border-radius:8px', 'font-size:14px', 'max-width:320px',
        'box-shadow:0 4px 12px rgba(0,0,0,.3)', 'pointer-events:none',
        'transition:opacity .3s', 'white-space:pre-wrap',
      ].join(';');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = `🎫 ${VERSION}｜${msg}`;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 4000);
  }

  // 解析票種規則文字 → [{keyword, count}]
  function parseTicketRules(text) {
    return (text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(.*?)[\s:：=]+(\d+)$/);
        if (!m) return null;
        return { keyword: m[1].trim(), count: parseInt(m[2], 10) };
      })
      .filter((r) => r && r.count > 0);
  }

  // ===== 場次選擇（活動頁 /activity/xxx）=====
  // 活動頁「立即購買」分頁下，每個場次是一列，列上有「立即購買 / 熱賣中」按鈕。
  // 單場次活動則只有一顆大的「立即購買」按鈕。
  function handleActivityPage() {
    if (doneFlags.session) return;

    // 找出所有可點的購買按鈕（排除已售完 / disabled）
    const buyButtons = $$('button').filter((b) => {
      const t = textOf(b);
      return visible(b) && !b.disabled &&
        (t.includes('立即購買') || t.includes('熱賣中') || t.includes('購買')) &&
        !t.includes('售完') && !t.includes('已截止');
    });
    if (buyButtons.length === 0) return; // 頁面還沒載完，下一輪再試

    let target = null;
    const kw = settings.sessionKeyword.trim();
    if (kw) {
      // 用關鍵字比對按鈕所在列（往上找含場次資訊的容器）的文字
      target = buyButtons.find((b) => {
        let node = b;
        for (let i = 0; i < 6 && node; i++) {
          const t = textOf(node);
          if (t.includes(kw)) return true;
          node = node.parentElement;
        }
        return false;
      });
      if (!target) {
        log(`找不到符合「${kw}」的場次，請確認關鍵字`);
        doneFlags.session = true; // 避免一直跳提示
        return;
      }
    } else {
      target = buyButtons[0]; // 沒設關鍵字就選第一個可買的
    }

    doneFlags.session = true;
    log(kw ? `選擇場次「${kw}」，點擊購買` : '點擊第一個可購買場次');
    target.click();
  }

  // ===== 票數填寫（選票頁）=====
  // 票種列：票名 + NT.價格 + [−] 數量 [＋]。用「＋」按鈕（mdi-plus）定位每一列，
  // 數量是 .count-button 裡夾在中間的純文字 div。
  function getTicketRows() {
    return $$('button')
      .filter((b) => visible(b) && b.querySelector('.mdi-plus'))
      .map((btn) => {
        const box = btn.closest('.count-button') || btn.parentElement;
        // 往上找到含票名與 NT. 價格的「列」容器
        let node = btn.parentElement;
        let row = null;
        for (let i = 0; i < 8 && node; i++) {
          if (/NT\.?\s*\d/.test(textOf(node))) { row = node; break; }
          node = node.parentElement;
        }
        return { btn, box, row: row || btn.parentElement, text: textOf(row || btn.parentElement) };
      });
  }

  // 讀取該列目前數量（−與＋中間的數字）
  function currentCount(box) {
    const m = textOf(box).match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }

  function handleTicketPage() {
    if (doneFlags.ticket) return;

    const rows = getTicketRows();
    if (rows.length === 0) return; // 票種區塊還沒載入，下一輪再試

    const rules = parseTicketRules(settings.ticketRules);
    if (rules.length === 0) {
      log('尚未設定票種規則，請點插件圖示設定');
      doneFlags.ticket = true;
      return;
    }

    doneFlags.ticket = true;
    const done = [];
    let touched = false;
    for (const rule of rules) {
      const row = rule.keyword === '*' ? rows[0] : rows.find((r) => r.text.includes(rule.keyword));
      if (!row) {
        log(`找不到票種「${rule.keyword}」`);
        continue;
      }
      // 讀目前數量，只補點差額（重複執行不會超量）
      const cur = currentCount(row.box);
      const diff = rule.count - cur;
      if (diff > 0) {
        for (let i = 0; i < diff; i++) row.btn.click();
      } else if (diff < 0) {
        const minusBtn = row.box.querySelector('.mdi-minus')?.closest('button');
        if (minusBtn) for (let i = 0; i < -diff; i++) minusBtn.click();
      }
      touched = true;
      done.push(`${rule.keyword === '*' ? '第一票種' : rule.keyword} x${rule.count}`);
    }

    if (done.length) log('票數已填：' + done.join('、'));

    // 自動按下一步（預設關閉）。下一步按鈕要等票數>0 才會啟用，稍等再點。
    if (settings.autoNext && touched) {
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        const next = $$('button').find((b) =>
          visible(b) && !b.disabled && textOf(b).includes('下一步')
        );
        if (next) {
          clearInterval(timer);
          log('自動點擊「下一步」');
          next.click();
        } else if (tries > 10) {
          clearInterval(timer);
        }
      }, 500);
    }
  }

  // ===== 同意條款監看（每一步都掃，出現就勾）=====
  // 「我已經閱讀並同意…」出現在填寫資料步驟（/confirm/...）。
  // 2026-07 實測：該步驟同時有「使用文化幣折抵」checkbox，
  // 所以只能認 .v-input 容器裡自己的 label 文字（含「閱讀並同意」），
  // 不能往上層亂找「同意」兩字，否則會誤勾到別的選項。
  function tickAgree() {
    if (!settings.autoAgree) return false;
    let acted = false;
    for (const cb of $$('input[type="checkbox"]')) {
      if (cb.checked || agreedBoxes.has(cb)) continue;
      const container = cb.closest('.v-input') || cb.parentElement;
      if (!visible(container)) continue;
      if (!textOf(container).includes('閱讀並同意')) continue;
      agreedBoxes.add(cb); // 先記起來：就算使用者手動取消，也不再重複勾
      cb.click();
      log('已自動勾選同意條款');
      acted = true;
    }
    return acted;
  }

  // ===== 排隊狀態面板 =====
  // 錯誤碼對照表：出自網站前端 chunk-3225fb1b 的 errorHandler 分支，
  // 中文訊息取自該站 i18n（2026-07 驗證）。
  // 關鍵：只有 137 是「還在排隊」，其餘非 00 的碼前端都會把
  // window.isEnquene 設為 false，等於整個排隊流程中止、必須重新整理。
  const ERR_CODES = {
    '00':  { text: '排到了，開始鎖票', level: 'ok' },
    '137': { text: '排隊中（本輪未抽中）', level: 'wait' },
    '101': { text: '操作出現問題，請稍後再試', level: 'dead' },
    '110': { text: '流量管控中，請按確定後重試', level: 'dead' },
    '112': { text: '票種已售完或超過購票張數限制', level: 'dead' },
    '113': { text: '該區已無座位，請重新選擇票區', level: 'dead' },
    '114': { text: '購票逾時，請重新整理', level: 'dead' },
    '115': { text: '票種已售完或超過購票張數限制', level: 'dead' },
    '116': { text: '無足夠座位／無連續座位', level: 'dead' },
    '121': { text: '票種已售完或超過購票張數限制', level: 'dead' },
    '124': { text: '序號錯誤', level: 'dead' },
    '125': { text: '序號已使用', level: 'dead' },
    '135': { text: '驗證碼錯誤', level: 'dead' },
    '136': { text: '驗證碼已過期', level: 'dead' },
    '999': { text: '網路連線失敗', level: 'dead' },
  };

  const queueState = {
    attempts: 0,      // 排隊次數
    lastCode: null,   // 最後一次 errCode
    retryAt: 0,       // 下次重試的時間戳
    dead: false,      // 流程是否已中止
    localCheck: false,
  };

  let panelEl = null;
  let panelTimer = null;

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:70px', 'z-index:99999',
      'background:rgba(255,255,255,.97)', 'color:#222', 'padding:12px 14px',
      'border-radius:10px', 'font-size:13px', 'line-height:1.7', 'min-width:220px',
      'box-shadow:0 4px 16px rgba(0,0,0,.22)', 'pointer-events:none',
      'font-family:-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif',
      'border-left:5px solid #2196c9',
    ].join(';');
    document.body.appendChild(panelEl);
    return panelEl;
  }

  function renderPanel() {
    const el = ensurePanel();
    const info = ERR_CODES[queueState.lastCode] || null;
    const level = queueState.dead ? 'dead' : (info ? info.level : 'wait');
    const color = level === 'dead' ? '#d32f2f' : level === 'ok' ? '#2e7d32' : '#2196c9';
    el.style.borderLeftColor = color;

    // 用 DOM 組裝，避免把伺服器回傳的文字直接當 HTML
    el.textContent = '';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;margin-bottom:4px';
    title.textContent = `🎫 排隊狀態　${VERSION}`;
    el.appendChild(title);

    const addRow = (label, value, bold) => {
      const row = document.createElement('div');
      const k = document.createElement('span');
      k.style.color = '#888';
      k.textContent = label + '：';
      const v = document.createElement('span');
      if (bold) v.style.cssText = `font-weight:700;color:${color}`;
      v.textContent = value;
      row.appendChild(k); row.appendChild(v);
      el.appendChild(row);
    };

    if (queueState.dead) {
      addRow('狀態', '⛔ 流程已中止', true);
    } else if (queueState.lastCode === '00') {
      addRow('狀態', '✅ 已排到，鎖票中', true);
    } else {
      addRow('狀態', '⏳ 排隊中（不是被擋）', true);
    }
    addRow('已排隊', `${queueState.attempts} 次`);
    if (queueState.lastCode) {
      addRow('代碼', `${queueState.lastCode}　${info ? info.text : '未知代碼'}`);
    }
    if (queueState.localCheck) {
      addRow('備註', '伺服器要求重新確認票數');
    }

    if (!queueState.dead && queueState.retryAt > Date.now()) {
      const left = Math.ceil((queueState.retryAt - Date.now()) / 1000);
      addRow('下次重試', `${left} 秒後`);
    }

    if (queueState.dead) {
      const hint = document.createElement('div');
      hint.style.cssText = 'margin-top:6px;padding-top:6px;border-top:1px solid #eee;color:#d32f2f;font-weight:600';
      hint.textContent = '網站已停止排隊，需重新整理頁面才能再試';
      el.appendChild(hint);
    }
  }

  // 收到觀察器（inject.js）轉發的 API 回應
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__tpHelperNet !== true) return;

    if (d.kind === 'flag') {
      // window.isEnquene 被前端關掉 = 排隊流程中止
      if (d.isEnquene === false && queueState.attempts > 0 && queueState.lastCode !== '00') {
        queueState.dead = true;
        renderPanel();
      }
      return;
    }

    if (d.kind !== 'api' || d.api !== 'enqueue') return;

    const body = d.body || {};
    const code = String(body.errCode);
    queueState.attempts += 1;
    queueState.lastCode = code;
    queueState.localCheck = !!body.localCheck;

    if (code === '137') {
      // 137 才是「還在排隊」：waitSecond 沒給時前端用預設 15 秒
      queueState.dead = false;
      queueState.retryAt = Date.now() + (body.waitSecond || 15) * 1000;
    } else if (code === '00') {
      queueState.dead = false;
      queueState.retryAt = 0;
    } else {
      queueState.dead = true;
      queueState.retryAt = 0;
    }

    renderPanel();
    // 倒數期間每秒刷新一次
    clearInterval(panelTimer);
    panelTimer = setInterval(() => {
      if (queueState.dead || queueState.retryAt <= Date.now()) {
        clearInterval(panelTimer);
      }
      renderPanel();
    }, 1000);
  });

  // ===== 頁面判斷 + 主迴圈 =====
  function isTicketPage() {
    // 選票頁特徵：有「＋」按鈕且頁面含 NT. 價格（同意條款文字在下一步驟才出現，不能當條件）
    const hasPlus = $$('button').some((b) => visible(b) && b.querySelector('.mdi-plus'));
    const hasPrice = /NT\.?\s*\d/.test(document.body.innerText);
    return hasPlus && hasPrice;
  }

  function tick() {
    // 網址變了 → 視為換頁，重置執行旗標
    if (location.href !== lastUrl) {
      const wasConfirm = lastUrl.includes('/confirm/');
      lastUrl = location.href;
      doneFlags = { session: false, ticket: false };
      // 從「填寫資料」（/confirm/）退回「選擇票種」（/order/）
      // = 使用者按了取消購票或訂單逾時。此時要解除自動接續，
      // 否則會立刻又把票填回去、再按下一步，跟使用者的取消意圖對打。
      if (wasConfirm && location.pathname.startsWith('/order/')) {
        const wasArmed = settings.enabled || Date.now() <= manualUntil;
        manualUntil = 0;
        doneFlags.ticket = true; // 這次停留在選票頁期間不自動填票
        if (wasArmed) log('偵測到退回選票頁（取消購票），自動填票已暫停；要重跑請按「立即執行」或重新整理頁面');
      }
    }
    // 自動模式開啟、或「立即執行」的接續期限內才動作
    if (!settings.enabled && Date.now() > manualUntil) return;

    tickAgree(); // 同意條款：任何頁面步驟都監看

    if (isTicketPage()) {
      handleTicketPage();
    } else if (location.pathname.startsWith('/activity/')) {
      handleActivityPage();
    }
  }

  // 手動觸發（popup 按「立即執行」時送來）：
  // 把當下畫面能做的事都做完（勾同意條款 → 填票數 → 選場次），
  // 真的沒事可做才提示，不要誤報「不是選票頁」。
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'RUN_NOW') {
      doneFlags = { session: false, ticket: false };
      // 接下來 10 分鐘內自動接續後續頁面的流程（排隊購票可能耗時，視窗要夠長）
      manualUntil = Date.now() + 600000;
      loadSettings().then(() => {
        const didAgree = tickAgree();
        if (isTicketPage()) {
          handleTicketPage();
        } else if (location.pathname.startsWith('/activity/')) {
          handleActivityPage();
        } else if (!didAgree) {
          // 判斷同意條款是不是早就勾好了，給準確一點的訊息
          const checkedAgree = $$('input[type="checkbox"]').some((cb) => {
            const container = cb.closest('.v-input') || cb.parentElement;
            return cb.checked && textOf(container).includes('閱讀並同意');
          });
          if (checkedAgree) {
            log('同意條款已勾選，此畫面沒有其他可自動處理的項目');
          } else {
            log('此畫面沒有可自動處理的項目（票數、同意條款出現時會自動作用）');
          }
        }
      });
    }
  });

  function loadSettings() {
    return chrome.storage.sync.get(DEFAULT_SETTINGS).then((s) => {
      settings = s;
    });
  }

  // 設定變更即時生效
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') loadSettings();
  });

  loadSettings().then(() => {
    // 載入時自我回報，方便確認插件版本與狀態（console + DOM 標記）
    document.documentElement.setAttribute('data-tp-helper', VERSION);
    console.log(`[TicketPlus小幫手] ${VERSION} 已載入｜自動模式=${settings.enabled ? '開' : '關'}｜票種規則=${settings.ticketRules.replace(/\n/g, '、')}`);
    setInterval(tick, 500);
  });
})();
