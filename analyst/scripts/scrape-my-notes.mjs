// 小红书自有账号数据采集器（creator-retro-analyst · 阶段 1）v1.1
// 用法：先写任务文件 /tmp/xhs-analyst-task.json，然后：
//   ego-browser nodejs < <skill-dir>/scripts/scrape-my-notes.mjs
//
// 任务文件 schema：
// {
//   "outDir": "/abs/path/vault/小红书运营/数据",  // 产出目录（必填，缺省 /tmp/xhs-analyst-out）
//   "maxNotes": 100,                              // 最多保留笔记数（默认 100）
//   "detailCount": 6,                             // 打开详情页补全正文的笔记数（默认 6：赞 top3+bottom3）
//   "profileUrl": "https://www.xiaohongshu.com/user/profile/<id>"  // 可选，跳过 userId 探测
// }
//
// 产出：<outDir>/<YYYY-MM-DD>-snapshot.json（唯一产出，模型据此分析）+ covers-*/（封面）+ covers-index.json
//
// v1.1（2026-10-12 全量探索后重写，API 目录见 references/creator-recipe.md 校准记录）：
//   A) 创作者中心四页直连（首页→账号概览→粉丝数据→笔记管理），拦截应用自身 XHR：
//      - 首页 /new/home：note_detail_new（近7/30日全指标+日粒度+环比）+ personal_info（权威粉丝数）
//      - 账号概览 /statistics/account/v2：受众活跃时段 + 流量来源
//      - 粉丝数据 /statistics/fans-data：涨粉趋势 + 铁粉榜 + 粉丝画像（性别/年龄/城市/兴趣）
//      - 笔记管理 /new/note-manager：posted API 滚动翻页（曝光/赞/藏/评/享/封面）
//   B) 内容分析 analyze/list（阅读数，默认近30天窗口）随页面访问自动拦截
//   C) 个人主页公开数据（www 登录时）→ D) 详情页正文/话题（赞 top3+bottom3）
// 已知约束（实测）：creator API 需站点签名，page.fetch 直调一律 406 —— 全部数据靠「页面加载+滚动让应用自己请求」再拦截响应。
// 多级降级：creator 未登录但 www 已登录时降到 C 级；两者都未登录才报 not-logged-in 退出。
// 失败不抛异常，summary 带 source/degraded/stages 字段，由调用方决定降级。
// 纪律（见 SKILL.md 硬规则）：只读，不点赞不收藏不关注；失败不连刷。
// 平台守卫：Windows 上无 Ego Lite，直接退出并给出指引。
if (process.platform !== "darwin") {
  console.error(
    "平台不支持：本脚本仅支持 macOS（依赖 Ego Lite 的 ego-browser CLI）。Windows 上需登录态的浏览器操作，请改走 ego-browser skill 的 Windows path 章节（接管用户 Chrome 复用登录态），见 ~/.agents/skills/ego-browser/SKILL.md。"
  );
  process.exit(1);
}
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const TASK_PATH = "/tmp/xhs-analyst-task.json";
const taskDef = JSON.parse(await readFile(TASK_PATH, "utf8").catch(() => "{}"));
const OUT = resolve(taskDef.outDir || "/tmp/xhs-analyst-out");
const maxNotes = taskDef.maxNotes ?? 100;
const detailCount = taskDef.detailCount ?? 6;
await mkdir(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const d = new Date();
const pad = (n) => String(n).padStart(2, "0");
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// "1.2万" / "3w" / "8421" → 数字
function parseCount(s) {
  if (s == null) return null;
  const t = String(s).trim().replace(/[+,]/g, "");
  const m = t.match(/^([\d.]+)\s*([万wW])?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  return m[2] ? Math.round(n * 10000) : Math.round(n);
}

const stages = [];
const apiNotes = [];
const apiSamples = [];
const tableRows = [];
const textDumps = {};
const profileNotes = [];
const account = {};
const overview = { noteDetailNew: null, accountBase: null };
const fans = { overall: null, active: null, portrait: null, source: null };
const audience = { viewPeriods: null, sourceAccount: null };
const analyzeMeta = { total: null, windows: [] };
let creatorOk = false;
let wwwOk = false;

const task = await taskSpace("xhs self analytics");
console.log(JSON.stringify({ log: "space", spaceId: task.spaceId }));
const page = task.page("p1");
await page.cdp("Network.enable").catch(() => {});

// 从 cookie 拿 userId（x-user-id-creator.xiaohongshu.com 的值即用户 id，即使会话过期 id 仍有效）
async function userIdFromCookie() {
  try {
    const c = await page.cdp("Network.getCookies", { urls: ["https://creator.xiaohongshu.com", "https://www.xiaohongshu.com"] });
    const hit = (c.cookies || []).find((x) => x.name === "x-user-id-creator.xiaohongshu.com");
    return hit && /^[0-9a-f]{24}$/.test(hit.value) ? hit.value : null;
  } catch (e) {
    return null;
  }
}

// 后端序列化噪音键（set_* 标志位 / *_size / *_iterator 重复体 / *_rate_display 展示开关）
function distill(node, depth = 0) {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.slice(0, 40).map((v) => distill(v, depth + 1));
  if (depth > 6) return "[…]";
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (/^set_/.test(k) || /_(size|iterator)$/.test(k) || /_rate_display$/.test(k) || k === "result" || k === "color") continue;
    out[k] = distill(v, depth + 1);
  }
  return out;
}

// ---------- 创作者平台 API 响应收集与分发 ----------
// 字段映射以 2026-10-12 探索实录为准（creator-recipe.md 校准记录）：
//   曝光 impressions = imp_count（analyze 层）/ impl_count（account 层）——只认 imp 系字段
//   阅读 reads       = read_count（analyze 层）/ view_count（posted 层，**语义是「观看」不是曝光**，
//                      10-12 实测与 read_count 逐篇相等；10-07 校准把 view_count 标成曝光是错的）
//   收藏 collects    = collected_count(posted) / fav_count(analyze)
//   涨粉 newFollowers = increase_fans_count / rise_fans_count（analyze 层部分笔记携带，常缺省）
function harvest(node, out, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return;
  if (Array.isArray(node)) {
    for (const it of node) harvest(it, out, depth + 1);
    return;
  }
  const title = node.title ?? node.displayTitle ?? node.display_title ?? node.noteTitle ?? node.note_title;
  const id = node.noteId ?? node.note_id ?? node.id;
  const num = (...keys) => {
    for (const k of keys) {
      const v = node[k];
      if (typeof v === "number") return v;
      if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v.replace(/[+,]/g, "")))) return parseCount(v);
    }
    return null;
  };
  if (typeof title === "string" && title.trim().length > 1) {
    const idOk = typeof id === "string" && /^[0-9a-f]{24}$/.test(id);
    const metrics = {
      impressions: num("imp_count", "impl_count", "impression", "impress"),
      reads: num("read_count", "readCount", "view_count", "viewCount"),
      likes: num("likeCount", "like_count", "likedCount", "like", "likes"),
      collects: num("favCount", "fav_count", "collected_count", "collect_count", "collected", "collect"),
      comments: num("commentCount", "comments_count", "comment_count", "comment"),
      shares: num("shareCount", "shared_count", "share_count", "share"),
      newFollowers: num("increase_fans_count", "rise_fans_count", "new_fans_count"),
    };
    const hasMetric = Object.values(metrics).some((v) => v != null);
    if (idOk || hasMetric) {
      let pub = node.time ?? node.publishTime ?? node.publish_time ?? node.createTime ?? null;
      if (typeof pub === "number" && pub > 1e12) pub = new Date(pub).toISOString().slice(0, 16).replace("T", " ");
      else if (typeof pub === "number" && pub > 1e9) pub = new Date(pub * 1000).toISOString().slice(0, 16).replace("T", " ");
      const token = typeof node.xsec_token === "string" ? node.xsec_token : null;
      let coverRaw =
        node.cover?.url ?? node.coverUrl ?? (Array.isArray(node.images_list) ? node.images_list?.[0]?.url : null) ?? node.cover_url ?? null;
      if (typeof coverRaw === "string") coverRaw = coverRaw.replace(/^http:\/\//, "https://"); // 混合内容会被浏览器拦截，CDN 支持 https
      out.push({
        id: typeof id === "string" ? id : null,
        title: title.trim(),
        type: typeof node.type === "string" ? node.type : null,
        publishedAt: pub,
        ...metrics,
        sticky: node.sticky === true ? true : null,
        permission: typeof node.permission_msg === "string" && node.permission_msg ? node.permission_msg : null,
        coverUrl: typeof coverRaw === "string" ? (coverRaw.startsWith("//") ? "https:" + coverRaw : coverRaw) : null,
        noteUrl:
          typeof id === "string" && /^[0-9a-f]{24}$/.test(id)
            ? `https://www.xiaohongshu.com/explore/${id}${token ? `?xsec_token=${token}&xsec_source=pc_creatormng` : ""}`
            : null,
      });
      if (out.length > 300) return;
    }
  }
  for (const v of Object.values(node)) harvest(v, out, depth + 1);
}

