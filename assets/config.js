/* OKAYLIGHT — 运行环境配置
   本地开发（localhost / 直接双击 html）走同源，由 node server.js 提供接口；
   线上（GitHub Pages）走 Cloudflare Worker。 */
(function () {
  var host = location.hostname;
  var isLocal = location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1' || host === '' ||
                /^192\.168\./.test(host) || /^10\./.test(host);

  window.OKAY = window.OKAY || {};
  window.OKAY.api = isLocal ? '' : 'https://api.okaylightled.com';
  window.OKAY.site = isLocal ? (location.origin || '') : 'https://www.okaylightled.com';
  window.OKAY.url = function (path) { return (window.OKAY.api || '') + path; };
})();
