# @amphilagus/dsh-literature

DeepSeek Harness 的文献检索与定向跟踪插件，配套 agent preset **文献跟踪助理**。标准编码 Agent 默认不加载本工具集，只有选中该 preset 的会话才会启用。

能力范围：

- **检索**：Crossref 远程搜索；本地查询只打已筛查入藏的全局新库。DOI 详情先查新库，未入藏再走 Crossref。
- **跟踪**：按研究主题（可选 ISSN 白名单）或研究者（必须 ORCID）定期检索 Crossref 与 arXiv，人工分级后写入全局新库。
- **辅助**：SCI 期刊目录（刊名、ISSN、影响因子、中科院分区）、跨会话研究者档案、会话本地的到期提醒。

不做全文抓取或翻译。提醒只在当前会话进程存活时触发；关闭期间不响，重开后补发逾期任务。

## 用法

在 **文献跟踪助理** 会话里直接说需求即可；agent 按下面三条路径选技能。

1. **搜索某主题最近的文章**  
   加载 `literature-survey`。`literature_search` 带主题关键词和 `recentDays`（近一周=7，近一月=30）。筛完用 `tracking_curate` 写入全局新库。不建跟踪方案、不排班。

2. **搜索某研究者**  
   加载 `literature-survey`。已有 ORCID 则 `literature_search` 带 `orcid`；只有姓名时先 `researcher_profile_disambiguate`，确认身份后再搜。同样可按 `recentDays` 限制窗口。筛完入全局新库。不建方案、不排班。

3. **对研究者或主题持续跟踪，定时自动汇报**  
   加载 `literature-tracking-setup`：确认 topic / person →（person 先消歧建档）→ 主题可配 ISSN 白名单 → `tracking_plan_add` → `schedule_create`。  
   到期后加载 `literature-tracking-search`：双源检索 → 人工分级 → 入全局新库 → `tracking_log_complete` 后汇报。默认周期提醒会自己反复触发。提醒只在本会话进程存活时响；关掉期间不触发，重开后补发逾期任务。

## 两件东西，分别安装

| 产物 | 是什么 | 装到哪 |
|---|---|---|
| **插件** `@amphilagus/dsh-literature` | host 平面 bundle：默认 `enabled: false`，不给任何会话注册工具 | 目标 profile（例如 `web`）的 `dsh.profile.bundles` |
| **preset** `preset/` | agent 平面组合：人设 + 把文献插件以 `enabled: true` 挂上 + 挂上 schedule | `~/.dsh/.agent-presets/literature-tracking-assistant` |

只装插件、不装 preset：工具全部关闭，picker 里也没有「文献跟踪助理」。只装 preset、不装插件：preset 里的 `@amphilagus/dsh-literature` 行解析失败，会话起不来。

**技能不用单独放置。** `literature-survey`、`literature-tracking-setup` 和 `literature-tracking-search` 是插件在 `enabled: true` 时用 `ctx.skills.register` 注册的运行时技能，不是 `~/.dsh/skills` 里的文件。不要把它们拷进 skills 目录。选中本 preset 后，agent 用自带的 `skill` 工具加载即可。

## 部署

下面默认 profile 名为 `web`，DSH home 为 `~/.dsh`（若设了 `DSH_HOME` 则换成那个目录）。web profile 关了 HMR，每一步装完都要重启 `dsh --profile web` 才生效。

### 1. 安装文献插件

先构建，再链进 profile：

```sh
cd dsh-literature
pnpm install
pnpm run build
./scripts/install-profile.sh web
```

或：

```sh
dsh plugin --profile web add "link:/绝对路径/dsh-literature"
```

这会把包写进 profile 的 `package.json`，并因本仓库声明了 `dsh.bundle.patch` 而加入 `dsh.profile.bundles`。host 上的那一行是空壳（`enabled: false`），标准 / PM / 浏览器等 preset 仍然没有文献工具。

### 2. 安装 schedule 包（仍须在 profile 的 node_modules 里）

`@deepseek-ai/dsh-schedule` 不在默认 web 组合里。文献 bundle 会插入一行 **`disabled: true`** 的 schedule（Loader 不 `apply`，标准模式没有 `schedule_*`）。preset 里再写一行**不带** `disabled` 的 schedule，只有文献跟踪助理会真正挂上工具。

包本身还是要装进 profile 的 `node_modules`（`disabled` 不会替你装依赖），否则 preset 那一行解析失败：

```sh
dsh plugin --profile web add "link:/绝对路径/deepseek-harness/packages/schedule/schedule"
```

