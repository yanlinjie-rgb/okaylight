# OKAYLIGHT 上线部署手册

目标：把本地 `okaylight/` 目录部署成一个真正能用的企业站。

- 前台（HTML/CSS/JS/图片/规格书 PDF）→ **GitHub Pages**，免费，绑定自定义域名
- 后台数据（产品 / 文章 / 询价 / 上传文件）→ **Cloudflare Worker + D1**，免费、不会因闲置被暂停
- 域名 `www.okaylightled.com` → 万网已购，DNS 改用 Cloudflare 托管（橙云代理 + 自动 HTTPS）

---

## 0. 架构一览

```
访客 ──► Cloudflare（DNS + 代理 + HTTPS）
            │
            ├─► www.okaylightled.com  →  GitHub Pages（静态站点）
            └─► api.okaylightled.com  →  Cloudflare Worker
                                          ├─ D1（产品/文章/询价，JSON 与表）
                                          └─ R2 或 GitHub 仓库（PDF/图片）
```

为什么后台数据选 Cloudflare 而不是 Supabase / Railway / Render：
- **Supabase 免费版**：项目 7 天无活动会被自动暂停（要手动唤醒），不适合偶尔才来一条询价的 B2B 站。
- **Railway / Render 免费版**：同样会休眠、会冷启动慢，且 Render 免费层 2024 年起已收紧。
- **Cloudflare Worker / D1 / R2 免费版**：无休眠、无冷启动延迟、不因闲置被删；额度（Worker 10 万请求/天、D1 500 万行读/天、R2 10GB）对一个企业站完全够用。需要的是 Cloudflare 账号 + （仅 R2 需要）补一张卡作为计费凭证，**不开 R2 也能跑（见方案 B）**。

---

## 1. GitHub Pages（前台）

### 1.1 新建仓库并推代码

在 GitHub 新建一个公开仓库，例如 `okaylight`。

本地（在 `okaylight/` 目录里）：

```bash
cd C:/Users/Administrator/WorkBuddy/2026-10-27-14-35-44/okaylight
git init
git add .
git commit -m "OKAYLIGHT site: pages + cloudflare worker backend"
git branch -M main
git remote add origin https://github.com/yanlinjie-rgb/okaylight.git
git push -u origin main
```

> `.gitignore` 已经排除了 `server.js`、`tools/`、`template-*.html`、`data/config.json`、`data/inquiries.json`——这些是本地开发用的，不会上传到公开仓库，**密码不会被泄露**。

### 1.2 开启 Pages

仓库 → Settings → Pages：
- Source：**Deploy from a branch**
- Branch：`main` / root（根目录）/ Save

约 1 分钟后得到 `https://yanlinjie-rgb.github.io/okaylight/`。

### 1.3 绑定自定义域名

Settings → Pages → Custom domain：填 `www.okaylightled.com` → Save。
GitHub 会在仓库根创建 `CNAME` 文件（本项目已自带 `CNAME` 文件，内容就是 `www.okaylightled.com`）。

> 此时 GitHub 会提示 "Domain not configured for this site"——正常，DNS 还没指过来。先放着，做第 2 步。

---

## 2. Cloudflare（DNS + 代理 + Worker 后台）

### 2.1 添加站点 + 改 NS

> 新版 Cloudflare 控制台已把 "Add a site" 改名为 **「添加域 / Add a domain」**，且**不在账号首页**。
> 首页看不到按钮是正常的。两条路径任选：

**路径 A（最快，推荐）：直接用链接打开添加页**

浏览器地址栏输入并回车：

```
https://dash.cloudflare.com/?to=/:account/add-site
```

会直接跳到"添加站点/添加域"向导，跳过找按钮。

**路径 B（点菜单）**

1. 左侧菜单点 **「域名 / Domains」**
2. 点 **「概览 / Overview」**
3. 页面右上角点 **「添加域」**（旧版叫「添加站点」，英文 `Add a domain`）
   - ⚠️ 左侧「域名」下的 **「注册 / Registrations」是买新域名，不要点**——你不是要买，是要接入已有域名。

**向导里怎么填**

> 点完「添加域」会先出现三选一：**连接域名 / 转移域名 / 购买域名**。
> 选 **「连接域名」**（Connect a domain）——它是改 NS 接入，免费，域名注册仍在万网。
> 「转移域名」= 把注册商迁到 Cloudflare（要授权码、有 60 天锁），**不需要**；「购买域名」更不需要。

