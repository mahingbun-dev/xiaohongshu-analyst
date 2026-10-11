# 采集手动配方（脚本失败时的交互式兜底）

采集脚本的 URL/选择器基于 2026-10-07 的公开知识编写，尚未经过真实登录环境校准。脚本失败时按本配方交互式采集——ego-browser 每轮 observe → act → 末尾 print snapshot，把可用发现回写到配方末尾的「校准记录」，并尽量回写 `scripts/scrape-my-notes.mjs`。

原则：单个 TaskSpace 贯穿全程；只读（不点赞不收藏不关注）；每步失败不连刷，换策略或停。

## 1. 登录检查

```js
const task = await taskSpace("xhs self analytics");
const page = task.page("p1");
await page.goto("https://creator.xiaohongshu.com/publish/publish?source=official", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
console.log(await page.evaluate(() => document.body.innerText.slice(0, 200)));
```

出现「上传图文/发布笔记」→ 已登录；出现「扫码」→ `await task.handOff()`，请用户在 Ego Lite 登录后再继续。

## 2. 数据看板（A 级：曝光/阅读/粉丝/画像）

直接 URL（2026-10-12 实测，`source=official` 参数可省）：

- 账号概览：`https://creator.xiaohongshu.com/statistics/account/v2`
- 内容分析（笔记明细+阅读数）：`https://creator.xiaohongshu.com/statistics/data-analysis`
- 粉丝数据（涨粉/画像/铁粉）：`https://creator.xiaohongshu.com/statistics/fans-data`

各页加载时应用自动发 XHR（API 目录见校准记录 2026-10-12 节），拦截即可，无需解析 DOM。内容分析页默认窗口近 30 天，全量（近半年）用页面日期筛选手动选，或直接点「导出数据」拿文件。

## 3. 笔记管理列表（B 级：全量笔记列表）

`https://creator.xiaohongshu.com/new/note-manager`（首页点「笔记管理」同达）。加载即发 `posted?tab=0&page=0`，滚动触发后续页。UI 页签：全部(tab=0)/已发布(tab=1)/审核中/未通过/部分人不可见/置顶。

## 4. 个人主页（C 级：公开赞数 + 封面图）

userId 从 creator 页面 HTML（`user/profile/[0-9a-f]{24}`）或首页「访问主页」链接取。打开 `https://www.xiaohongshu.com/user/profile/<id>`：

- 概览：粉丝数、获赞与收藏从页头文本抓。
- 卡片：选择器 `a[href*='/explore/']`，卡片 outerHTML 用正则解析（id/title/count/img），同 `scrape-benchmark.mjs` 路径 B。滚动 2 屏触发懒加载即可。

## 5. 详情页补全正文/话题（选赞数 top3+bottom3）

打开 `https://www.xiaohongshu.com/explore/<id>`，等待 6 秒后：

```js
await page.evaluate(() => {
  const desc = document.querySelector("#detail-desc");
  return {
    title: document.querySelector("#detail-title")?.textContent?.trim(),
    desc: desc?.innerText?.slice(0, 2000),
    topics: [...(desc?.querySelectorAll("a.tag") ?? [])].map((a) => a.textContent.trim().replace(/^#/, "")),
    time: document.querySelector(".bottom-container")?.textContent?.trim(),
  };
});
```

## 6. 收尾

按 references/guide-format.md 的 snapshot schema 组装 JSON 写盘。任务成功 `await task.finish({ keep: [] })`；用户接管或出错时不要 finish。

## 已知坑（来自 note-series-publisher 同域经验）

- 搜索/列表页渲染器可能假死：`page.evaluate(() => document.title)` 探活，超时就 `reload` 一次，仍死则换 `task.newPage()` 续做。
- 意外弹窗（alert/confirm）会挂死主线程：每次加载后查 `page.info().dialog`，有则 `dismissDialog()`。
- 小红书前端 class 名经常变：正则解析失败时先 snapshot 看真实结构再校准，不要盲试。
- Ego Lite 升级提示（`[ego-browser:notice]`）：完成当前任务后报告用户，`ego-browser upgrade` 需用户同意。

## 校准记录（真实运行后回写，技能自身也遵循进化）

### 2026-10-07 首次真实校准（Ego Lite 0.5.1.13，账号「努力成为阳光大男孩的小马」，71 篇笔记）

**已验证可用**：

