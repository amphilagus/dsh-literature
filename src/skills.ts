/**
 * Runtime skills registered by dsh-literature: the human-screening and
 * scheduling workflows the tracking tools deliberately do NOT automate.
 * @module @amphilagus/dsh-literature/skills
 */

export const SKILL_TRACKING_SETUP = 'literature-tracking-setup'
export const SKILL_TRACKING_SEARCH = 'literature-tracking-search'
export const SKILL_SURVEY = 'literature-survey'

export const SKILL_TRACKING_SETUP_CONTENT = `# 文献跟踪方向配置 (literature-tracking-setup)

新增/维护跟踪方向，并为其建立排班。工具字段以各工具 description 为准，这里只写判断与完成条件。

## 何时使用
用户要新增、修改、暂停一个文献跟踪方向，或调整定期搜索排班。一次性课题综述用 literature-survey，不要走本技能。

## 流程

### 1. 确认方向类型
- **topic**：一个研究主题。名称尽量英文（或把英文关键词写入 notes）；Crossref 对中文查询效果差。
- **person**：一个研究者。必须有 ORCID；展示名用英文全名（arXiv 作者检索依赖它），中文名放档案的 name_zh。

不确定类型时用 ask_user。

### 2. 主题：期刊白名单
- 白名单是 ISSN 数组（print 或 eISSN，不是 ISBN），只过滤 Crossref；arXiv 不受限。
- 用 literature_db action=journals 按学科/刊名/ISSN 查 SCI 目录，只放该主题真正会发文的刊。宁可少而准。
- 不确定就 ask_user，给出候选让用户勾选。不要自行塞进一大串「常见刊」。

### 3. 研究者：查档 → 消歧 → 建档
- 先 researcher_profile_query（姓名或 ORCID）。已有档案则复用 ORCID / research_areas / 消歧证据，不要重新消歧。
- 档案没有、用户只给了名字：
  1. researcher_profile_disambiguate(family_name, given_name, affiliation?)
  2. ask_user 确认 ORCID（同名很常见，必须对上单位）
  3. researcher_profile_upsert：name、orcid、disambiguation_notes，以及已归纳的 research_areas
- 不要自己 curl ORCID API。

### 4. 写入方案
tracking_plan_add。person 方向：若档案已在，工具会回写 plan_id；若还没有档案，先 upsert 再 add。
- time_window_days：近 3 天=3 / 近一周=7 / 近一月=30（默认 7）
- search_interval_days：排班周期天数（默认 7）
- 若返回 possible_duplicate：把 existing 名单展示给用户确认。确认后**原样再调一次并带 confirm=true**；这一遍不拦。同一名称（同一 id）再调是更新已有方向，不走查重。

### 5. 排班
每个方向一条 schedule_create。
- **默认周期**：every_seconds = search_interval_days × 86400（≥300）。every 会自己反复触发；search 技能**不得**再 schedule_create。
- 一次性 at / after 仅在用户明确要求「某时刻跑一次」时使用。
- prompt 必须写：**"执行 literature-tracking-search 技能，搜索方向《<方向名>》的最近 <N> 天文献，直到 tracking_log_complete 完成"**。
- 提醒是会话本地的：会话存活才到点触发；关掉期间不触发，重开后逾期会补发。把 schedule id 写进回复。

### 6. 维护
- 暂停：tracking_plan_add 原字段 + enabled=0，并 schedule_delete；恢复 enabled=1 并重建 every。
- 删除：先与用户确认，再 tracking_plan_remove（只删方案与搜索记录；**全局新库保留**；档案保留）。
- 查看：tracking_plan_list / tracking_curated_list（全局新库）/ tracking_log_list / researcher_profile_query。

## 完成标志
tracking_plan_add 返回该方向配置；周期方向还有 schedule id。
`

export const SKILL_TRACKING_SEARCH_CONTENT = `# 文献跟踪搜索执行 (literature-tracking-search)

排班到期（或用户要求跑某方向）的标准流程。终点唯一：tracking_log_complete 返回 status=done。没有 done 就不算完成。

## 何时使用
schedule 提醒点名本技能，或用户手动要求跑某方向的跟踪搜索。一次性课题综述用 literature-survey。

## 流程

### 1. 搜索
tracking_search(plan=方向名)。记住返回的 log_id。excluded_already_curated 不用再看。

### 2. 筛查（不可自动化）
对每条 candidate 判四级：
- **very_high**：主题/方法/材料完全吻合，目标领域的直接工作。
- **high**：明确相关，值得入库。
- **medium**：边缘相关；或 person 方向中被跟踪者不是一作也不是通讯。
- **low**：仅沾边。默认不入库，除非用户要求记录。

一作=作者列表第一位。通讯=列表末位，或条目上的 corresponding 标记；不确定则保守判 medium。
主题与人筛完都进**同一张全局新库**；同一 unique_id 全库只有一行。本次只判当前方向的候选。

### 3. 入库
要对入库的候选调用 tracking_curate(unique_id, relevance, note, plan?)。note 写筛选理由。unique_id 用候选原值。plan 可选（来源备注）。already_curated=true 则跳过。

### 4. 完成记录（必须）
tracking_log_complete(log_id, findings, summary)。0 命中也要调用：findings=[]，summary 说明无新文或失败原因。
findings 每条：unique_id 必填；title/url 有则给；summary 一句话说明做了什么、为何相关。
只有返回 status=done 才算完成。

### 5. 一次性提醒才续约
setup 默认用 every，会自己反复触发，**不要**再 schedule_create。
仅当本次提醒是一次性 at/after、且方向仍 enabled 时，才按原 prompt 再建一条。

### 6. 汇报
窗口、找到几篇、入库几篇（各符合度）。person 方向指出是否一作/通讯。

## 异常
- tracking_search 失败：重试一次；仍失败则 findings=[]、summary 写错误，仍要 tracking_log_complete，并在汇报中说明。
- 候选过多：按日期倒序粗筛后再细看，最多深入前 50 条。
`

export const SKILL_SURVEY_CONTENT = `# 文献调研 (literature-survey)

一次性课题或作者近期工作综述。不是建跟踪方向，也不是跑到期跟踪。

## 何时使用
用户要「看看某课题 / 某人最近发了什么 / 帮我调研一下」，且没有要求写入跟踪方案或定期提醒。

## 流程
1. literature_search：query 必填；最近 N 天加 recentDays；已有 ORCID 就带 orcid。不要用 fromYear/toYear 表示最近几天。sources=local 搜的是全局新库，不是远程缓存。需要预印本时说明 arXiv 走跟踪搜索，本技能不建 plan。
2. 需要全文细节时 literature_get（DOI；先查新库，没有再走 Crossref，结果只进缓存）。
3. 筛完要对入库的条目调用 tracking_curate(unique_id, relevance, note) 写入**全局新库**。缓存没有该条则先 search。
4. 按工具返回的条目综述：重点几篇各一句，其余可列题名；不确定的标出来，不要假装读过全文。

## 不要做
- 不要 tracking_plan_add / tracking_search / tracking_log_complete。
- 不要为此建立 schedule。
- 不要把远程搜索缓存当成馆藏。

用户接着要「以后定期跟」时，再 load literature-tracking-setup（person 方向走档案工具）。
`