| 步骤 | 填什么 |
|---|---|
| 输入域名 | `okaylightled.com`（**不要**带 `www`、不要带 `https://`） |
| 选套餐 | 拉到最下面选 **Free / 免费** |
| 扫描 DNS | Cloudflare 会读你万网现有解析，列出来给你确认，直接 Continue |
| 拿 NS | 出现 "Change your nameservers"，给两个 `xxx.ns.cloudflare.com`，**抄下来** |

> **为什么填的是不带 www 的根域？**
> Cloudflare 的「站点 / 区域（Zone）」永远是根域 `okaylightled.com`；
> `www` 只是这个区域下的一条**子域名记录**（第 2.2 节再加）。
> 如果你填 `www.okaylightled.com`，Cloudflare 会提示"这是子域名，请先添加根域"。
> 最终对外访问地址仍然是 `https://www.okaylightled.com`，由 `www` 那条 CNAME 记录承担。

> **「导入 DNS 记录」一定要点开看一眼（重要）。**
> 如果 `okaylightled.com` 已经在用企业邮箱（例如 `sales@okaylightled.com`），万网里一定有 **MX 记录**。
> 改 NS 前必须把 MX 一起导入/保留，否则 NS 一切换，邮箱立刻收不到信。
> 没有企业邮箱则无所谓，直接继续。

> **新版「AI Search / 智能体 / 训练策略」怎么选**（都是可选，建好后随时能在控制台改）：
>
> | 项 | 建议 | 原因 |
> |---|---|---|
> | 搜索 | 允许（不阻止） | 让 AI 搜索能引用你的产品页，多一个曝光渠道 |
> | 训练 | 允许 或 阻止都行 | 不想内容被拿去训练模型就选阻止 |
> | 代理 | 允许 | 不影响正常访问 |
> | 我通过展示广告的页面获利 | **不勾** | 本站不放广告 |
> | Enable Bot Preference Sync | 建议**关** | 我们自带 `robots.txt`，避免 Cloudflare 再自动改写一遍造成困惑 |

然后：

4. 登录**万网（阿里云）域名控制台** → 域名 `okaylightled.com` → **DNS 修改** → 把原来的 `dns29/dns30.hichina.com` 换成 Cloudflare 给的两个 NS。
5. 回到 Cloudflare，点 **"Check nameservers"**。状态变 **Active** 才算接管成功（几分钟到几小时，最长 24h）。

### 2.2 DNS 记录

> **首次扫描显示「找到的记录：0」是正常的**（新域名在万网没配过解析）。
> 下面三条黄色提示（MX / www / 根域）只是建议，不是报错；区域未激活前加了也不生效。
> 这一步直接点 **「继续前往激活」** 去拿 NS，记录等状态变 Active 后再回来加。

NS 生效后，在 Cloudflare → DNS → Records 添加：

| 类型 | 名称 | 目标 | 代理状态 |
|---|---|---|---|
| CNAME | `@`（apex） | `yanlinjie-rgb.github.io` | 先 **DNS only（灰云）** |
| CNAME | `www` | `yanlinjie-rgb.github.io` | 先 **DNS only（灰云）** |
| CNAME | `api` | `okaylight-api.<你的子域>.workers.dev` | **Proxied（橙云）** |

> 说明：
> - Cloudflare 支持 apex 做 CNAME（CNAME flattening），所以 `@` 用 CNAME 是对的。
> - **先灰云**：让 GitHub Pages 自己签发 HTTPS 证书（Let's Encrypt，需要直接 HTTP 验证）。证书签发后再切橙云（见 2.4）。
> - `api` 这条先指向 workers.dev，等第 3 步给 Worker 绑定 `api.okaylightled.com` 自定义域后可改成 `okaylight-api` 别名（用 Worker custom domain 即可，DNS 记录由 Cloudflare 自动生成）。

### 2.3 SSL / 证书签发流程（重要，别跳）

1. DNS 设为**灰云**。
2. GitHub Pages → Settings → Pages，几分钟内会显示 "Certificate issued"（Let's Encrypt）。等它变绿。
3. 访问 `https://www.okaylightled.com` 能正常打开、锁图标正常 → 证书已生效。
4. 回 Cloudflare → SSL/TLS → Overview，把模式设为 **Full (strict)**。
5. DNS 把 `@` 和 `www` 切成 **橙云（Proxied）**。
6. Edge Certificates 里开启：
   - Always Use HTTPS：On
   - Automatic HTTPS Rewrites：On
   - HSTS：建议开启（启用前确认证书 OK）

> 坑：橙云开着的时候 GitHub 可能无法续签证书（每 ~3 个月一次）。如果续签失败，临时把 `@`、`www` 切回灰云，等 GitHub 续签完再切橙。也可以长期保持灰云（牺牲一点国内访问优化，但更省心）。

---

## 3. Cloudflare Worker（后台 API）

