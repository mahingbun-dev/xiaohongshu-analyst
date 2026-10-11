# 可执行计划书：创作者中心全量数据探索 × 分析系统增强

> 生成：2026-10-12 ｜ 状态：已确认，本轮直接执行

## 1. 一句话目标

用 Ego Lite 只读探索小红书创作者中心三个页面（首页 /new/home、笔记管理、数据看板三子页签）的全部数据源，把采集脚本从「posted API + 部分内容分析」增强为全量覆盖（含账号概览趋势、粉丝画像），修复 4 个已知映射 bug，并以仓库 `creator-retro-analyst` 为准同步回本地安装目录。

## 2. 背景

- 现有 xiaohongshu-analyst 的采集面：笔记管理 posted API（曝光/赞/藏/评/享/封面）+ 数据看板·内容分析（阅读数）+ 主页公开数据 + 详情页正文。数据看板的账号概览、粉丝数据/画像，以及首页速览从未探索。
- 10-11 第二次真实运行暴露 4 个未修 bug：① dataCenter 层 `impressions` 误取 `read_count`（应为 `imp_count`，导致 CTR 失真）；② `increase_fans_count` 未映射（50 篇 newFollowers 全 null）；③ 封面文件已下载但未回写 notes[].coverFile；④ postedApi 首页偶发 0 条。
- skill 双向分叉：仓库已去商标改名 `creator-retro-analyst`（v1.0.0），本地安装目录仍叫 `xiaohongshu-analyst`（v0.1.0，含 10-11 校准记录）。

## 3. 访谈结论（已确认决策）

| 维度 | 结论 |
| --- | --- |
| 目标 | 三页面全部 API 端点+字段摸清并回写校准记录；脚本全量采集；分析面升级；本地同步 |
| 命名基准 | **以仓库为准**：统一 `creator-retro-analyst`；本地目录改名迁移，config.json 保留；10-11 校准记录先合并进仓库 |
| 采集范围 | 全采：首页速览、账号概览趋势、内容分析、粉丝数据（涨粉趋势 + **画像**：性别/年龄/地域/活跃时段） |
| 执行方式 | 计划书落盘后本轮直接执行全程 |
| 约束 | 只读（不点赞/收藏/关注）；慢速防风控；探索产出**不写入 vault 数据目录**、不更新 lastCycle（不构成一次复盘采集，≥3 天间隔纪律不被消耗）；快照 schema 增量式扩展（历史 snapshot 缺新字段容忍 null） |
| 资源 | ego-browser CLI（已装）、Ego Lite 登录态、仓库 ~/code/xhs/xiaohongshu-analyst、vault = SynologyDrive「小红书」 |

## 4. 待定项与默认假设

| 待定项 | 默认假设 | 再确认时机 |
| --- | --- | --- |
| 部分画像 API 可能需要特定权限/不存在 | 拿不到的子项记 null 并在校准记录标注，不阻塞 | 探索时如实记录 |
| 仓库对发布技能的引用名（note-series-publisher）与本地安装名（xiaohongshu-publisher）不一致 | SKILL.md 里写成「发布侧技能（本地安装名 xiaohongshu-publisher）」，保留仓库发布名注释 | 发布仓库时统一 |
| 新分析维度是否进评分表 | 进「本期发现」分析面，评分判据暂不改（渐进进化纪律） | 下期复盘后按证据回写 |

## 5. 范围

- 做：三页面 XHR 全量探索并回写校准记录；修 4 bug；新增 accountOverview/dailyTrends/fansTrends/portrait 采集；分析面升级（CTR 漏斗、环比、受众匹配）；guide-format.md schema 同步；同步本地并改名迁移；更新 publisher 内的引用文字。
- 不做：git commit/push（未经要求）；不改评分判据；不动 vault 内历史文件；不做复盘分析（本期只校准验证，产出写 /tmp）。

## 6. 任务分解

| # | 任务 | 依赖 | 产出 | 验收标准 |
| --- | --- | --- | --- | --- |
| 1 | 合并本地 10-11 校准记录进仓库 | - | 仓库 creator-recipe.md | diff 仅含预期段落 |
| 2 | Ego Lite 探索三页面（登录检查→首页→数据看板×3 子页→笔记管理 tab 验证） | 1 无强依赖 | /tmp/xhs-creator-data-map.json + 校准素材 | 每页 ≥1 个 API 端点完整记录（URL/参数/字段/样本）；画像 API 有真实样本 |
| 3 | 增强采集脚本（修 4 bug + 新增 4 类数据源） | 2 | scripts/scrape-my-notes.mjs | node --check 通过；字段映射与探索到的真实 schema 一致 |
| 4 | 更新 guide-format.md（snapshot schema 增量）与 SKILL.md（阶段 1/2 分析面、版本 1.1.0） | 2 | 两份文档 | 新字段全部有文档；旧字段无破坏 |
| 5 | 真实试跑验证（产出写 /tmp，不进 vault） | 3 | /tmp 试跑 snapshot | 关键新字段非 null：imp 修复、涨粉、画像 ≥1 项 |
| 6 | 同步本地：mv 改名 ~/.agents/skills/xiaohongshu-analyst → creator-retro-analyst，rsync 仓库内容（排除 config.json），更新 publisher 引用文字 | 5 | 本地安装目录 | config.json 保留；两边内容一致；publisher 引用无断链 |

## 7. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 页面假死/弹窗挂死 | 探索中断 | 探活+reload 一次，仍死换 Page；dialog 检查清理 |
| 风控（访问过频） | 账号受限 | 每页间 sleep ≥5s，全程只读，失败不连刷 |
| API 字段与猜测不符 | 映射错误重演 | apiSamples 保留原始样本；映射以探索实录为准 |
| 改名后 ZCode 技能注册缓存旧名 | 旧名仍显示 | 汇报中说明需重载/重启后生效 |

## 8. 验证方式

node --check 语法校验；/tmp 真实试跑快照中抽查新字段（impressions≠reads、newFollowers 非全 null、portrait 有值）；diff 确认两边目录一致；config.json 内容不变。

## 9. 下一步（第一个动作）

- 动作：任务 1（合并校准记录）→ 任务 2（启动 Ego Lite 探索）
- 时间 / 负责人：本轮立即执行 / ZCode

## 10. 信息来源

- 本地：`~/.agents/skills/xiaohongshu-analyst/`（10-11 校准记录）、`~/code/xhs/xiaohongshu-analyst/analyst/`（仓库 v1.0.0）、xiaohongshu-publisher SKILL.md（引用方式核实）
- 用户确认：命名基准=仓库为准；全采含画像；落盘后直接执行