// 噪音 API（风控/监控/埋点/无关运营位），拦截时直接跳过
const NOISE_URL =
  /as\.xiaohongshu|apm-fe|t2\.xiaohongshu|racing|captcha|sec\/v1|shield|rightscenter|leaderboard|activity_center|\/notice\?|\/notice$|authortask|create_guidance|select\/topic|livedata|sbtsource|\/api\/v2\/collect|user\/video|permission\/query/;

async function drainApi(tag) {
  try {
    const evs = await page.events();
    const reqMeta = new Map();
    for (const e of evs) {
      if (e.method === "Network.requestWillBeSent") {
        reqMeta.set(e.params.requestId, { method: e.params.request?.method, postData: e.params.request?.postData });
      }
    }
    for (const e of evs) {
      if (e.method !== "Network.responseReceived") continue;
      const url = e.params?.response?.url || "";
      if (!/creator\.xiaohongshu\.com\/api\/galaxy/.test(url) || NOISE_URL.test(url)) continue;
      let json = null;
      try {
        const b = await page.cdp("Network.getResponseBody", { requestId: e.params.requestId });
        json = JSON.parse(typeof b === "string" ? b : b.body);
      } catch (e2) {
        continue; // 非 JSON 或 body 已释放
      }
      // 分发到专项收集器（distill 去噪后整体入库），其余走通用笔记收割
      if (/note\/user\/posted/.test(url)) {
        harvest(json, apiNotes);
        sample(url, json);
      } else if (/note\/analyze\/list/.test(url)) {
        const before = apiNotes.length;
        harvest(json, apiNotes);
        analyzeMeta.total = json?.data?.total ?? analyzeMeta.total;
        const b = url.match(/post_begin_time=(\d+)/)?.[1];
        const t = url.match(/post_end_time=(\d+)/)?.[1];
        if (b && t) {
          const w = `${new Date(Number(b)).toISOString().slice(0, 10)}~${new Date(Number(t)).toISOString().slice(0, 10)}`;
          if (!analyzeMeta.windows.includes(w)) analyzeMeta.windows.push(w);
        }
        sample(url, json);
        console.log(JSON.stringify({ log: "analyze-list", got: apiNotes.length - before }));
      } else if (/data\/note_detail_new/.test(url)) {
        overview.noteDetailNew = distill(json?.data) ?? overview.noteDetailNew;
      } else if (/datacenter\/account\/base/.test(url)) {
        overview.accountBase = distill(json?.data) ?? overview.accountBase;
      } else if (/home\/personal_info/.test(url)) {
        const dd = json?.data ?? {};
        if (typeof dd.fans_count === "number") account.followers = dd.fans_count;
        if (typeof dd.follow_count === "number") account.follows = dd.follow_count;
        if (typeof dd.faved_count === "number") account.totalLikes = dd.faved_count;
        if (dd.grow_info?.level != null) account.growLevel = dd.grow_info.level;
      } else if (/fans\/overall_new/.test(url)) {
        fans.overall = distill(json?.data) ?? fans.overall;
      } else if (/active_fans_new/.test(url)) {
        fans.active = distill(json?.data) ?? fans.active;
      } else if (/fans_portrait_new/.test(url)) {
        fans.portrait = distill(json?.data) ?? fans.portrait;
      } else if (/fans_source/.test(url)) {
        fans.source = distill(json?.data) ?? fans.source;
      } else if (/audience\/view\/periods/.test(url)) {
        audience.viewPeriods = distill(json?.data) ?? audience.viewPeriods;
      } else if (/audience\/source\/account/.test(url)) {
        audience.sourceAccount = distill(json?.data) ?? audience.sourceAccount;
      } else {
        harvest(json, apiNotes); // 未分类 galaxy API：宽松收割，字段映射靠 apiSamples 核对
        sample(url, json);
      }
    }
  } catch (e) {}
}

