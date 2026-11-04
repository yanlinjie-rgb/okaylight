/* OKAYLIGHT — page content overrides (managed from admin "装修" tab)
   Reads data/content.json (cid -> {en, zh}) and applies to [data-cid] nodes.
   Falls back silently when the file is missing (e.g. opened via file://). */
(function () {
  let DATA = null;
  function apply(l) {
    if (!DATA) return;
    document.querySelectorAll('[data-cid]').forEach(function (el) {
      const c = DATA[el.getAttribute('data-cid')];
      if (!c) return;
      const t = c[l] || c.en;
      if (t !== undefined && t !== '') el.innerHTML = String(t).replace(/\n/g, '<br>');
    });
  }
  async function init() {
    /* 优先读云端（Cloudflare Worker / 本地 node），失败回退静态 JSON */
    const src = (window.OKAY && window.OKAY.url) ? window.OKAY.url('/api/content') : 'data/content.json';
    try {
      let r = await fetch(src);
      if (!r.ok) r = await fetch('data/content.json');
      if (!r.ok) return;
      DATA = await r.json();
    } catch (e) {
      try {
        const r2 = await fetch('data/content.json');
        if (!r2.ok) return;
        DATA = await r2.json();
      } catch (e2) { return; }
    }
    apply(getLang());
    document.addEventListener('okaylang', function (e) { apply(e.detail); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
