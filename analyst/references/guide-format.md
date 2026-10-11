# 文件格式规范

写 vault 内任何文件前先读本文档。所有文件用 Obsidian Flavored Markdown，frontmatter 用 YAML。

## snapshot JSON（数据/YYYY-MM-DD-snapshot.json）

采集脚本的唯一产出，是分析的唯一原始事实源，**写入后不修改**。

```jsonc
{
  "sampledAt": "2026-10-07T14:30:00.000Z",
  "date": "2026-10-07",
  "source": "creatorLogin+accountOverview+fansData+noteManager+profile+details",  // 成功的采集层
  "degraded": false,                             // notes.length < 5 时为 true（新账号属正常）
  "account": {
    "userId": null,
    "followers": 77,            // personal_info.fans_count（权威值，profile 文本解析不可信）
    "follows": 35, "totalLikes": 634, "growLevel": 1
  },
  "overview": {                  // v1.1 新增：首页笔记数据总览（缺则为 null，历史 snapshot 无此字段属正常）
    "noteDetailNew": {
      "seven":  { "view_count": 3238, "like_count": 87, "collect_count": 143, "comment_count": 7,
                  "share_count": 33, "rise_fans_count": 26, "home_view_count": 149, "view_time_avg": 76760,
                  "view_count_rate": 293, "…_rate": "各指标环比%（数值，293 = +293%）",
                  "view_list": ["日粒度数组 7 项"], "like_list": ["…"], "…_list": ["7/30 项日粒度"] },
      "thirty": { "同结构": "len=30" }
    },
    "accountBase": { "account/base 补充字段：loss_fans_count / net_rise_fans_count / publish_note_num 等" }
  },
  "fans": {                      // v1.1 新增：粉丝数据页
    "overall":  { "seven": { "rise_fans_count": 26, "leave_fans_count": 0, "fans_count": 77,
                              "rise_fans_list": ["日粒度"], "fans_list": ["粉丝总数日粒度"] }, "thirty": {} },
    "active":   { "seven":  [{ "user_id": "…", "name": "铁粉昵称", "count": 3 }], "thirty": [] },
    "portrait": { "gender": [{ "title": "男性", "value": 68 }], "age": [{ "title": "18-24", "value": 34 }],
                  "city": [{ "title": "佛山", "value": 28 }], "interest": [{ "title": "生活记录", "value": 11 }] },
    "source":   null
  },
  "audience": {                  // v1.1 新增：受众数据（账号概览页）
    "viewPeriods":   { "seven": [{ "start_point": 0, "end_point": 1, "count": 84 }], "thirty": ["24 小时桶"] },
    "sourceAccount": { "seven": [{ "title": "首页推荐", "value": 84 }], "thirty": [] }
  },
  "analyzeMeta": { "total": 44, "windows": ["2026-09-12~2026-10-12"] },  // v1.1 新增：reads 覆盖范围说明
  "stages": [ { "stage": "dataCenter", "ok": true, "via": "click-nav" } ],
  "apiSamples": [ { "url": "...", "sample": "原始 API JSON 片段（核对字段映射用）" } ],
  "notes": [
    {
      "id": "24位hex（有则可回溯单篇）",
      "title": "笔记标题",
      "type": "normal | video",
      "publishedAt": "2026-09-30 12:00（原始字符串，各来源格式不一）",
      "impressions": null,          // 曝光：analyze 层 imp_count（仅近30天窗口内且已产生数据的笔记有值，全量覆盖不可得）
      "reads": null,                // 观看/阅读：posted 层 view_count（全量覆盖）= analyze 层 read_count（同值）
      "likes": 12, "collects": 3, "comments": 1, "shares": 0,
      "newFollowers": null,         // 涨粉（analyze 层部分笔记携带 increase_fans_count）
      "coverUrl": "https://...", "coverFile": "covers-2026-10-07/01-xxx.jpg",
      "noteUrl": "https://www.xiaohongshu.com/explore/...",
      "detail": { "desc": "正文全文（≤2000字）", "topics": ["话题1"], "bodyChars": 800 }
    }
  ],
  "pageTextDumps": { "dataCenter": "整页文本兜底（表格/API 都失败时模型据此手工解析）" }
}
```

解析注意：

- `apiSamples` 里的字段映射是脚本按探索实录写的，分析前仍建议对照原始样本抽查；映射错了就手工修正 notes 里对应字段，并回写校准记录。
- **CTR（封面点击率）= reads ÷ impressions**，仅对 impressions 非 null 的笔记可算（曝光 imp_count 只在 analyze 窗口内且已产生数据时下发，见 `analyzeMeta.windows`；其余笔记 reads 全量有值但无曝光分母）。
- **字段语义防混**：`view_count` / `read_count` 都是「观看/阅读」；「曝光」只认 `imp_count` / `impl_count`（10-07 曾把 view_count 误标为曝光，10-12 实测两者逐篇相等后才定位）。聚合口径的账号级曝光在 `overview.accountBase` 的 `impl_count` 系字段。
- `overview`/`fans`/`audience` 为 null 时（旧 snapshot 或采集降级）跳过对应分析维度，不报错。
- profile 来源的 `likes` 可能是「赞藏评合计」而非纯点赞数，与详情页数据冲突时以详情页为准。
- `publishedAt` 含相对时间（如「3天前」）时，结合 `date` 换算成绝对日期再进分析。

## 风格指南.md（唯一事实源，版本化）

