// 小红书自有账号数据采集器（xiaohongshu-analyst · 阶段 1）
// 用法：先写任务文件 /tmp/xhs-analyst-task.json，然后：
//   ego-browser nodejs < <skill-dir>/scripts/scrape-my-notes.mjs
//
// 任务文件 schema：
// {
//   "outDir": "/abs/path/vault/小红书运营/数据",  // 产出目录（必填，缺省 /tmp/xhs-analyst-out）
//   "maxNotes": 50,                               // 最多保留笔记数（默认 50）
//   "detailCount": 6,                             // 打开详情页补全正文的笔记数（默认 6：赞 top3+bottom3）
//   "profileUrl": "https://www.xiaohongshu.com/user/profile/<id>"  // 可选，跳过 userId 探测
// }
//
// 产出：<outDir>/<YYYY-MM-DD>-snapshot.json（唯一产出，模型据此分析）
// 多级降级：A) 创作者中心数据中心(API拦截→表格解析) → B) 内容管理 → C) 个人主页公开数据。
// creator 未登录但 www 已登录时自动降到 C 级；两者都未登录才报 not-logged-in 退出。
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
const maxNotes = taskDef.maxNotes ?? 50;
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

// ---------- 创作者平台 API 响应收集（宽松解析，任何 creator 域 XHR 里疑似笔记指标的条目） ----------
// 字段别名是猜测的，无法穷举真实 API schema——因此 apiSamples 保留原始样本片段，模型分析前先核对映射。
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
      impressions: num("impression", "impress", "viewCount", "view_count", "view", "exposure", "readCnt"),
      reads: num("readCount", "read_count", "read", "clickCount", "click"),
      likes: num("likeCount", "like_count", "likedCount", "like", "likes"),
      collects: num("collectCount", "collected_count", "collect_count", "collected", "collect"),
      comments: num("commentCount", "comments_count", "comment_count", "comment"),
      shares: num("shareCount", "shared_count", "share_count", "share"),
    };
    const hasMetric = Object.values(metrics).some((v) => v != null);
    if (idOk || hasMetric) {
      let pub = node.time ?? node.publishTime ?? node.publish_time ?? node.createTime ?? null;
      if (typeof pub === "number" && pub > 1e12) pub = new Date(pub).toISOString().slice(0, 16).replace("T", " ");
      else if (typeof pub === "number" && pub > 1e9) pub = new Date(pub * 1000).toISOString().slice(0, 16).replace("T", " ");
      const token = typeof node.xsec_token === "string" ? node.xsec_token : null;
      let coverRaw = node.cover?.url ?? node.coverUrl ?? (Array.isArray(node.images_list) ? node.images_list?.[0]?.url : null) ?? node.cover_url ?? null;
      if (typeof coverRaw === "string") coverRaw = coverRaw.replace(/^http:\/\//, "https://"); // 混合内容会被浏览器拦截，CDN 支持 https
      out.push({
        id: typeof id === "string" ? id : null,
        title: title.trim(),
        type: typeof node.type === "string" ? node.type : null,
        publishedAt: pub,
        ...metrics,
        newFollowers: null,
        sticky: node.sticky === true ? true : null,
        permission: typeof node.permission_msg === "string" && node.permission_msg ? node.permission_msg : null,
        coverUrl: typeof coverRaw === "string" ? (coverRaw.startsWith("//") ? "https:" + coverRaw : coverRaw) : null,
        noteUrl:
          typeof id === "string" && /^[0-9a-f]{24}$/.test(id)
            ? `https://www.xiaohongshu.com/explore/${id}${token ? `?xsec_token=${token}&xsec_source=pc_creatormng` : ""}`
            : null,
      });
      if (out.length > 200) return;
    }
  }
  for (const v of Object.values(node)) harvest(v, out, depth + 1);
}

