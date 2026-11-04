/**
 * OKAYLIGHT API — Cloudflare Worker (零依赖，单文件)
 *
 * 作用：给 GitHub Pages 上的静态站点提供后台能力
 *   · 产品型号 / 页面文案 / 文章  → 存在 Cloudflare D1（免费 5GB，不会闲置暂停）
 *   · 规格书 PDF / 图片          → 存 R2（免费 10GB）或直接提交回 GitHub 仓库
 *   · 客户询价                    → 存 D1，可选邮件通知（Resend 免费额度）
 *
 * 部署：见 ../DEPLOY.md
 */

const JSON_TYPE = "application/json; charset=utf-8";
const MAX_UPLOAD = 10 * 1024 * 1024; // 10MB，免费版 Worker 单请求 CPU/内存有限
const TOKEN_TTL = 12 * 60 * 60 * 1000; // 12 小时

const enc = new TextEncoder();

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */
function jsonOut(obj, status = 200, cors = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": JSON_TYPE, "Cache-Control": "no-store", ...cors },
  });
}

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allow = String(env.ALLOWED_ORIGINS || "https://www.okaylightled.com,https://okaylightled.com")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const ok = isLocal || allow.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allow[0] || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function b64url(bytes) {
  let s = "";
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64std(bytes) {
  let s = "";
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s); // 标准 base64（GitHub Contents API 需要）
}

function b64ToBytes(b64) {
  let clean = String(b64).replace(/^data:[^;]+;base64,/, "").replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "");
  const pad = clean.length % 4;
  if (pad === 2) clean += "==";
  else if (pad === 3) clean += "=";
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

function safeName(name) {
  return String(name || "file").replace(/[^\w.\-() ]+/g, "_").slice(0, 80);
}

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/* ------------------------------------------------------------------ *
 * 数据库：建表（每个 isolate 只跑一次） + 键值读写
 * ------------------------------------------------------------------ */
