# @amphilagus/dsh-literature

DeepSeek Harness 的文献检索与定向跟踪包。标准编码 Agent 默认**看不到**这些工具；只有选中 **文献跟踪助理** preset 的会话才会启用。

能做的事：

- 用 Crossref + 本地 SQLite 搜论文，按 DOI 取详情
- 跟踪一个研究主题（可配期刊 ISSN 白名单）或一个研究者（必须 ORCID）
- 同时搜 Crossref 和 arXiv，自动去掉该方向已经入藏的文献，再人工筛查分级入库
- 查自带的 SCI 期刊目录（约 9500 种刊：刊名、print ISSN / eISSN、影响因子、中科院分区），给白名单挑 ISSN
- 用 DSH 的 schedule 做会话本地的定期提醒（到点跑一次跟踪搜索）

不能做的事：不爬 PDF、不翻译全文、不替代日历闹钟或外部推送。提醒只在**当前会话进程还活着**时触发；关掉期间不响，再打开会补发逾期任务。

## 两件东西，分别安装

| 产物 | 是什么 | 装到哪 |
|---|---|---|
| **插件** `@amphilagus/dsh-literature` | host 平面 bundle：默认 `enabled: false`，不给任何会话注册工具 | 目标 profile（例如 `web`）的 `dsh.profile.bundles` |
| **preset** `preset/` | agent 平面组合：人设 + 把文献插件以 `enabled: true` 挂上 + 挂上 schedule | `~/.dsh/.agent-presets/literature-tracking-assistant` |

只装插件、不装 preset：工具全部关闭，picker 里也没有「文献跟踪助理」。只装 preset、不装插件：preset 里的 `@amphilagus/dsh-literature` 行解析失败，会话起不来。

**技能不用单独放置。** `literature-tracking-setup` 和 `literature-tracking-search` 是插件在 `enabled: true` 时用 `ctx.skills.register` 注册的运行时技能，不是 `~/.dsh/skills` 里的文件。不要把它们拷进 skills 目录。选中本 preset 后，agent 用自带的 `skill` 工具加载即可。

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
2. 应能看到 `literature_search` / `literature_get` / `literature_db` / `tracking_*` / `schedule_create` / `schedule_list` / `schedule_delete`。
3. `literature_db` 的 `action: journals` 按刊名、ISSN 或学科（如「物理」）能返回目录里的刊。
4. `skill` 列表里应有 `literature-tracking-setup`、`literature-tracking-search`。
5. 另开一个标准模式会话：上述文献工具和 schedule 工具都不应出现。

## 数据落在哪

首次在文献跟踪助理会话里启用插件后：

```
$DSH_HOME/data/literature/literature.db      # 论文库 + 跟踪方案 / 新库 / 搜索记录
$DSH_HOME/data/literature/sci_journals.db    # 从本仓库 data/sci_journals.db 拷出的 SCI 目录
```

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
| `dbPath` | `$DSH_HOME/data/literature/literature.db` | 论文库路径 |
| `cacheRemote` | `true` | 是否把远程命中写入本地库 |
| `sciJournalsPath` | 包内 `data/sci_journals.db` | SCI 目录路径 |

改完 preset 文件后新开的会话才会用新组合；已在跑的会话保持启动时那一版。

## 跟踪怎么用

1. 加载技能 `literature-tracking-setup`：定方向 → `literature_db` `journals` 挑 ISSN → `tracking_plan_add` → `schedule_create`。
2. 提醒到期（或你手动要求跑一次）时加载 `literature-tracking-search`：`tracking_search` → 人工分级 → `tracking_curate` → `tracking_log_complete`（`status=done` 才算完成）→ 按周期再 `schedule_create`。

`schedule_create` 的周期是 `every_seconds`（最小 300 秒），不是日历「每周一 9 点」。`prompt` 里写明要执行的方向名和技能名，否则到期后模型不知道该干什么。

## 开发

```sh
pnpm install
bash scripts/link-dsh.sh   # 把 DSH checkout 里的 @deepseek-ai/* 链到本包
pnpm run typecheck
pnpm run test
pnpm run build
```

测试不访问网络。Crossref / arXiv 在单测里用 stub。