function sample(url, json) {
  if (apiSamples.length >= 4) return;
  const has = apiSamples.some((s) => url.split("?")[0].includes(s.url.split("?")[0]));
  if (has) return;
  apiSamples.push({ url: url.slice(0, 150), sample: JSON.stringify(json).slice(0, 1500) });
}

async function clearDialog() {
  try {
    const info = await page.info();
    if (info?.dialog) {
      await page.dismissDialog().catch(() => {});
      await sleep(2000);
    }
  } catch (e) {}
}

// 访问一个页面：加载 → 清对话框 → 拦截分发 → 抽表格 → 存整页文本
async function visit(url, tag) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    console.log(JSON.stringify({ log: "goto-soft", url: url.slice(0, 60), msg: String(e.message).slice(0, 50) }));
  }
  await sleep(8000);
  await clearDialog();
  await drainApi(tag);
  const txt = await page.evaluate(() => document.body?.innerText?.slice(0, 8000)).catch(() => "");
  if (tag) textDumps[tag] = txt;
  const rows = await extractTable();
  if (rows && rows.length >= 2 && tag) tableRows.push({ from: tag, rows });
  return { txt, rows };
}

async function extractTable() {
  return page
    .evaluate(() => {
      const tables = [...document.querySelectorAll("table")];
      let best = null;
      for (const t of tables) {
        const trs = [...t.querySelectorAll("tr")].map((tr) =>
          [...tr.querySelectorAll("th,td")].map((td) => (td.innerText || "").trim())
        );
        const dataRows = trs.filter((r) => r.length >= 4 && r.some((c) => c));
        if (!best || dataRows.length > best.length) best = dataRows;
      }
      return best && best.length >= 2 ? best.slice(0, 80) : null;
    })
    .catch(() => null);
}