let schemaReady = null;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS inquiries (
     id TEXT PRIMARY KEY, ts TEXT NOT NULL, name TEXT, company TEXT, email TEXT,
     interest TEXT, msg TEXT, page TEXT, lang TEXT, read INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS articles (
     id TEXT PRIMARY KEY, ts TEXT NOT NULL, updated TEXT, slug TEXT, state TEXT DEFAULT 'draft',
     title_en TEXT, title_zh TEXT, excerpt_en TEXT, excerpt_zh TEXT,
     body_en TEXT, body_zh TEXT, cover TEXT)`,
  `CREATE TABLE IF NOT EXISTS rate_limit (k TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_inq_ts ON inquiries(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_art_ts ON articles(ts DESC)`,
];

function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of SCHEMA) await env.DB.prepare(sql).run();
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

async function kvGet(env, key, fallback) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(key).first();
  if (!row) return fallback;
  try { return JSON.parse(row.v); } catch (e) { return fallback; }
}

async function kvPut(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at"
  ).bind(key, JSON.stringify(value), new Date().toISOString()).run();
}

async function rateLimit(env, key, max, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT count, reset_at FROM rate_limit WHERE k = ?").bind(key).first();
  if (!row || row.reset_at < now) {
    await env.DB.prepare(
      "INSERT INTO rate_limit (k, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET count = 1, reset_at = excluded.reset_at"
    ).bind(key, now + windowSec).run();
    return { ok: true };
  }
  if (row.count >= max) return { ok: false, retryAfter: row.reset_at - now };
  await env.DB.prepare("UPDATE rate_limit SET count = count + 1 WHERE k = ?").bind(key).run();
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 鉴权：密码 = 加盐 SHA-256，令牌 = HMAC 签名 + 过期时间
 * ------------------------------------------------------------------ */
async function passwordRecord(env) {
  let rec = await kvGet(env, "admin_pw", null);
  if (!rec) {
    const init = String(env.ADMIN_PASSWORD || "okaylight2026");
    rec = await makePassword(init);
    await kvPut(env, "admin_pw", rec);
  }
  return rec;
}

async function makePassword(pw) {
  const salt = b64url(crypto.getRandomValues(new Uint8Array(12)));
  return { salt, hash: await sha256hex(salt + ":" + pw) };
}

async function tokenFor(env, ttl = TOKEN_TTL) {
  const exp = Date.now() + ttl;
  const sig = await hmac(env.AUTH_SECRET || "dev-secret-change-me", String(exp));
  return { token: exp + "." + sig, exp };
}

async function isAuthed(req, env) {
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(\d+)\.(.+)$/);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!exp || exp < Date.now()) return false;
  const expect = await hmac(env.AUTH_SECRET || "dev-secret-change-me", m[1]);
  return expect === m[2];
}

/* ------------------------------------------------------------------ *
 * 文件存储：优先 R2；未绑定则提交回 GitHub 仓库（uploads/）
 * ------------------------------------------------------------------ */
const MIME_BY_EXT = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
};

function storageMode(env) {
  if (env.BUCKET) return "r2";
  if (env.GITHUB_TOKEN && env.GITHUB_REPO) return "github";
  return "none";
}

async function saveFile(env, origin, name, b64) {
  const safe = safeName(name);
  const ext = ("." + (safe.split(".").pop() || "")).toLowerCase();
  const type = MIME_BY_EXT[ext];
  if (!type) throw new Error("只允许 PDF / PNG / JPG / WEBP / SVG");
  const bytes = b64ToBytes(b64);
  if (!bytes.length) throw new Error("文件为空");
  if (bytes.length > MAX_UPLOAD) throw new Error("文件超过 10MB");
  if (ext === ".pdf" && String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") throw new Error("不是有效的 PDF");

  const folder = ext === ".pdf" ? "datasheets" : "images";
  const key = folder + "/" + Date.now().toString(36) + "-" + safe;

  const mode = storageMode(env);
  if (mode === "r2") {
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
    return { url: origin + "/files/" + key, key, storage: "r2" };
  }
  if (mode === "github") {
    const api = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/uploads/${key.split("/").pop()}`;
    const res = await fetch(api, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + env.GITHUB_TOKEN,
        "User-Agent": "okaylight-cms",
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "upload: " + key,
        content: b64std(bytes),
        branch: env.GITHUB_BRANCH || "main",
      }),
    });
    if (!res.ok) throw new Error("GitHub 上传失败：HTTP " + res.status + " " + (await res.text()).slice(0, 200));
    const host = env.SITE_HOST || "www.okaylightled.com";
    return { url: `https://${host}/uploads/${key.split("/").pop()}`, key, storage: "github" };
  }
  throw new Error("未配置文件存储：请绑定 R2 桶，或设置 GITHUB_TOKEN / GITHUB_REPO");
}

async function serveFile(env, key) {
  if (!env.BUCKET) return new Response("Not found", { status: 404 });
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("ETag", obj.httpEtag);
  h.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers: h });
}

/* ------------------------------------------------------------------ *
 * 询价邮件通知（可选，未配置 Resend 就静默跳过）
 * ------------------------------------------------------------------ */
async function notifyInquiry(env, item) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_TO) return;
  const html = `<h3>新询价 · OKAYLIGHT</h3>
    <p><b>${escapeHtml(item.name)}</b>${item.company ? " · " + escapeHtml(item.company) : ""}</p>
    <p>Email: ${escapeHtml(item.email)}<br>Interested in: ${escapeHtml(item.interest || "-")}<br>
    Time: ${item.ts}<br>Page: ${escapeHtml(item.page || "-")}</p>
    <pre style="white-space:pre-wrap;font:14px/1.6 monospace">${escapeHtml(item.msg)}</pre>`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.NOTIFY_FROM || "OKAYLIGHT <noreply@okaylightled.com>",
        to: [env.NOTIFY_TO],
        subject: "[OKAYLIGHT] New enquiry from " + item.name,
        html,
      }),
    });
  } catch (e) { /* 邮件失败不影响询价入库 */ }
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = corsHeaders(req, env);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (path.startsWith("/files/")) {
      const res = await serveFile(env, decodeURIComponent(path.slice(7)));
      return res;
    }

    if (path === "/" || path === "/api") {
      return jsonOut({ name: "OKAYLIGHT API", ok: true, docs: "/api/health" }, 200, cors);
    }

    if (!path.startsWith("/api/")) return jsonOut({ error: "not found" }, 404, cors);

    try {
      await ensureSchema(env);
      const out = await route(req, env, ctx, path, url);
      const body = await out.text();
      return new Response(body, { status: out.status, headers: { ...Object.fromEntries(out.headers), ...cors } });
    } catch (e) {
      return jsonOut({ error: e.message || String(e) }, 500, cors);
    }
  },
};