- **核心 API**：`GET /api/galaxy/v2/creator/note/user/posted?tab=0&page=N`（每页 ~12 条，笔记管理页翻页时由应用自身调用）。字段：`display_title` / `id` / `type`(video|normal) / `time`("YYYY-MM-DD HH:mm") / `likes` / `collected_count` / `view_count`(曝光) / `comments_count` / `shared_count` / `images_list[].url`(封面) / `xsec_token` / `sticky` / `permission_msg`(可见性)。注意是 `collected_count` 不是 `collect_count`（已踩坑）。
- **裸 fetch 此 API 返回 406**（`{"code":-1}`）——接口要站点 JS 注入的签名头，**只能拦截应用自己发起的 XHR**。全量翻页 = 在列表页滚动（`scrollAndDrain`），让应用自己请求下一页。
- **第二个数据源**：`GET /api/galaxy/creator/datacenter/note/analyze/list?post_begin_time=...&post_end_time=...`（数据看板→内容分析页）。字段风格不同：`post_time`(epoch ms) / `share_count` / `view_time_avg` / `cover_url` / `danmaku_count`。可提供 `read_count`（阅读数，posted API 里没有——这是 reads 字段目前只覆盖部分笔记的原因）。
- **控制台锚点**：`creator.xiaohongshu.com/publish/publish?source=official`。creator 根路径会落到营销/登录页，不要用根路径判断登录态。
- **导航真实名称**：「数据看板」（子页签：账号概览/内容分析/粉丝数据）、「笔记管理」。`/publish/manage` 直接访问 404。
- **登录判据**：登录页含「短信登录/发送验证码」；控制台含「上传图文/发布笔记」。SPA 有渲染竞态，检查前等 6 秒。
- **userId**：cookie `x-user-id-creator.xiaohongshu.com` 的值即 userId（24hex），会话过期后仍可读。
- **creator 与 www 会话独立**：creator 登录 ≠ www 登录。www 未登录时主页有「登录即可查看 Ta 的笔记」遮罩，DOM 里仍能抓到头像链接（其 id 是 userId），会造假笔记——脚本已加遮罩守卫 + userId 剔除。
- **封面 URL**：API 给 `http://` 前缀，必须升 https，否则 page.fetch 混合内容被拦。profile 卡片图是 `//` 协议相对路径，`https:` 拼接即可。
- **当日实测**：creator-only 登录态下 50/71 篇全字段（曝光/赞/藏/评/享/封面）+ 12 张封面下载成功。

**仍待校准（下次运行时观察）**：

- www 登录后：详情页正文/话题补全、主页公开数据（获赞与收藏总数）是否正常入 snapshot。
- reads（阅读数）覆盖率能否提升（可能要在 内容分析 页滚动翻页）。
- 数据看板「内容分析」页的表格 DOM（当前 extractTable 对该页未命中，靠 API 拦截兜住）。

### 2026-10-11 第二次运行（50 篇入 snapshot，粉丝 584，未降级）

- **BUG · impressions 字段映射错误**：本批 snapshot 中 10 篇笔记的 `impressions` 与 `reads` 完全相等，而 apiSamples 原始数据显示 `imp_count=429 / read_count=21`（另例 867/27）——dataCenter 层把 `read_count` 同时填进了两个字段。**修复方向**：该层 impressions 应取 `imp_count`。分析侧临时方案：用 apiSamples 的 `coverClickRate` 还原真实 CTR（本次 ≈0.049，n=2），snapshot 保持只读不改。
- **postedApi 主路径首页返回 0 条**（`notes:0`，stage 记 fail），contentManage 层拦截到 95 条补位，产出未受影响。疑似首屏时序问题，下次运行观察是否复现。
- **封面未回写映射**：12 张封面文件已存 `covers-*/`，但 notes[].coverFile 全为 null（postedApi 挂掉后封面来源只剩 dataCenter 的 `cover_url`，文件名含笔记 id 可事后人工对齐）。
- **www 本次已登录**：details 阶段 ok（top3+bottom3 正文/话题入库），但 dataCenter 的 `increase_fans_count` 未映射进 newFollowers（50 篇全 null），下版补上。

### 2026-10-12 创作者中心全量探索（Ego Lite 真实环境，只读，页面级 XHR 拦截）

**页面直接 URL（全部已验证可达）**：

| 页面 | URL |
|---|---|
| 首页 | `/new/home?source=official`（已登录可达，登录检查可直接用它） |
| 数据看板·账号概览 | `/statistics/account/v2?source=official` |
| 数据看板·内容分析 | `/statistics/data-analysis?source=official` |
| 数据看板·粉丝数据 | `/statistics/fans-data?source=official` |
| 笔记管理 | `/new/note-manager?source=official`（UI 页签：全部/已发布/审核中/未通过/部分人不可见/置顶） |

**API 目录（全部在 creator.xiaohongshu.com 域下，均需站点签名 → 只能拦截应用自身 XHR；`page.fetch` 直调 posted API 实测 406）**：