// 表格行 → 笔记记录（在前 3 行里找含「标题」的表头行）
// 列名陷阱：内容分析页的「封面点击率」含「点击」二字，绝不能当阅读列（10-11 bug 根源之一）
function mapTable(rows) {
  for (let h = 0; h < Math.min(3, rows.length - 1); h++) {
    const header = rows[h].map((c) => (c || "").replace(/\s/g, ""));
    const col = (...names) => header.findIndex((cell) => cell && names.some((n) => cell === n));
    const iT = col("标题", "笔记名称");
    if (iT < 0) continue;
    const iTi = header.findIndex((c) => c && /发布时间|时间/.test(c));
    const iIm = col("曝光");
    const iRe = col("观看", "阅读");
    const iL = col("点赞");
    const iC = col("收藏");
    const iCm = col("评论");
    const iS = col("分享");
    const iF = col("涨粉", "新增关注", "新增粉丝");
    const mapped = rows
      .slice(h + 1)
      .filter((r) => r[iT] && r[iT].trim() && !/^发布于/.test(r[iT].trim()))
      .map((r) => ({
        id: null,
        title: r[iT].trim(),
        type: null,
        publishedAt: iTi >= 0 ? r[iTi] : null,
        impressions: iIm >= 0 ? parseCount(r[iIm]) : null,
        reads: iRe >= 0 ? parseCount(r[iRe]) : null,
        likes: iL >= 0 ? parseCount(r[iL]) : null,
        collects: iC >= 0 ? parseCount(r[iC]) : null,
        comments: iCm >= 0 ? parseCount(r[iCm]) : null,
        shares: iS >= 0 ? parseCount(r[iS]) : null,
        newFollowers: iF >= 0 ? parseCount(r[iF]) : null,
      }));
    if (mapped.length) return mapped;
  }
  return null;
}