async function drainApi() {
  try {
    const evs = await page.events();
    const res = evs.filter(
      (e) =>
        e.method === "Network.responseReceived" &&
        /xiaohongshu\.com/.test(e.params?.response?.url || "") &&
        /(note|data|statistic|galaxy|performance|noteList)/i.test(e.params?.response?.url || "") &&
        !/\.(css|js|png|jpg|jpeg|woff|svg|gif)/.test(e.params?.response?.url || "")
    );
    for (const r of res) {
      const url = r.params?.response?.url || "";
      try {
        const body = await page.cdp("Network.getResponseBody", { requestId: r.params.requestId });
        const raw = typeof body === "string" ? body : body.body;
        const data = JSON.parse(raw);
        const before = apiNotes.length;
        harvest(data, apiNotes);
        if (apiNotes.length > before && apiSamples.length < 3) {
          apiSamples.push({ url: url.slice(0, 120), sample: JSON.stringify(data).slice(0, 1500) });
        }
      } catch (e) {
        /* 非 JSON 响应或 body 已释放，忽略 */
      }
    }
  } catch (e) {}
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

// 访问一个页面：加载 → 清对话框 → 收 API → 抽表格 → 存整页文本
async function visit(url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    console.log(JSON.stringify({ log: "goto-soft", url: url.slice(0, 60), msg: String(e.message).slice(0, 50) }));
  }
  await sleep(8000);
  await clearDialog();
  await drainApi();
  const txt = await page.evaluate(() => document.body?.innerText?.slice(0, 8000)).catch(() => "");
  const rows = await extractTable();
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
function mapTable(rows) {
  for (let h = 0; h < Math.min(3, rows.length - 1); h++) {
    const header = rows[h].map((c) => (c || "").replace(/\s/g, ""));
    const col = (...names) => header.findIndex((cell) => cell && names.some((n) => cell.includes(n)));
    const iT = col("标题", "笔记名称");
    if (iT < 0) continue;
    const iTi = col("发布时间", "时间");
    const iIm = col("曝光", "观看");
    const iRe = col("阅读", "点击");
    const iL = col("点赞");
    const iC = col("收藏");
    const iCm = col("评论");
    const iS = col("分享");
    const iF = col("涨粉", "新增关注", "新增粉丝");
    const mapped = rows
      .slice(h + 1)
      .filter((r) => r[iT] && r[iT].trim())
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

// 按文本点击导航（多个候选选择器逐个试，全失败再用 evaluate 兜底）
async function clickByText(text) {
  for (const sel of [`text=${text}`, `loc=role:link[name*="${text}"]`, `loc=role:button[name*="${text}"]`]) {
    try {
      await page.click(sel);
      return true;
    } catch (e) {}
  }
  try {
    return await page.evaluate((t) => {
      const el = [...document.querySelectorAll("a,span,div")].find((e) => e.childElementCount === 0 && e.textContent.trim() === t);
      if (el) {
        el.click();
        return true;
      }
      return false;
    }, text);
  } catch (e) {
    return false;
  }
}

// ---------- 1. creator 登录检查（判据：出现 上传图文/发布笔记 且无登录页特征；SPA 渲染竞态多等几秒） ----------
// 校准（2026-10-07）：控制台锚点是 /publish/publish?source=official；creator 根路径会落到营销/登录页，不要用根路径做判断。
{
  try {
    await page.goto("https://creator.xiaohongshu.com/publish/publish?source=official", { waitUntil: "domcontentloaded", timeout: 40000 });
  } catch (e) {
    console.log(JSON.stringify({ log: "login-goto-soft", msg: String(e.message).slice(0, 60) }));
  }
  await sleep(6000);
  const txt = await page.evaluate(() => document.body?.innerText?.replace(/\n+/g, "|").slice(0, 300)).catch(() => "");
  const onLoginPage = /短信登录|发送验证码|扫码登录|扫码/.test(txt);
  const onPublishPage = /上传图文|发布笔记/.test(txt);
  creatorOk = onPublishPage && !onLoginPage;
  account.creatorLogin = creatorOk;
  stages.push({ stage: "creatorLogin", ok: creatorOk, detail: txt.slice(0, 80) });
  console.log(JSON.stringify({ log: creatorOk ? "creator-login-ok" : "creator-not-logged-in" }));
}

let userId = taskDef.userId ?? (await userIdFromCookie());
if (userId) account.userId = userId;

// ---------- 2. creator 可用：从控制台锚点出发，点导航到 数据看板 / 笔记管理 ----------
// 校准（2026-10-07）：真实导航名是「数据看板」「笔记管理」（不是「数据中心」「内容管理」）；
// 直接 URL（/publish/manage 等）会 404，全部走文本点击。
const dumpText = async (key) => {
  const t = await page.evaluate(() => document.body?.innerText?.slice(0, 8000)).catch(() => "");
  textDumps[key] = t;
  return t || "";
};
const onCreatorLogin = (t) => /短信登录|发送验证码|你访问的页面不见了/.test(t || "");

// 滚动触发应用自身的分页 XHR 并拦截（creator API 需要站点 JS 的签名头，裸 fetch 拿不到，
// 所以全量数据靠「让应用自己翻页 + 拦截响应」）。连续 2 轮无新增即停。
async function scrollAndDrain(maxRounds) {
  let prev = -1;
  let stale = 0;
  for (let i = 0; i < maxRounds; i++) {
    await page.mouse.move(500, 500).catch(() => {});
    await page.mouse.wheel(0, 3000).catch(() => {});
    await sleep(2500);
    await drainApi();
    if (apiNotes.length === prev) {
      stale += 1;
      if (stale >= 2) break;
    } else {
      stale = 0;
      prev = apiNotes.length;
    }
  }
}

if (creatorOk) {
  // 2a. 直接分页调笔记列表 API（主路径）
  // 校准（2026-10-07）：GET /api/galaxy/v2/creator/note/user/posted?tab=0&page=N（同源、带会话、每页 ~12 条）
  {
    const pageSize = 12;
    const pages = Math.min(8, Math.ceil(maxNotes / pageSize) + 1);
    let fetched = 0;
    try {
      for (let p = 0; p < pages; p++) {
        const res = await page.fetch(`/api/galaxy/v2/creator/note/user/posted?tab=0&page=${p}`, { timeout: 15000 }).catch(() => null);
        if (!res || !res.ok) break;
        const data = JSON.parse(res.body);
        const list = data?.data?.notes;
        if (!Array.isArray(list) || !list.length) break;
        const before = apiNotes.length;
        harvest(data, apiNotes);
        fetched += apiNotes.length - before;
        if (list.length < pageSize) break;
        await sleep(800);
      }
    } catch (e) {
      console.log(JSON.stringify({ log: "posted-api-fail", msg: String(e.message).slice(0, 60) }));
    }
    stages.push({ stage: "postedApi", ok: fetched > 0, notes: fetched });
    console.log(JSON.stringify({ log: "posted-api", notes: fetched }));
  }

  // 2b. 数据看板 → 内容分析（补充：账号概览/阅读数据；失败不致命）
  // 校准（2026-10-07）：数据看板的子页签是「账号概览 / 内容分析 / 粉丝数据」，笔记明细在「内容分析」。
  {
    let dcOk = false;
    await dumpText("publishConsole");
    try {
      if (await clickByText("数据看板")) {
        await sleep(5000);
        await drainApi();
        let txt = await dumpText("dataCenter");
        if (!/曝光|阅读|观看/.test(txt) && !onCreatorLogin(txt)) {
          for (const sub of ["内容分析", "笔记数据"]) {
            if (await clickByText(sub)) {
              await sleep(6000);
              await drainApi();
              txt = await dumpText("dataCenter");
              if (/曝光|阅读|观看/.test(txt)) break;
            }
          }
        }
        const rows = await extractTable();
        if (rows && rows.length >= 2) tableRows.push({ from: "dataCenter", rows });
        dcOk = /曝光|阅读|观看/.test(txt) && !onCreatorLogin(txt);
        if (dcOk) await scrollAndDrain(10);
      }
    } catch (e) {
      console.log(JSON.stringify({ log: "dc-click-fail", msg: String(e.message).slice(0, 60) }));
    }
    stages.push({ stage: "dataCenter", ok: dcOk });
  }

  // 2c. 笔记管理（补充：全量列表 + 可见状态；失败不致命）
  {
    let cmOk = false;
    try {
      if (await clickByText("笔记管理")) {
        await sleep(6000);
        await drainApi();
        const txt = await dumpText("contentManage");
        const rows = await extractTable();
        if (rows && rows.length >= 2) tableRows.push({ from: "contentManage", rows });
        cmOk = /标题|状态|审核|数据/.test(txt) && !onCreatorLogin(txt);
        if (cmOk) await scrollAndDrain(12);
      }
    } catch (e) {}
    stages.push({ stage: "contentManage", ok: cmOk });
  }
} else {
  console.log(JSON.stringify({ log: "skip-creator-stages" }));
}

// ---------- 3. 个人主页（C 级数据：公开赞数 + 封面，www 登录即可） ----------
// 校准（2026-10-07）：www 未登录时主页有「登录即可查看 Ta 的笔记」遮罩，此时 DOM 里仍能抓到
// 头像链接（其 id 是 userId 而非笔记 id），会造假数据——先检测遮罩，命中就跳过卡片提取。
const onWwwLoginWall = (t) => /登录即可查看|短信登录|扫码登录/.test(t || "");
let profileUrl = taskDef.profileUrl || (userId ? `https://www.xiaohongshu.com/user/profile/${userId}` : null);
if (profileUrl) {
  const { txt } = await visit(profileUrl);
  if (onWwwLoginWall(txt)) {
    stages.push({ stage: "profile", ok: false, reason: "www-not-logged-in" });
    console.log(JSON.stringify({ log: "www-not-logged-in", hint: "creator 数据可能已足够；如需主页公开数据请在 Ego Lite 登录 www.xiaohongshu.com" }));
  } else {
    // 滚动两屏触发懒加载
    await page.mouse.move(500, 500).catch(() => {});
    await page.mouse.wheel(0, 2500).catch(() => {});
    await sleep(3000);
    await page.mouse.wheel(0, 2500).catch(() => {});
    await sleep(3000);
    await drainApi();
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
    textDumps.profile = txt;
    if (wwwOk) {
      const ov = await page
        .evaluate(() => {
          const t = document.body?.innerText?.slice(0, 2000) || "";
          const grab = (label) => {
            const m = t.match(new RegExp(label + "[\\s\\.:]*([\\d.万wW+,]+)"));
            return m ? m[1] : null;
          };
          return { followers: grab("粉丝"), totalLikes: grab("获赞与收藏") || grab("获赞") };
        })
        .catch(() => null);
      if (ov) {
        if (ov.followers) account.followers = parseCount(ov.followers);
        if (ov.totalLikes) account.totalLikes = parseCount(ov.totalLikes);
      }
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

let notes = [...byKey.values()]
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
        likes: pick([".like-wrapper .count", "[class*='like'] .count"]),
        collects: pick([".collect-wrapper .count", "[class*='collect'] .count"]),
        comments: pick([".chat-wrapper .count", "[class*='chat'] .count"]),
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

// ---------- 7. 封面下载（best-effort，≤12 张） ----------
const withCovers = notes.filter((n) => n.coverUrl).slice(0, 12);
if (withCovers.length) {
  const coversDir = join(OUT, `covers-${today}`);
  await mkdir(coversDir, { recursive: true });
  for (const [i, n] of withCovers.entries()) {
    const name = `${String(i + 1).padStart(2, "0")}-${n.id || "na"}.jpg`;
    try {
      await page.fetch(n.coverUrl, { saveAs: join(coversDir, name), timeout: 15000 });
      n.coverFile = `covers-${today}/${name}`;
    } catch (e) {
      /* 封面失败不影响样本 */
    }
  }
}

// ---------- 8. 写 snapshot ----------
const summary = {
  sampledAt: new Date().toISOString(),
  date: today,
  source: [...new Set(stages.filter((s) => s.ok).map((s) => s.stage))].join("+") || "none",
  degraded: notes.length < 5,
  account,
  stages,
  apiSamples,
  notes,
  pageTextDumps: textDumps,
};
const outPath = join(OUT, `${today}-snapshot.json`);
await writeFile(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ok: !summary.degraded, out: outPath, total: notes.length, source: summary.source, degraded: summary.degraded }));
await task.finish({ keep: [] });