或：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-schedule
```

不要在 profile 的 `cordis.patch.yml` 里再单独 insert 一行 schedule。host 上的那一行已经由本仓库的 `cordis.patch.yml` 插入。

### 3. 放置 preset

目录名就是 preset id，必须是 `literature-tracking-assistant`：

```sh
mkdir -p ~/.dsh/.agent-presets
cp -R preset ~/.dsh/.agent-presets/literature-tracking-assistant
```

应得到：

```
~/.dsh/.agent-presets/literature-tracking-assistant/preset.yml
~/.dsh/.agent-presets/literature-tracking-assistant/agent.cordis.yml
```

`preset.yml` 只是 picker 上的显示名「文献跟踪助理」。改人设、mailto、是否挂 schedule，编辑的是 **拷过去之后** 的 `agent.cordis.yml`，不是仓库里的源文件（除非你改完再重新拷）。

Web UI 的 agent-preset picker 应出现「文献跟踪助理」。已有会话不能中途换 preset，开一个**新会话**再选。

### 4. 重启并验收

```sh
dsh --profile web
```

1. 新建会话，选「文献跟踪助理」。
2. 应能看到 `literature_search` / `literature_get` / `literature_db` / `tracking_*` / `researcher_profile_*` / `schedule_create` / `schedule_list` / `schedule_delete`。
3. `literature_db` 的 `action: journals` 按刊名、ISSN 或学科（如「物理」）能返回目录里的刊。
4. `skill` 列表里应有 `literature-survey`、`literature-tracking-setup`、`literature-tracking-search`。
5. 另开一个标准模式会话：上述文献工具和 schedule 工具都不应出现。

## 数据落在哪

首次在文献跟踪助理会话里启用插件后：

```
$DSH_HOME/data/literature/literature.db      # 搜索缓存 + 全局新库 + 跟踪方案 / 档案 / 搜索记录
$DSH_HOME/data/literature/sci_journals.db    # 从本仓库 data/sci_journals.db 拷出的 SCI 目录
```

同一文件里两张文献表职责不同：`papers` 是远程搜索的过渡缓存（上限 2000 行，按 `updated_at` 淘汰），agent 本地查的是 `library_papers`（全局新库，主题和研究者筛完都进这里）。`literature_db` 的 import / search / get / delete 打新库；`stats` 同时报 `libraryCount` 和 `cacheCount`。

有 `sandboxPolicy.grant` 的 DSH 会把这个目录登记为额外可写根，bash/fs 才能碰 backup 和 export。没有 `grant` 的旧版 DSH 插件仍能加载，只是 shell 可能写不进去；文献工具本身不走 sandbox。

## 常用配置

文献插件配置写在 **preset 那次重新挂载** 上（host 空壳的 `enabled: false` 行改 mailto 不会传到本 agent）。编辑：

`~/.dsh/.agent-presets/literature-tracking-assistant/agent.cordis.yml`

```yaml
- id: literature-search
  name: '@amphilagus/dsh-literature'
  config:
    enabled: true
    mailto: you@example.com    # Crossref polite pool，建议填
    # dbPath: ~/custom/literature.db
    # cacheRemote: true
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | host 上 `false`；本 preset 必须 `true` | 主开关 |
| `mailto` | 空 | Crossref 礼貌池邮箱 |
| `dbPath` | `$DSH_HOME/data/literature/literature.db` | SQLite 路径（缓存 + 新库 + 方案） |
| `cacheRemote` | `true` | 是否把远程命中写入搜索缓存（不是新库） |
| `sciJournalsPath` | 包内 `data/sci_journals.db` | SCI 目录路径 |

改完 preset 文件后新开的会话才会用新组合；已在跑的会话保持启动时那一版。

## 跟踪流程

第 3 种用法的工具顺序：

1. `literature-tracking-setup`：定方向 → person 先消歧建档 → `literature_db` `journals` 挑 ISSN → `tracking_plan_add`。若返回 `possible_duplicate`，把该 kind 的现有名单给用户确认后再带 `confirm=true` 调一次 → `schedule_create`（默认 `every`）。
2. 提醒到期（或手动要求跑一次）时 `literature-tracking-search`：`tracking_search` → 人工分级 → `tracking_curate`（`plan` 只是来源备注）→ `tracking_log_complete`（`status=done` 才算完成）。默认 `every` 会自己反复触发，**不要**再 `schedule_create`。

`schedule_create` 的周期是 `every_seconds`（最小 300 秒），不是日历「每周一 9 点」。`prompt` 里写明要执行的方向名和技能名。删除方案只删搜索记录与排班，全局新库和研究者档案保留。

## 开发

```sh
pnpm install
bash scripts/link-dsh.sh   # 把 DSH checkout 里的 @deepseek-ai/* 链到本包
pnpm run typecheck
pnpm run test
pnpm run build
```

测试不访问网络。Crossref / arXiv 在单测里用 stub。

## License

[MIT](LICENSE)