// 滚动触发应用自身的分页 XHR 并拦截（creator API 需要站点 JS 的签名头，page.fetch 裸调 406，
// 所以全量数据靠「让应用自己翻页 + 拦截响应」）。连续 2 轮无新增即停。
async function scrollAndDrain(maxRounds, tag = "manage-scroll") {
  let prev = -1;
  let stale = 0;
  for (let i = 0; i < maxRounds; i++) {
    await page.mouse.move(500, 500).catch(() => {});
    await page.mouse.wheel(0, 3000).catch(() => {});
    await sleep(2500);
    await drainApi(tag);
    if (apiNotes.length === prev) {
      stale += 1;
      if (stale >= 2) break;
    } else {
      stale = 0;
      prev = apiNotes.length;
    }
  }
}

// ---------- 1. creator 登录检查（直接用 /new/home：已登录即首页，未登录跳登录页） ----------
// 校准（2026-10-12）：/new/home?source=official 已登录可达；根路径会落营销页，不要用根路径判断。
{
  try {
    await page.goto("https://creator.xiaohongshu.com/new/home?source=official", { waitUntil: "domcontentloaded", timeout: 40000 });
  } catch (e) {
    console.log(JSON.stringify({ log: "login-goto-soft", msg: String(e.message).slice(0, 60) }));
  }
  await sleep(9000);
  await clearDialog();
  const txt = await page.evaluate(() => document.body?.innerText?.replace(/\n+/g, "|").slice(0, 400)).catch(() => "");
  const onLoginPage = /短信登录|发送验证码|扫码登录|扫码/.test(txt);
  const onHome = /创作服务平台/.test(txt) && /发布笔记|笔记数据总览|粉丝数/.test(txt);
  creatorOk = onHome && !onLoginPage;
  account.creatorLogin = creatorOk;
  stages.push({ stage: "creatorLogin", ok: creatorOk, detail: txt.slice(0, 80) });
  console.log(JSON.stringify({ log: creatorOk ? "creator-login-ok" : "creator-not-logged-in" }));
  if (creatorOk) await drainApi("home"); // 首页加载期已发出的 note_detail_new / personal_info / account/base
}

const userId = taskDef.userId ?? (await userIdFromCookie());
if (userId) account.userId = userId;

// ---------- 2. creator 可用：四页直连采集 ----------
// 校准（2026-10-12）：四个页面都有稳定直接 URL，无需点导航。
const onCreatorLogin = (t) => /短信登录|发送验证码|你访问的页面不见了/.test(t || "");