### 3.1 装 Wrangler（本地一次性）

```bash
cd C:/Users/Administrator/WorkBuddy/2026-10-27-14-35-44/okaylight/backend
npm install --no-save wrangler      # 或全局：npm i -g wrangler
npx wrangler login                 # 浏览器里授权 Cloudflare 账号
```

### 3.2 创建 D1 数据库

```bash
npx wrangler d1 create okaylight
```

输出会给你一个 `database_id`，把它填进 `backend/wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "okaylight"
database_id = "粘贴这里"
```

建表（可选，Worker 首次请求会自动建表；这里只是确认）：

```bash
npx wrangler d1 execute okaylight --remote --file=schema.sql
```

### 3.3 设置密钥（必须）

```bash
npx wrangler secret put ADMIN_PASSWORD     # 输入一个强密码（≥12 位，不要用默认值）
npx wrangler secret put AUTH_SECRET        # 随便一串长字符，例如 openssl rand -hex 32 的结果
```

可选（邮件通知询价）：

```bash
npx wrangler secret put RESEND_API_KEY     # resend.com 免费注册，3000 封/月
npx wrangler secret put NOTIFY_TO          # 接收询价的邮箱，如 sales@okaylightled.com
npx wrangler secret put NOTIFY_FROM        # 如 OKAYLIGHT <noreply@okaylightled.com>
```

> 邮件域需要在 Resend 验证 `okaylightled.com`（加一条 MX / TXT 记录）。不配也能跑，询价照常入库，只是不发邮件。

### 3.4 文件存储二选一

**方案 A（推荐）：R2**

1. Cloudflare 控制台 → R2 → 开通（需要补一张卡，免费额度 10GB 不收费）。
2. 建桶 `okaylight-files`。
3. 编辑 `wrangler.toml`，取消 `[[r2_buckets]]` 段注释：

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "okaylight-files"
```

**方案 B（不想绑卡）：存回 GitHub 仓库**

Worker 通过 GitHub API 把 PDF/图片提交到仓库的 `uploads/`，由 Pages 直接服务。

```bash
# 建 fine-grained PAT：只给 okaylight 仓库的 Contents: Read and Write 权限
npx wrangler secret put GITHUB_TOKEN        # 粘贴上面的 PAT
npx wrangler secret put GITHUB_REPO         # 你的用户名/okaylight，即 yanlinjie-rgb/okaylight
```

`wrangler.toml` 里的 `SITE_HOST` 已是 `www.okaylightled.com`，Worker 会把上传文件 URL 生成成 `https://www.okaylightled.com/uploads/xxx.pdf`。每次上传会触发 Pages 重新部署，约 1 分钟生效。

> 已有 `datasheets/` 下的 29 份示例 PDF 已在仓库里，Pages 直接服务，无需再上传——这两套只用于**后台上传的新文件**。

### 3.5 部署 Worker

```bash
cd backend
npx wrangler deploy
```

部署成功后得到一个 URL：`https://okaylight-api.<你的子域>.workers.dev`。

绑定自定义域：Cloudflare 控制台 → Workers & Pages → 你的 `okaylight-api` → Settings → Triggers → Custom Domains → Add → `api.okaylightled.com`。`wrangler.toml` 里已用 `[[custom_domains]]` 配好，部署时会自动绑定（需要 zone 在同一账号）。

健康检查：

```bash
curl https://api.okaylightled.com/api/health
# 期望：{"ok":true,"ts":"...","storage":"r2"}   或 "github"
```

### 3.6 把本地数据初始化进 D1

后台默认是空的。用一次性脚本把本地 29 条产品 + 装修内容灌进 D1：

```bash
cd C:/Users/Administrator/WorkBuddy/2026-10-27-14-35-44/okaylight
python - <<'PY'
import json, urllib.request
products=json.load(open('data/products.json',encoding='utf-8'))
content=json.load(open('data/content.json',encoding='utf-8'))
# 先登录拿 token
import getpass
pw=input('Admin password (你在 3.3 设的 ADMIN_PASSWORD): ')
req=urllib.request.Request('https://api.okaylightled.com/api/login',
    data=json.dumps({'password':pw}).encode(),
    headers={'Content-Type':'application/json'})
tok=json.load(urllib.request.urlopen(req))['token']
req=urllib.request.Request('https://api.okaylightled.com/api/seed',
    data=json.dumps({'products':products,'content':content}).encode(),
    headers={'Content-Type':'application/json','Authorization':'Bearer '+tok})
print(urllib.request.urlopen(req).read().decode())
PY
```

---

## 4. 验证清单