- `GET /api/galaxy/user/info` — 身份：`userId` / `userName` / `redId` / `permissions`。
- `GET /api/galaxy/creator/home/personal_info` — **权威账号数**：`follow_count` / `fans_count` / `faved_count`(获赞与收藏) / `grow_info`(成长等级进度)。注：本账号实测 fans_count=77，而 10-11 经 profile 页文本解析得 584——**以本 API 为准**，profile 文本解析不可信。
- `GET /api/galaxy/creator/data/note_detail_new` — 首页「笔记数据总览」：`seven` / `thirty` 两周期，各含 `view_count`(曝光) / `view_time_avg` / `home_view_count`(主页访客) / `like` / `collect` / `comment` / `danmaku` / `share` / `rise_fans` 计数 + 同名 `*_list` 日粒度数组(7/30 项) + `*_rate` 环比(百分比数值) + `summary`。
- `GET /api/galaxy/v2/creator/datacenter/account/base` — 账号概览（与上重叠但更全）：额外有 `impl_count_rate` / `loss_fans_count` / `net_rise_fans_count` / `publish_note_num(+_list)` / `cover_click_cycle_rate` / `video_full_view_rate`。
- `GET /api/galaxy/v2/creator/datacenter/audience/view/periods` — **受众活跃时段**：`seven` / `thirty` 各 24 桶 `{start_point, end_point, count}`（小时 0-23）。
- `GET /api/galaxy/v2/creator/datacenter/audience/source/account` — **流量来源占比**：`[{title: 首页推荐/搜索/…, value, source_type}]`，7d/30d。
- `GET /api/galaxy/creator/data/fans/overall_new` — 涨粉：`seven`/`thirty` `{rise_fans_count, leave_fans_count, fans_count, rise_fans_list/leave_fans_list/fans_list 日粒度}`。
- `GET /api/galaxy/creator/data/active_fans_new` — **铁粉榜**：7d/30d 各 top10 `{user_id, name, url, count}`。
- `GET /api/galaxy/creator/data/fans_portrait_new` — **粉丝画像**：`gender` / `age` / `city` / `interest` 各 `[{title, value(占比), color}]`。实测小号：男 68%、佛山 top1、兴趣「生活记录」。
- `GET /api/galaxy/creator/data/fans_source` — 粉丝来源（本账号空数组）。
- `GET /api/galaxy/creator/datacenter/note/analyze/list?post_begin_time=<ms>&post_end_time=<ms>&type=0&page_size=10&page_num=N` — 内容分析：`total` + `note_infos[]{id, title, post_time(ms), type, read_count(阅读), like_count, fav_count(收藏), comment_count, share_count, cover_url, audit_status}`。**默认窗口近 30 天**；页面 UI 自述「仅支持查看近半年」，更宽窗口需用页面上的日期筛选（日历组件，脚本不宜自动化，手动兜底可用）。注意无 impressions 字段，曝光从 posted API 取。
- `GET /api/galaxy/v2/creator/note/user/posted?tab=N&page=N` — 笔记管理列表：`tab` 0=全部 1=已发布（UI 点击「已发布」实测 tab=1）；加载与滚动翻页由应用自动发起（page=0,1,2…，每页 ~12 条）。字段同 10-07 记录。
- `GET /api/galaxy/creator/datacenter/note/base?note_id=X` — **单篇深挖**：`cover_click_rate` / `interaction_rate` / `impl_count` / `view_time_avg` / `finish5s_rate` / `exit_view2s_rate` / `hour.{imp_list, view_list, like_list, collect_list, …}`（小时级）+ `note_info{tags, desc, type:NORMAL}`。发布当日多项为 -1（数据未生成）。
- `POST /api/galaxy/v2/creator/datacenter/livedata/overview` — 直播概览（body `{start_time, end_time}`；无直播全 0）。
- 内容分析页有**「导出数据」按钮**（近半年全量明细，CSV/Excel 导出）——自动化不宜碰下载流程，手动兜底可用。

**噪音 API（拦截时跳过）**：`as.xiaohongshu.com`(风控) / `apm-fe`(监控) / `t2.xiaohongshu.com/api/v2/collect`(埋点) / `edith.*racing|redcaptcha`(风控) / `rightscenter` / `leaderboard` / `activity_center` / `notice` / `create_guidance` / `select/topic`。

**已修 bug 的证据链**：内容分析页表格实测行「429 曝光 / 21 观看 / 4.90% 封面点击率」与 apiSamples `imp_count=429 / read_count=21` 一致 → impressions 必须映射 `imp_count`（posted API 为 `view_count`），reads 只映射 `read_count`/`readCount`，表格解析时「封面点击率」列含「点击」字样曾是 read 列误配来源。

**⚠ 字段语义定论（推翻 10-07 记录的一处标注）**：`posted.view_count` 与 `analyze.read_count` **逐篇完全相等**（实测 19/19、23/23、72/72、104/104…），且首页 `note_detail_new.seven.view_count=3238` 对应 UI「观看数 3,236」——所以 **`view_count` 的语义是「观看/阅读」，不是曝光**（10-07 校准把它标成「曝光」是错的，这正是 10-11 impressions==reads 乱象的总根源）。账号级/单篇级「曝光」只认 `impl_count` / `imp_count`（account/base 的 `impl_count_rate=221` 与 UI「曝光环比+221%」吻合）。映射定论：impressions ← imp_count·impl_count；reads ← read_count·view_count（等价双源，posted 覆盖全量、analyze 只覆盖近30天窗口）。另：analyze 层 44 篇实测均未携带 `increase_fans_count`（newFollowers 全 null），该字段可能仅在产生涨粉归因时下发，别名已预留。