if (creatorOk) {
  // 2a. 账号概览（受众活跃时段 + 流量来源；account/base 若首页未截到在此兜底）
  await visit("https://creator.xiaohongshu.com/statistics/account/v2?source=official", "accountOverview");
  stages.push({ stage: "accountOverview", ok: !!(audience.viewPeriods || overview.accountBase) });

  // 2b. 粉丝数据（涨粉趋势 + 铁粉榜 + 画像）
  await visit("https://creator.xiaohongshu.com/statistics/fans-data?source=official", "fansData");
  stages.push({ stage: "fansData", ok: !!(fans.overall || fans.portrait) });

  // 2b+. 内容分析（阅读数 read_count，默认窗口近 30 天；10-12 试跑曾漏访此页导致 reads 全 null）
  await visit("https://creator.xiaohongshu.com/statistics/data-analysis?source=official", "contentAnalysis");
  if (analyzeMeta.total != null && analyzeMeta.total > 10) await scrollAndDrain(6, "analysis-scroll"); // 表格分页未必由滚动触发，尽力而为
  stages.push({ stage: "contentAnalysis", ok: analyzeMeta.total != null, total: analyzeMeta.total });

  // 2c. 笔记管理（主路径：posted API 滚动翻页全量 + 内容分析 analyze/list 随导航自动拦截）
  // 校准（2026-10-12）：page.fetch 直调 406，滚动翻页是唯一可靠路径（10-11 的首页 0 条即 fetch 所致）
  let manageOk = false;
  try {
    await page.goto("https://creator.xiaohongshu.com/new/note-manager?source=official", { waitUntil: "domcontentloaded", timeout: 40000 });
    await sleep(8000);
    await clearDialog();
    await drainApi("manage-load");
    const txt = await page.evaluate(() => document.body?.innerText?.slice(0, 8000)).catch(() => "");
    textDumps.contentManage = txt;
    const rows = await extractTable();
    if (rows && rows.length >= 2) tableRows.push({ from: "contentManage", rows });
    manageOk = /标题|状态|审核|已发布/.test(txt) && !onCreatorLogin(txt);
    if (manageOk) await scrollAndDrain(16);
  } catch (e) {
    console.log(JSON.stringify({ log: "manage-fail", msg: String(e.message).slice(0, 60) }));
  }
  stages.push({ stage: "noteManager", ok: manageOk, notes: apiNotes.length });
} else {
  console.log(JSON.stringify({ log: "skip-creator-stages" }));
}