- [ ] `https://www.okaylightled.com` 打开首页，EN/繁中切换正常
- [ ] Products 页表格有 29 条，每行能查看/下载规格书 PDF
- [ ] News 页能打开（暂时无文章，显示提示）
- [ ] Contact 页提交一条询价 → 打开 `https://www.okaylightled.com/admin.html` 登录 → 询价收件箱能看到
- [ ] 后台 → 产品管理 → 新增一个型号 → 保存 → 刷新 Products 页能看到
- [ ] 后台 → 文章管理 → 新增一篇 published 文章 → 刷新 News 页能看到
- [ ] 后台 → 页面装修 → 改首页大标题 → 保存 → 刷新首页生效
- [ ] 后台 → 设置 → 改密码（默认 `okaylight2026` 必须改掉）
- [ ] `curl https://api.okaylightled.com/api/health` 返回 ok

---

## 5. API 速查

| 方法 | 路径 | 鉴权 | 作用 |
|---|---|---|---|
| GET | `/api/health` | 无 | 健康检查 / 存储模式 |
| GET | `/api/products` | 无 | 取全部产品 |
| POST | `/api/products/save` | 是 | `{list:[...]}` 保存 |
| GET | `/api/content` | 无 | 取装修文案 |
| POST | `/api/content/save` | 是 | 保存 |
| GET | `/api/articles` | 无 | 已发布文章 |
| GET | `/api/articles?all=1` | 是 | 全部（含草稿） |
| POST | `/api/articles/save` | 是 | 新建/更新 `{item}` |
| POST | `/api/articles/delete` | 是 | `{id}` |
| POST | `/api/inquiries` | 无 | 客户提交询价 |
| GET | `/api/inquiries` | 是 | 列表 |
| POST | `/api/inquiries/update` | 是 | `{id, action: read|unread|delete}` |
| POST | `/api/upload` | 是 | `{name, data(base64)}` → `{url}` |
| POST | `/api/login` | 无 | `{password}` → `{token}` |
| POST | `/api/password` | 是 | `{old, new}` |
| GET | `/files/<key>` | 无 | R2 文件直链 |

鉴权：登录拿到 token，后续请求带 `Authorization: Bearer <token>`，有效期 12 小时。
限流：询价 6 次/小时/IP，登录 8 次/15 分钟/IP。

---

## 6. 常见坑

| 现象 | 原因 / 解决 |
|---|---|
| Pages 自定义域名一直 "Not configured" | DNS 还没指到 GitHub，或 Cloudflare 代理挡住了 HTTP-01 校验 → 先灰云 |
| 浏览器提示 "Not Secure" / 525/526 | Cloudflare SSL 模式选了 Full 但 GitHub 证书还没签 → 等证书签发后再开橙云，或临时改 Flexible |
| 后台登录提示 "尝试次数过多" | 15 分钟内输错 8 次密码 → 等 15 分钟，或换 IP |
| 上传 PDF 报 "not a valid PDF" | 文件不是真的 PDF，或被改名扩展 |
| 上传报 "文件超过 10MB" | Worker 免费版限制；大文件先用 R2 直传或拆分 |
| 后台改了产品，前台没变 | 浏览器缓存 → 强刷（Ctrl+F5）；静态 JSON 兜底数据是旧的 |
| 询价邮件没收到 | 没配 RESEND_API_KEY / NOTIFY_TO，或域名没在 Resend 验证；询价本身已入库 |

---

## 7. 本地开发模式（不影响线上）

```bash
cd okaylight
node server.js            # http://localhost:8080
```

`assets/config.js` 自动检测：localhost / file:// 时 API 走同源（即本地 node server），线上走 `https://api.okaylightled.com`。所以同一套代码本地、线上都能跑，不用改。

---

## 8. 文件清单

```
okaylight/
├── index.html  products.html  why-us.html  about.html  news.html  contact.html
├── 404.html  robots.txt  sitemap.xml  CNAME  .nojekyll  .gitignore
├── logo.png
├── assets/  style.css  i18n.js  content.js  config.js
├── data/    products.json  content.json        # 静态兜底（config.json/inquiries.json 已 gitignore）
├── datasheets/  *.pdf                          # 29 份示例规格书
├── backend/ worker.js  wrangler.toml  schema.sql
├── server.js  tools/  template-*.html          # 本地开发用，已 gitignore
└── DEPLOY.md  （本文件）
```

需要告诉我（部署时一次性确认）：
- GitHub 用户名 / 仓库名（用于 CNAME 目标和 GitHub 存储模式）
- 真实公司邮箱 / 电话 / 地址（目前是占位，可在后台「页面装修」直接改，无需改代码）
- 是否要邮件通知询价（决定要不要配 Resend）
