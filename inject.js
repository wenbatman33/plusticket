// 售票表單填寫輔助 - 狀態讀取（在頁面主環境 MAIN world 執行）
//
// 用途：content script 跑在隔離環境，看不到頁面自己的 axios 請求，
// 所以這支在主環境掛鉤 XHR / fetch，把相關 API 的回應內容轉發給 content script 顯示。
//
// 重要：這裡「只讀不改」——不修改請求、不重送請求、不改變網站原有的
// 重試頻率或時間間隔，純粹把網站原本就在做的事顯示出來。

(() => {
  'use strict';

  // 只讀取流程相關端點的回應
  const WATCH = /\/(enqueue|reserve|release|update|confirm|getShippingFee|getUserCurrentReservedOrder)(\?|$)/;

  function report(payload) {
    try {
      window.postMessage({ __tpHelperNet: true, ...payload }, window.location.origin);
    } catch (e) { /* 忽略：不能因為觀察器出錯而影響購票 */ }
  }

  function handleResponse(url, status, text) {
    if (!url || !WATCH.test(url)) return;
    let body = null;
    try { body = JSON.parse(text); } catch (e) { return; }
    const m = url.match(/\/([a-zA-Z]+)(?:\?|$)/);
    report({ kind: 'api', api: m ? m[1] : url, httpStatus: status, body });
  }

  // ===== 掛鉤 XMLHttpRequest（axios 預設走這個）=====
  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;

  proto.open = function (method, url) {
    this.__tpUrl = url;
    return origOpen.apply(this, arguments);
  };

  proto.send = function () {
    this.addEventListener('load', () => {
      try { handleResponse(this.__tpUrl, this.status, this.responseText); } catch (e) {}
    });
    this.addEventListener('error', () => {
      // 網路層失敗：前端的 .catch 會把它變成 errCode 999
      if (this.__tpUrl && WATCH.test(this.__tpUrl)) {
        const m = this.__tpUrl.match(/\/([a-zA-Z]+)(?:\?|$)/);
        report({ kind: 'api', api: m ? m[1] : this.__tpUrl, httpStatus: 0, body: { errCode: '999' } });
      }
    });
    return origSend.apply(this, arguments);
  };

  // ===== 掛鉤 fetch（保險，網站若改用 fetch 也能讀取）=====
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      return origFetch.apply(this, arguments).then((res) => {
        if (url && WATCH.test(url)) {
          res.clone().text().then((t) => handleResponse(url, res.status, t)).catch(() => {});
        }
        return res;
      });
    };
  }

  // ===== 監看 window.isEnquene =====
  // 這是網站前端的處理總開關：一旦變成 false，後續所有 enqueue 請求
  // 都會在送出前被 `if(!window.isEnquene) return false` 擋下（等於流程已結束）。
  let lastFlag;
  setInterval(() => {
    const v = window.isEnquene;
    if (v !== lastFlag) {
      lastFlag = v;
      report({ kind: 'flag', isEnquene: v });
    }
  }, 400);
})();