// ---------- 3. 个人主页（C 级数据：公开赞数 + 封面，www 登录即可） ----------
// 校准（2026-10-07）：www 未登录时主页有「登录即可查看 Ta 的笔记」遮罩，此时 DOM 里仍能抓到
// 头像链接（其 id 是 userId 而非笔记 id），会造假数据——先检测遮罩，命中就跳过卡片提取。
const onWwwLoginWall = (t) => /登录即可查看|短信登录|扫码登录/.test(t || "");
const profileUrl = taskDef.profileUrl || (userId ? `https://www.xiaohongshu.com/user/profile/${userId}` : null);
if (profileUrl) {
  const { txt } = await visit(profileUrl, "profile");
  if (onWwwLoginWall(txt)) {
    stages.push({ stage: "profile", ok: false, reason: "www-not-logged-in" });
    console.log(JSON.stringify({ log: "www-not-logged-in", hint: "creator 数据已足够；如需主页公开数据请在 Ego Lite 登录 www.xiaohongshu.com" }));
  } else {
    // 滚动两屏触发懒加载
    await page.mouse.move(500, 500).catch(() => {});
    await page.mouse.wheel(0, 2500).catch(() => {});
    await sleep(3000);
    await page.mouse.wheel(0, 2500).catch(() => {});
    await sleep(3000);
    await drainApi("profile");
    const cards = await page
      .evaluate((sel) => {
        const links = [...document.querySelectorAll(sel)];
        const seen = new Set();
        const out = [];
        for (const a of links) {
          const card = a.closest("section.note-item") || a.closest("section") || a.parentElement?.parentElement;
          const id = ((a.getAttribute("href") || "").match(/([0-9a-f]{24})/) || [])[1];
          if (!id || seen.has(id) || !card) continue;
          seen.add(id);
          out.push(card.outerHTML);
          if (out.length >= 40) break;
        }
        return out;
      }, "a[href*='/explore/'], a[href*='/user/profile/']")
      .catch(() => []);
    wwwOk = cards.length > 0;
    if (wwwOk) {
      for (const html of cards) {
        const id = (html.match(/([0-9a-f]{24})/) || [])[1];
        if (!id || (userId && id === userId)) continue; // 头像/主页链接不是笔记
        const title = (html.match(/class="title[^"]*"[^>]*>([^<]{1,120})</) || html.match(/alt="([^"]{1,120})"/) || [])[1] ?? null;
        const countRaw = (html.match(/class="count[^"]*"[^>]*>([^<]{1,15})</) || [])[1] ?? null;
        const img = (html.match(/(?:data-)?src="(\/\/[^"]+)"/) || [])[1] ?? null;
        profileNotes.push({
          id,
          title,
          type: /icon_play|play/.test(html) ? "video" : "normal",
          likes: parseCount(countRaw),
          publishedAt: null,
          impressions: null,
          reads: null,
          collects: null,
          comments: null,
          shares: null,
          newFollowers: null,
          coverUrl: img ? "https:" + img : null,
          noteUrl: `https://www.xiaohongshu.com/explore/${id}`,
        });
      }
    }
    stages.push({ stage: "profile", ok: wwwOk, notes: profileNotes.length });
  }
} else {
  stages.push({ stage: "profile", ok: false, notes: 0 });
}

// ---------- 4. 都不可用 → 报 not-logged-in 退出 ----------
if (!creatorOk && !wwwOk) {
  console.log(JSON.stringify({ error: "not-logged-in", detail: "creator 与 www 均未登录（或主页卡片未渲染）。请在 Ego Lite 登录小红书后重试；profileUrl 未知时也可在任务文件里直接提供。" }));
  await task.finish({ keep: [] }).catch(() => {});
  process.exit(2);
}

// ---------- 5. 合并（低优先 → 高优先：profile → api → 表格，同字段后者覆盖） ----------
const byKey = new Map();
const keyOf = (n) => (n.id && /^[0-9a-f]{24}$/.test(n.id) ? n.id : n.title ? "t:" + n.title.trim() : null);
function mergeIn(notes, stageName) {
  for (const n of notes) {
    const k = keyOf(n);
    if (!k) continue;
    const cur = byKey.get(k) || {
      id: null, title: null, type: null, publishedAt: null,
      impressions: null, reads: null, likes: null, collects: null, comments: null, shares: null, newFollowers: null,
      coverUrl: null, noteUrl: null, detail: null,
    };
    const merged = { ...cur };
    for (const [field, val] of Object.entries(n)) {
      if (val === null || val === undefined || val === "") continue;
      if (field === "id" && merged.id && /^[0-9a-f]{24}$/.test(merged.id)) continue;
      merged[field] = val;
    }
    byKey.set(k, merged);
  }
  console.log(JSON.stringify({ log: "merge", stage: stageName, size: notes.length, total: byKey.size }));
}
mergeIn(profileNotes, "profile");
mergeIn(apiNotes, "api");
for (const t of tableRows) {
  const mapped = mapTable(t.rows);
  if (mapped) mergeIn(mapped, `table:${t.from}`);
}

const notes = [...byKey.values()]
  .filter((n) => n.title || n.id)
  .sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")))
  .slice(0, maxNotes);

// ---------- 6. 详情页补全正文/话题（赞 top3 + bottom3，best-effort） ----------
const withLikes = notes.filter((n) => n.id && n.likes != null).sort((a, b) => b.likes - a.likes);
const detailTargets = [...withLikes.slice(0, 3), ...withLikes.slice(-3)]
  .filter((n, i, arr) => arr.indexOf(n) === i)
  .slice(0, detailCount);
for (const n of detailTargets) {
  try {
    await page.goto(n.noteUrl || `https://www.xiaohongshu.com/explore/${n.id}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {}
  await sleep(6000);
  const det = await page
    .evaluate(() => {
      const pick = (sels) => {
        for (const s of sels) {
          const e = document.querySelector(s);
          if (e) return e.textContent.trim();
        }
        return null;
      };
      const desc = document.querySelector("#detail-desc");
      return {
        title: document.querySelector("#detail-title")?.textContent?.trim() ?? null,
        desc: desc?.innerText?.slice(0, 2000) ?? null,
        topics: desc ? [...desc.querySelectorAll("a.tag")].map((a) => a.textContent.trim().replace(/^#/, "")).filter(Boolean) : null,
        time: pick([".bottom-container", "[class*='date']"]),
      };
    })
    .catch(() => null);
  if (det && (det.desc || det.title)) {
    n.detail = { desc: det.desc, topics: det.topics, bodyChars: det.desc ? det.desc.length : null };
    n.title = n.title || det.title;
    n.publishedAt = n.publishedAt || det.time;
    n.likes = n.likes ?? parseCount(det.likes);
    n.collects = n.collects ?? parseCount(det.collects);
    n.comments = n.comments ?? parseCount(det.comments);
  }
}
stages.push({ stage: "details", ok: true, fetched: detailTargets.length });

// ---------- 7. 封面下载（best-effort，≤12 张）+ 索引回写 ----------
const withCovers = notes.filter((n) => n.coverUrl).slice(0, 12);
const coverIndex = {};
if (withCovers.length) {
  const coversDir = join(OUT, `covers-${today}`);
  await mkdir(coversDir, { recursive: true });
  for (const [i, n] of withCovers.entries()) {
    const name = `${String(i + 1).padStart(2, "0")}-${n.id || "na"}.jpg`;
    try {
      await page.fetch(n.coverUrl, { saveAs: join(coversDir, name), timeout: 15000 });
      n.coverFile = `covers-${today}/${name}`;
      coverIndex[n.id || n.title] = n.coverFile; // 10-11 bug 修复：索引文件兜底映射，即便 coverFile 回写失败也能人工对齐
    } catch (e) {
      /* 封面失败不影响样本 */
    }
  }
  await writeFile(join(OUT, "covers-index.json"), JSON.stringify(coverIndex, null, 2)).catch(() => {});
}
stages.push({ stage: "covers", ok: true, fetched: Object.keys(coverIndex).length });

// ---------- 8. 写 snapshot ----------
const summary = {
  sampledAt: new Date().toISOString(),
  date: today,
  source: [...new Set(stages.filter((s) => s.ok).map((s) => s.stage))].join("+") || "none",
  degraded: notes.length < 5,
  account,
  overview, // 近7/30日全指标+日粒度+环比（noteDetailNew）与账号概览补充（accountBase）
  fans, // 涨粉趋势 / 铁粉榜 / 画像 / 来源
  audience, // 受众活跃时段 / 流量来源
  analyzeMeta, // 内容分析窗口与覆盖总量（reads 的覆盖范围说明）
  stages,
  apiSamples,
  notes,
  pageTextDumps: textDumps,
};
const outPath = join(OUT, `${today}-snapshot.json`);
await writeFile(outPath, JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify({
    ok: !summary.degraded,
    out: outPath,
    total: notes.length,
    source: summary.source,
    degraded: summary.degraded,
    readsCovered: analyzeMeta.total,
    hasOverview: !!overview.noteDetailNew,
    hasFans: !!fans.overall,
    hasPortrait: !!fans.portrait,
    hasAudience: !!audience.viewPeriods,
  })
);
await task.finish({ keep: [] });
