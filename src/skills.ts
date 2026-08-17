/**
 * Runtime skills registered by dsh-literature: the human-screening and
 * scheduling workflows the tracking tools deliberately do NOT automate.
 * @module @amphilagus/dsh-literature/skills
 */

export const SKILL_TRACKING_SETUP = 'literature-tracking-setup'
export const SKILL_TRACKING_SEARCH = 'literature-tracking-search'

export const SKILL_TRACKING_SETUP_CONTENT = `# 文献跟踪方向配置 (literature-tracking-setup)

此技能教你新增/维护「文献跟踪方案表」中的方向（主题或研究者），并为每个方向建立排班提醒。

## 何时使用
用户要新增、修改、暂停一个文献跟踪方向，或为方向建立/调整定期搜索排班。

## 流程

### 1. 确认方向类型
- **topic（主题）**：跟踪一个研究主题（如"快重离子辐照效应理论"）。建议给出英文名称或英文关键词（Crossref 对中文查询效果差），把英文关键词写进 notes。
- **person（研究者）**：跟踪某研究者的新成果。**必须拿到 ORCID**。

### 2. 主题方向：配置期刊白名单
- 白名单是 ISSN 字符串数组（print ISSN 或 eISSN 皆可；期刊用 ISSN，不是 ISBN），只对 Crossref 结果生效（arXiv 预印本不受期刊白名单限制）。
- 期刊来源：用 literature_db action=journals，按学科（如"物理"、"材料科学"）、刊名或 ISSN 查插件自带的 SCI 期刊目录（含 print ISSN、eISSN、影响因子、中科院分区）。目录约 9500 种刊，按分区优先、影响因子从高到低排序。
- 原则：只放该主题真正会发文章的期刊；宁可少而准，不要大而全。示例（快重离子辐照理论）：NIM-B 0168-583X / Radiation Physics and Chemistry 0969-806X / JAP 0021-8979 / PRB 2469-9969 / PRA 2469-9926 / Comput. Mater. Sci. 0927-0256 / J. Nucl. Mater. 0022-3115 / Matter Radiat. Extremes 2468-2047 / NST 1001-8042 等。
- 不确定时先问用户要白名单，或提供候选列表请用户勾选。

### 3. 研究者方向：ORCID 查证与建档
- ORCID 是硬性必填。下次会话先 researcher_profile_query（按姓名或 ORCID）；已有档案则复用其 ORCID / 方向 / 消歧证据，不要重新消歧。
- 若用户只给名字、档案里还没有：
  1. 用 researcher_profile_disambiguate(family_name, given_name, affiliation?) 查同名候选（不要自己 curl ORCID）。
  2. 与用户确认选中的 ORCID（同名很常见，务必确认单位）。
  3. 用 researcher_profile_upsert 建档：写入 name、orcid、disambiguation_notes（为何是这个人），以及已归纳的 research_areas。
- 名字存英文全名（如 "Andrea Sand"），arXiv 作者检索依赖英文名；中文名放 name_zh。

### 4. 写入跟踪方案表
用 tracking_plan_add：
- topic: name/kind/journal_whitelist/time_window_days/notes(英文关键词)
- person: name/kind/orcid/time_window_days。若该 ORCID 已有档案，工具会回写档案的 plan_id；若档案尚未建，先 upsert 再 add，或 add 后再 upsert(plan_id=该方案)。
- time_window_days: 近3天=3 / 近一周=7 / 近一月=30（默认7）
- search_interval_days: 排班周期天数（默认7；高频方向可用3）

### 5. 建立排班提醒（关键）
用 schedule_create 为每个方向建立提醒：
- 固定周期用 every_seconds = search_interval_days × 86400（最小 300 秒）。
- 或一次性绝对时间 at（如「明天上午 9 点」，必须带时区或 UTC 偏移）。
- prompt 必须写明：**"执行 literature-tracking-search 技能，搜索方向《<方向名>》的最近 <N> 天文献，直到 tracking_log_complete 完成"**。
- 一个方向一个 schedule；若用户想要统一排班，创建一个 every 提醒，prompt 列出所有到期的方向名。
- 说明：提醒是会话本地机制，只有当前会话存活时才会到点触发；会话关闭期间不触发，重新打开后逾期任务会补发。

### 6. 维护
- 暂停：用 tracking_plan_add 重写该方向并传 enabled=0（其余字段按原值），并 schedule_delete 对应提醒；恢复传 enabled=1 并重建提醒。
- 删除方向：tracking_plan_remove（其新库与搜索记录一并删除，先与用户确认）。
- 查看现状：tracking_plan_list / tracking_curated_list / tracking_log_list / researcher_profile_query。

## 完成标志
- tracking_plan_add 返回该方向配置；schedule_create 返回 schedule id（记下来，写入回复）。
`