```markdown
---
updated: 2026-10-07
version: 3
cycle: 2026-10-07
---

# 小红书文风指南 v3

## 账号基线
- 更新于 2026-10-07：笔记 28 篇 · 点赞中位数 5 · 收藏中位数 2 · 收藏率 0.6（赞藏型，非干货型）
- 发布节奏：周 1.5 篇 · 高表现时段：周二/周四 20-22 点（n=6）

## 有效规律（有证据，按置信度排序）
- [E1] 标题含具体数字时点赞中位数 12 vs 账号均值 5（依据: 复盘 2026-10-07, n=4）
- [E2] ...

## 禁止事项（被证伪，保留学习轨迹，不删除）
- [X1] ~~纯提问式标题更引流~~ → 实测点赞中位数 2 vs 账号 5（证伪: 复盘 2026-10-07, n=2）

## 待验证假设（必须可证伪：写明判定条件）
- [H1] 正文首行放「结论前置」摘要能提高收藏率 — 判定: 新增笔记 ≥3 篇且收藏率中位数 > 基线×1.3 即验证成立
- [H2] ...

## 版本历史
- v3 (2026-10-07): +E1 +E2 · X1 由规律降级为禁止事项 · 依据: 复盘 2026-10-07
- v2 (2026-09-28): +H1（初版指南 v1 全部假设，自本版起逐步验证）
- v1 (2026-09-20): 建档，全部条目为待验证假设（未经数据验证）
```

规则：每期改动 ≤3 条；`[E#]` 必须带证据标注；`[X#]` 用删除线保留原规律原文；`[H#]` 必须含「判定:」子句。

## 复盘日志.md（append-only 进化日志）

```markdown
# 复盘日志

## 2026-10-07 · 第 3 期
- 数据：新增笔记 3 篇；点赞中位数 7（上期 5）；收藏率 0.8；粉丝 1200（+35）
- 发现：数字型标题连续 2 期跑赢基线；20-22 点发布的 4 篇中 3 篇高于中位数
- 指南：v2→v3（+E1 +E2，X1 降级）
- 假设：H1 样本不足（新增仅 1 篇可判定），继续观察；新增 H2
- 报告：[[2026-10-07-复盘]]
```

只追加，不修改历史条目。wikilink 指向当期报告文件（与报告文件名一致）。

## 复盘报告（数据/YYYY-MM-DD-复盘.md）

```markdown
# 复盘 2026-10-07（第 3 期）

**账号现状**：粉丝 77（较上期 +26）· 笔记 28 · 点赞中位数 7 · 收藏中位数 4 · 较上期 +2
**数据来源**：creator.xiaohongshu.com 四页直连 + 个人主页（snapshot: [[2026-10-07-snapshot]] 旁路 JSON，见数据目录）

| 维度 | 评分 | 一句话诊断 |
|---|---|---|
| 标题 | 3/5 | 近期 2 篇偏离 [E1] 数字模式 |
| 选题 | 4/5 | 收藏率高于基线 |
| 发布节奏 | 2/5 | 本期仅 1 篇，低于周 1.5 基线 |
| 形式 | 3/5 | 封面大字报为主，与高表现样本一致 |
| 互动引导 | 2/5 | 无一篇有明确互动引导，评论中位数 0 |

## 流量漏斗与环比（overview 可用时）

- 近 7 日：曝光 2.9万（环比 +221%）→ 阅读 3,236（+293%）→ 赞 87 / 藏 148 / 评 8 / 分享 33 → 净涨粉 26
- CTR 中位数 X%（n= 篇，仅 reads 覆盖期内笔记）：高于/低于上期 → 封面选题信号
- 阅读→互动转化：互动率中位数 X%（互动 = 赞+藏+评÷阅读）
- 主页访客 149（+282%）、人均观看时长变化（视频号）

## 受众匹配（fans.portrait / audience 可用时）

- 粉丝画像：男 68% · 18-24 为主力 · 地域 top：佛山 · 兴趣 top：生活记录
- 活跃时段：20-22 点峰值（viewPeriods 24 桶前 3）
- 对照本期选题：受众兴趣与选题重合度 / 发布时间是否落在活跃时段 → 写入发现或下期观察点

## 本期发现（每条带数据，无数据不写）
- ...

## 假设验证
- [H1] → 继续观察（样本不足：新增仅 1 篇）

## 指南改动 v2→v3
- +E1 ...

## 下期观察点
- 关注 H1：至少再发 2 篇「结论前置」结构笔记
```

## 评分判据（初版，随复盘进化后回写本节）

扣分制：每维度 5 分起，P0 每项 -2、P1 每项 -1、P2 每项 -0.5，不适用不扣，下限 0。

| 维度 | 扣分点 |
|---|---|
| 标题 | P0: 标题与全部 [E#] 标题规律都不符；P1: 标题无钩子（平铺直叙）；P2: 标题 >20 字被平台截断 |
| 选题 | P0: 收藏率较基线下滑 >50%；P1: 收藏率低于基线 20% 以上；P2: 选题与 [X#] 禁止事项重合 |
| 发布节奏 | P0: 两期间隔 >30 天；P1: 周均 <1 篇；P2: 发布时间与高表现时段背离 |
| 形式 | P1: 封面形式与 [E#] 中高表现形式背离；P2: 图内文字模糊/不可读 |
| 互动引导 | P1: 无任何互动引导且评论中位数 < 基线；P2: 互动引导措辞与 [X#] 相符 |

维度条目本身也允许进化：复盘发现更可靠的判据时，在指南「版本历史」之外单独更新本节并注明日期。