async function route(req, env, ctx, path, url) {
  const method = req.method;
  const ip = req.headers.get("CF-Connecting-IP") || "0.0.0.0";

  /* ---------- 健康检查 ---------- */
  if (path === "/api/health") {
    return jsonOut({ ok: true, ts: new Date().toISOString(), storage: storageMode(env) });
  }

  /* ---------- 公开接口 ---------- */
  if (path === "/api/products" && method === "GET") {
    return jsonOut(await kvGet(env, "products", []));
  }
  if (path === "/api/content" && method === "GET") {
    return jsonOut(await kvGet(env, "content", {}));
  }
  if (path === "/api/articles" && method === "GET") {
    const all = url.searchParams.get("all") === "1" && (await isAuthed(req, env));
    const sql = all
      ? "SELECT * FROM articles ORDER BY ts DESC"
      : "SELECT id, ts, slug, title_en, title_zh, excerpt_en, excerpt_zh, cover FROM articles WHERE state = 'published' ORDER BY ts DESC";
    const r = await env.DB.prepare(sql).all();
    return jsonOut(r.results || []);
  }

  if (path === "/api/inquiries" && method === "POST") {
    const limit = await rateLimit(env, "inq:" + ip, 6, 3600);
    if (!limit.ok) return jsonOut({ error: "提交过于频繁，请稍后再试" }, 429);
    const b = await req.json().catch(() => ({}));
    const item = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      name: String(b.name || "").slice(0, 200),
      company: String(b.company || "").slice(0, 200),
      email: String(b.email || "").slice(0, 200),
      interest: String(b.interest || "").slice(0, 200),
      msg: String(b.msg || "").slice(0, 5000),
      page: String(b.page || "").slice(0, 300),
      lang: String(b.lang || "").slice(0, 8),
      read: 0,
    };
    if (!item.name || !item.email || !item.msg) return jsonOut({ error: "missing fields" }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(item.email)) return jsonOut({ error: "invalid email" }, 400);
    await env.DB.prepare(
      "INSERT INTO inquiries (id, ts, name, company, email, interest, msg, page, lang, read) VALUES (?,?,?,?,?,?,?,?,?,0)"
    ).bind(item.id, item.ts, item.name, item.company, item.email, item.interest, item.msg, item.page, item.lang).run();
    ctx.waitUntil(notifyInquiry(env, item));
    return jsonOut({ ok: true, id: item.id });
  }

  /* ---------- 登录 ---------- */
  if (path === "/api/login" && method === "POST") {
    const limit = await rateLimit(env, "login:" + ip, 8, 900);
    if (!limit.ok) return jsonOut({ error: "尝试次数过多，请 15 分钟后再试" }, 429);
    const b = await req.json().catch(() => ({}));
    const rec = await passwordRecord(env);
    const hash = await sha256hex(rec.salt + ":" + String(b.password || ""));
    if (hash !== rec.hash) return jsonOut({ error: "wrong password" }, 401);
    const t = await tokenFor(env);
    return jsonOut({ ok: true, token: t.token, exp: t.exp });
  }

  /* ---------- 以下全部需要登录 ---------- */
  if (!(await isAuthed(req, env))) return jsonOut({ error: "unauthorized" }, 401);

  if (path === "/api/inquiries" && method === "GET") {
    const r = await env.DB.prepare("SELECT * FROM inquiries ORDER BY ts DESC LIMIT 1000").all();
    return jsonOut((r.results || []).map((x) => ({ ...x, read: !!x.read })));
  }

  if (path === "/api/inquiries/update" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (!b.id) return jsonOut({ error: "missing id" }, 400);
    if (b.action === "delete") {
      await env.DB.prepare("DELETE FROM inquiries WHERE id = ?").bind(b.id).run();
    } else if (b.action === "unread") {
      await env.DB.prepare("UPDATE inquiries SET read = 0 WHERE id = ?").bind(b.id).run();
    } else {
      await env.DB.prepare("UPDATE inquiries SET read = 1 WHERE id = ?").bind(b.id).run();
    }
    return jsonOut({ ok: true });
  }

  if (path === "/api/products/save" && method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || !Array.isArray(b.list)) return jsonOut({ error: "expected {list:[...]}" }, 400);
    const clean = b.list.map((p) => ({
      cat: String(p.cat || "led").slice(0, 20),
      model: String(p.model || "").slice(0, 80),
      pkg: String(p.pkg || "").slice(0, 80),
      spec: String(p.spec || "").slice(0, 200),
      detail: String(p.detail || "").slice(0, 300),
      ds: String(p.ds || "").slice(0, 300),
    })).filter((p) => p.model);
    await kvPut(env, "products", clean);
    return jsonOut({ ok: true, count: clean.length });
  }

  if (path === "/api/content/save" && method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b)) return jsonOut({ error: "expected object" }, 400);
    await kvPut(env, "content", b);
    return jsonOut({ ok: true });
  }

  if (path === "/api/upload" && method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || !b.name || !b.data) return jsonOut({ error: "expected {name, data(base64)}" }, 400);
    const origin = new URL(req.url).origin;
    const saved = await saveFile(env, origin, b.name, b.data);
    return jsonOut({ ok: true, ...saved });
  }

  if (path === "/api/password" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    const rec = await passwordRecord(env);
    const oldHash = await sha256hex(rec.salt + ":" + String(b.old || ""));
    if (oldHash !== rec.hash) return jsonOut({ error: "old password wrong" }, 400);
    if (String(b.new || "").length < 8) return jsonOut({ error: "新密码至少 8 位" }, 400);
    await kvPut(env, "admin_pw", await makePassword(String(b.new)));
    return jsonOut({ ok: true });
  }

  /* ---------- 文章 ---------- */
  if (path === "/api/articles/save" && method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || !b.item) return jsonOut({ error: "expected {item}" }, 400);
    const it = b.item;
    const id = String(it.id || crypto.randomUUID());
    const now = new Date().toISOString();
    const slug = slugify(it.slug) || slugify(it.title_en) || id.slice(0, 8);
    const row = {
      id, ts: it.ts || now, updated: now, slug,
      state: it.state === "published" ? "published" : "draft",
      title_en: String(it.title_en || "").slice(0, 200),
      title_zh: String(it.title_zh || "").slice(0, 200),
      excerpt_en: String(it.excerpt_en || "").slice(0, 400),
      excerpt_zh: String(it.excerpt_zh || "").slice(0, 400),
      body_en: String(it.body_en || "").slice(0, 20000),
      body_zh: String(it.body_zh || "").slice(0, 20000),
      cover: String(it.cover || "").slice(0, 300),
    };
    await env.DB.prepare(
      `INSERT INTO articles (id, ts, updated, slug, state, title_en, title_zh, excerpt_en, excerpt_zh, body_en, body_zh, cover)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET updated=excluded.updated, slug=excluded.slug, state=excluded.state,
         title_en=excluded.title_en, title_zh=excluded.title_zh, excerpt_en=excluded.excerpt_en,
         excerpt_zh=excluded.excerpt_zh, body_en=excluded.body_en, body_zh=excluded.body_zh, cover=excluded.cover`
    ).bind(row.id, row.ts, row.updated, row.slug, row.state, row.title_en, row.title_zh,
      row.excerpt_en, row.excerpt_zh, row.body_en, row.body_zh, row.cover).run();
    return jsonOut({ ok: true, item: row });
  }

  if (path === "/api/articles/delete" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (!b.id) return jsonOut({ error: "missing id" }, 400);
    await env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(b.id).run();
    return jsonOut({ ok: true });
  }

  /* ---------- 一次性导入（把本地 JSON 推进 D1，部署时用） ---------- */
  if (path === "/api/seed" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (Array.isArray(b.products) && b.products.length) await kvPut(env, "products", b.products);
    if (b.content && typeof b.content === "object") await kvPut(env, "content", b.content);
    return jsonOut({ ok: true, products: Array.isArray(b.products) ? b.products.length : 0 });
  }

  return jsonOut({ error: "unknown api" }, 404);
}
