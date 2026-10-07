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

## 2. 数据中心 · 笔记数据（A 级：曝光/阅读）

依次尝试直接 URL（每步后 snapshot 确认是否落在正确页面）：

- `https://creator.xiaohongshu.com/data/noteData`
- `https://creator.xiaohongshu.com/statistics/noteData`

都不对 → 从 creator 首页 snapshot 里按文本找「数据中心」→「笔记数据」导航点击进去。

数据到手的三种方式（按优先级）：

1. **API 拦截**：页面创建后立刻 `page.cdp("Network.enable")`，加载后 `await page.events()` 里筛 `Network.responseReceived`，对 URL 含 `note`/`data`/`statistic` 的响应 `page.cdp("Network.getResponseBody", { requestId })` 取 JSON，找出含标题+数字指标的数组。
2. **表格解析**：`page.evaluate` 扫 `table tr` 拆单元格文本，按表头（标题/发布时间/曝光/阅读/点赞/收藏/评论）映射。
3. **整页文本兜底**：`page.evaluate(() => document.body.innerText.slice(0, 8000))`，由模型按行解析（行格式通常是：封面 标题 发布时间 曝光 阅读 点赞 收藏 评论 分享）。

## 3. 内容管理列表（B 级：全量笔记列表，无曝光数据）

`https://creator.xiaohongshu.com/publish/manage`（或首页点「内容管理」）。至少拿到：标题、发布时间、状态。翻页用滚动 + 重新 snapshot，最多 3 屏。

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

## 已知坑（来自 xiaohongshu-publisher 同域经验）

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
