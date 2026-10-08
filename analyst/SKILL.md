---
name: creator-retro-analyst
slug: creator-retro-analyst
displayName: 账号复盘分析师
version: 1.0.0
summary: 只读采集小红书账号数据，周期复盘、验证假设、进化文风指南，沉淀到 Obsidian
description: 小红书账号复盘与文风进化闭环：用 Ego Lite 只读采集创作者中心/主页的笔记数据（曝光/阅读/赞藏评/涨粉），周期性分析表现规律、验证假设、迭代更新《风格指南》，并把每次复盘沉淀到 Obsidian 形成可追溯的进化历史。Use when the user mentions 小红书复盘、账号数据、笔记表现、流量/涨粉下滑、优化文风/标题/选题/封面、风格指南、内容进化 — even if they just say「复盘一下」「最近数据怎么样」「为什么没人点赞」without naming 小红书. 指南产出直接反哺 note-series-publisher 的文案写作。
metadata:
  version: "1.0.0"
  date: "2026-10-07"
  slug: "creator-retro-analyst"
  displayName: "账号复盘分析师"
---

# 小红书账号复盘与文风进化

用 Ego Lite 只读采集自己账号的笔记数据 → 对比上期分析表现规律 → 验证/迭代《风格指南》→ 全过程沉淀进 Obsidian。指南被 note-series-publisher 的文案阶段（其阶段 2）消费，形成「发布 → 数据 → 优化 → 再发布」的进化闭环。

分工路由：用户要**写/发**笔记 → note-series-publisher；要**看数据/复盘/优化风格** → 本技能。两者通过 Obsidian 里的《风格指南.md》衔接。

## 总流程（复盘周期，默认全跑）

```
配置(仅首次) → 采集(只读) → 归档 snapshot → 分析(对比上期+验证假设) → 进化指南 → 追加复盘日志
```

- 用户只要数据不做分析 → 跑到「归档」为止（仅采集模式）。
- 用户问「指南里有什么/标题该怎么写」 → 直接读 vault 里的 风格指南.md 汇报，不采集。

## 阶段 0 · 配置（仅首次）

config.json 与本 SKILL.md 同目录，schema：

```json
{ "vault": "个人知识", "folder": "小红书运营", "createdAt": "2026-10-07", "lastCycle": null }
```

缺失时：读 `~/Library/Application Support/obsidian/obsidian.json` 列出用户全部 vault，用 AskUserQuestion 让用户选 vault 并确认文件夹名（默认 `小红书运营`），写入 config.json。之后每次复盘结束更新 `lastCycle`。

vault 内结构（缺则创建）：

```
<folder>/
├── 风格指南.md                        # 唯一事实源：当前生效的文风规范，版本化
├── 复盘日志.md                        # append-only 进化日志
└── 数据/
    ├── YYYY-MM-DD-snapshot.json       # 原始采集数据（写入后不改）
    ├── YYYY-MM-DD-复盘.md              # 周期报告
    └── covers-YYYY-MM-DD/             # 封面样本（best-effort）
```

写入方式：vault 就是本地目录，直接用文件工具读写；`obsidian` CLI 只用于让用户即时查看（create/append + silent），不作为依赖。不依赖 Dataview 等社区插件。

## 阶段 1 · 采集（Ego Lite，只读）

前提：Ego Lite 已登录小红书（脚本自动检查，未登录会带 `error: not-logged-in` 退出，此时提示用户在 Ego Lite 登录后重试，不要降级到无登录态抓取）。

```sh
# /tmp/xhs-analyst-task.json: {"outDir": "<vault>/<folder>/数据 的绝对路径", "maxNotes": 50}
ego-browser nodejs < <skill-dir>/scripts/scrape-my-notes.mjs
```

产出 `<outDir>/YYYY-MM-DD-snapshot.json`（schema 见 references/guide-format.md）。采集方式（2026-10-07 真实环境校准，细节见 references/creator-recipe.md）：接口带签名头、裸调返回 406，所以脚本**拦截创作者平台自身 XHR**——主路径 = 笔记管理页 posted API 滚动翻页拿全量（曝光/赞/藏/评/享/封面/xsec 链接）；补充 = 数据看板·内容分析（阅读数）+ 个人主页公开数据；正文与话题 = 自动打开点赞 top3+bottom3 的详情页；封面图 best-effort 存 `covers-YYYY-MM-DD/`。

