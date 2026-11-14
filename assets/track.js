/* OKAYLIGHT — 轻量访问统计埋点
   隐私说明：不使用 Cookie、不接第三方；仅在页面打开时上报一次。
   退出统计：任意页面加 ?nt=1（写入 localStorage，本浏览器永久停止上报）。 */
(function () {
  if (location.protocol === 'file:') return;

  /* 退出开关 */
  var qs = new URLSearchParams(location.search);
  if (qs.get('nt') === '1') { try { localStorage.setItem('ok_nt', '1'); } catch (e) {} }
  try { if (localStorage.getItem('ok_nt') === '1') return; } catch (e) {}

  /* 尊重浏览器 Do Not Track */
  var dnt = navigator.doNotTrack === '1' || window.doNotTrack === '1';
  if (dnt) return;

  var base = (window.OKAY && window.OKAY.api) || 'https://api.okaylightled.com';
  var url = base + '/api/track';

  /* 会话 ID：sessionStorage，空闲 30 分钟重置 */
  var KEY = 'ok_sid', TKEY = 'ok_sid_t', now = Date.now(), sid = '', last = 0;
  try { sid = sessionStorage.getItem(KEY) || ''; last = +(sessionStorage.getItem(TKEY) || 0); } catch (e) {}
  if (!sid || (now - last) > 30 * 60 * 1000) {
    sid = Math.random().toString(36).slice(2, 10) + now.toString(36);
  }
  try { sessionStorage.setItem(KEY, sid); sessionStorage.setItem(TKEY, String(now)); } catch (e) {}

  /* UTM 来源 */
  var utm = {};
  ['source', 'medium', 'campaign'].forEach(function (k) {
    var v = qs.get('utm_' + k);
    if (v) utm[k] = v;
  });

  /* 路径：去掉统计参数，保留 ?model= 之类业务参数 */
  var sp = new URLSearchParams(location.search);
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'nt', 'gclid', 'fbclid']
    .forEach(function (k) { sp.delete(k); });
  var q = sp.toString();
  var path = location.pathname + (q ? '?' + q : '');

  var body = JSON.stringify({
    path: path,
    title: document.title || '',
    ref: document.referrer || '',
    sid: sid,
    utm: utm,
    lang: navigator.language || ''
  });

  function send() {
    try {
      if (navigator.sendBeacon) {
        /* 必须 text/plain：beacon 无法完成 CORS 预检，application/json 会被静默丢弃 */
        navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
      } else {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: body,
          keepalive: true,
          mode: 'cors'
        }).catch(function () {});
      }
    } catch (e) {}
  }

  if (document.readyState === 'complete') setTimeout(send, 250);
  else window.addEventListener('load', function () { setTimeout(send, 250); });
})();