export const SKILL_TRACKING_SEARCH_CONTENT = `# 文献跟踪搜索执行 (literature-tracking-search)

此技能是每个排班提醒到期后的**标准执行流程**。终点唯一：**用 tracking_log_complete 填完搜索记录表（status=done）**。没有 done 的任务不算完成。

## 何时使用
收到 schedule 提醒（prompt 指明"执行 literature-tracking-search 技能，搜索方向《X》"），或用户手动要求"跑一下某方向的跟踪搜索"。

## 流程

### 1. 执行搜索（第一轮自动筛查已由工具完成）
调用 tracking_search（plan=方向名）。工具内部：
- 双源检索：Crossref（主题=关键词查询+期刊白名单；研究者=query.author+ORCID 过滤）+ arXiv（主题=短语查询；研究者=au:"姓_名"）
- 时间窗按方案的 time_window_days
- 命中的都缓存进老库 papers
- **自动剔除该方向新库已有的文献**（excluded_already_curated）——这些不用再看
- 返回候选列表 candidates 和新 log_id（记住 log_id！）

### 2. 人工筛查候选（核心判断，不可自动化部分）
对每条 candidate 判符合度，四级：
- **very_high（非常高）**：主题/方法/材料完全吻合，是目标领域的直接工作（如：理论文章且正是跟踪的理论问题）。
- **high（高）**：明确相关，值得入库（如：主题吻合的实验或相邻理论工作）。
- **medium（一般）**：边缘相关；或 researcher 方向中**被跟踪者不是一作也不是通讯作者**（按用户规则"不是一作也不是通讯，符合度为一般"）。
- **low（低）**：仅沾边。默认不入库，除非用户要求记录。
一作/通讯判定方法：
- 一作=作者列表第一位；
- 通讯=作者列表末尾常见，或 Crossref/arXiv 条目中标注的 corresponding 标记；不确定时看文章页面或保守判 medium。
- 跨方向提示：一篇文章可以入多个方向的新库（去重仅在同方向内生效）。若当前方向符合度一般但文章明显属于另一个已跟踪方向，可在完成本任务后为那个方向也 curate 一次，但**不要**在本次任务里替别的方向做判断。

### 3. 入库
对每条要入库的候选调用 tracking_curate(plan, unique_id, relevance, note)：
- note 写清筛选理由（如"一作、主题完全吻合"或"第三作者、仅方法论相关"）。
- unique_id 用候选返回的原值（DOI 或 arxiv:xxxx.xxxxx）。
- 返回 already_curated=true 说明同方向已存在，跳过。

### 4. 填写搜索记录表（任务终点）
调用 tracking_log_complete(log_id, findings, summary)：
- findings 数组：本次所有"相关"文献（含 low 未入库但值得一提的），每条给：
  - unique_id（必填）
  - title、url（有就给）
  - summary（必填）：一句话介绍这篇文章做了什么、为什么相关。
- summary：本次扫描的一句话总结（如"本周无理论新文章，仅2篇实验"）。
- **只有此调用成功返回 status=done，任务才算完成。**

### 5. 续约排班
任务完成后，按方案 search_interval_days 用 schedule_create 建下一次提醒（every 或 after），prompt 同前。方向 enabled=0 则跳过续约。

### 6. 向用户汇报
简要汇报：本次窗口、找到几篇、入库几篇（各符合度）、是否续约。若跟踪的是研究者，指出其是否为一作/通讯。

## 异常处理
- tracking_search 报错：重试一次；仍失败则把错误写进搜索记录表（findings 为空、summary 说明失败原因），完成任务，并在汇报中说明。
- 候选过多：按日期倒序 + 标题关键词粗筛后再细看，最多深入前 50 条。
- 网络限流（Crossref polite pool）：间隔 1 秒重试。
`
