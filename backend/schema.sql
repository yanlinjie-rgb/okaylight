-- OKAYLIGHT D1 schema（worker 首次请求会自动建表；此文件用于手动预建 / 迁移）
CREATE TABLE IF NOT EXISTS kv (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inquiries (
  id       TEXT PRIMARY KEY,
  ts       TEXT NOT NULL,
  name     TEXT,
  company  TEXT,
  email    TEXT,
  interest TEXT,
  msg      TEXT,
  page     TEXT,
  lang     TEXT,
  read     INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS articles (
  id         TEXT PRIMARY KEY,
  ts         TEXT NOT NULL,
  updated    TEXT,
  slug       TEXT,
  state      TEXT DEFAULT 'draft',
  title_en   TEXT, title_zh   TEXT,
  excerpt_en TEXT, excerpt_zh TEXT,
  body_en    TEXT, body_zh    TEXT,
  cover      TEXT
);

CREATE TABLE IF NOT EXISTS rate_limit (
  k        TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inq_ts ON inquiries(ts DESC);
CREATE INDEX IF NOT EXISTS idx_art_ts ON articles(ts DESC);