登录态说明：**creator.xiaohongshu.com 登录即可跑通主路径**；www 登录是增量（解锁详情页正文与主页公开数据），未登录时这两项自动跳过，不阻塞复盘。

**平台注记**：仅 macOS 可用（依赖 Ego Lite）；Windows 上改走 ego-browser skill 的 Windows path 章节（接管用户 Chrome 复用登录态），本脚本会被平台守卫拦截（exit 1）。

脚本失败 → 按 references/creator-recipe.md 的手动配方交互式采集（snapshot + evaluate），拿到数据后照样走阶段 2~3；并在配方末尾「校准记录」回写实际可用的 URL/选择器，尽量回写脚本。

## 阶段 2 · 分析

读本期 + 最近一期 snapshot。首次复盘无上期 → 只建基线 + 指南 v1（全部条目标记为待验证假设，向用户说明未经数据验证）。

1. **队列划分**：上期之后新发布的笔记 = 假设验证队列；全量笔记 = 账号基线。
2. **指标**：点赞/收藏/评论中位数；收藏率 = 收藏÷点赞（>1 → 干货型赛道信号，写进基线）；曝光→阅读 CTR（数据中心数据可用时）；发布时间 vs 表现分布。
3. **规律提炼**：每条结论必须带样本量和指标对比（如「数字型标题 n=4，中位点赞 12 vs 账号 5」）。**无样本支撑的结论不许写入**——同 publisher 的 benchmark 纪律。
4. **评分表**（写进复盘报告，扣分制 5 分起、可复现，判据见 references/guide-format.md）：标题 / 选题 / 发布节奏 / 形式 / 互动引导。
5. 报告落盘 `数据/YYYY-MM-DD-复盘.md`（模板见 references/guide-format.md），以「下期观察点」收尾。

snapshot 的 `degraded: true` 只代表样本 <5；账号本身笔记少属正常，全量分析即可，不中断流程。

## 阶段 3 · 进化（风格指南 + 复盘日志）

风格指南.md 与复盘日志.md 的模板见 references/guide-format.md（写 vault 文件前必读）。要点：

- 指南版本号 +1；**每期改动 ≤3 条**——防止把单期噪声过拟合进规范，这是渐进进化的核心约束。
- 条目三态：
  - 有效规律 `[E#]`：有数据支撑的正面结论，每条附证据（复盘日期 + 样本量 + 指标对比）；
  - 禁止事项 `[X#]`：被证伪的规律**移入这里而不是删除**，保留学习轨迹；
  - 待验证假设 `[H#]`：**必须可证伪**——写明判定条件（如「新增笔记 ≥3 篇且点赞中位数 > 基线×1.2 即验证」）。
- 上期的每条 `[H#]` 本期必须处置：已验证（转 `[E#]` 并引用数据）/ 被证伪（转 `[X#]`）/ 样本不足继续观察（写明还差什么数据）。
- 版本历史追加一行：`v3 (2026-10-07): +E3 · X1 修订 · 依据: 复盘 2026-10-07`。

复盘日志.md 追加本期条目（数据摘要 → 发现 → 指南改动 → 假设处置），**只追加不修改历史条目**——它就是进化史。

## 阶段 4 · 反哺发布

复盘完成后提醒用户：《风格指南》已在 vault 生效，note-series-publisher 写文案时自动读取（其阶段 2 已接入）。指南与对标 `benchmark.json` 冲突时以指南优先——自身账号数据 > 对标样本。若发布侧没吃到指南，检查 publisher 的阶段 2 是否读到该文件。

## 硬规则

- **采集只读**：不点赞、不收藏、不关注、不评论、不私信；两次采集间隔 ≥3 天（间隔太短数据无变化，白跑）；页面假死换 Page 重试一次，仍失败走手动配方，不连刷（防风控）。
- **数据纪律**：snapshot 是原始事实源，写入后不修改；分析结论必须能回溯到 snapshot 字段；复盘日志只追加不改写。
- **进化纪律**：指南每期改动 ≤3 条；无证据不改规范；假设必须可证伪。
- Ego Lite 升级提示一律不自动执行，报告用户。
- 敏感主题（医疗/金融/投资建议类）提醒用户注意平台规范后再继续。

## References

- [guide-format.md](references/guide-format.md) — snapshot JSON schema、风格指南/复盘日志/复盘报告模板、评分判据。写任何 vault 文件前必读。
- [creator-recipe.md](references/creator-recipe.md) — 采集手动配方（含校准记录：真实运行后回写实际选择器）。
