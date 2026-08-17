# @amphilagus/dsh-literature

An out-of-tree **DeepSeek Harness (dsh) bundle** for scientific-literature search, extracted from the
keyanqu project's `literature_processor` backend (Crossref client semantics, paper/journal data model,
SQLite storage) and rebuilt as a native TypeScript dsh plugin.

One function plugin provides three things:

- **搜索引擎 (`ctx.literature`)** — a merged search engine over the local SQLite full-text index
  (FTS5) and the [Crossref REST API](https://api.crossref.org), deduplicated by DOI with local
  records winning.
- **搜索工具** — model-facing tools registered with the dsh tool registry:
  - `literature_search` — keyword search (local + Crossref, year/journal/open-access/citation filters)
  - `literature_get` — fetch one paper's full details by DOI (local cache first)
- **数据库管理** — the local literature database plus its management tool:
  - `literature_db` — `stats` / `search` / `get` / `import` / `delete` / `backup` / `export` / `vacuum`
- **文献跟踪（literature tracking, schema v2）** — 定向跟踪主题/研究者的定期检索工作流:
  - `tracking_plan_add` / `tracking_plan_list` / `tracking_plan_remove` — 文献跟踪方案表（topic 可配期刊 ISSN 白名单；person 必须 ORCID；每方向可配时间窗与排班周期）
  - `tracking_search` — 同时检索 Crossref + arXiv，按方向时间窗 + 白名单过滤，命中全部缓存进老库，并做**第一轮自动筛查**（该方向新库已有的自动剔除）
  - `tracking_curate` — 人工筛查后按唯一 ID（DOI 或 `arxiv:xxxx.xxxxx`）把老库文献转入**新库**（方向库），带符合度分级 very_high/high/medium/low 与备注；同方向去重、跨方向允许重复入藏
  - `tracking_log_complete` — 填写搜索记录表（找到的相关文献 + 一句话介绍 + URL），**status=done 是每次搜索任务的完成终点**
  - `tracking_curated_list` / `tracking_log_list` — 查看某方向新库 / 搜索记录
- **运行时技能** — 不能自动化的判断写成了两个技能，供 agent 加载:
  - `literature-tracking-setup` — 配置方向（白名单选刊、ORCID 查证、排班 schedule_create 建立）
  - `literature-tracking-search` — 每次排班触发的执行 SOP（搜索 → 人工筛查分级 → 入库 → 填记录表 → 续约排班）

## 排班提醒（schedule）

提醒机制复用 DSH 自带的 `@deepseek-ai/dsh-schedule` 子系统（`schedule_create`/`schedule_list`/
`schedule_delete` 工具）。它需要挂载进 profile（见下），否则到点不会自动发消息：

```sh
dsh plugin --profile web add "link:/path/to/deepseek-harness/packages/schedule/schedule"
# 并在 profile 的 cordis.patch.yml 里插入:
#   - insert:
#       - id: schedule
#         name: '@deepseek-ai/dsh-schedule'
```

能力边界：提醒是**会话本地**机制——只有该会话进程存活时才到点触发，进程关闭期间不触发、
重新打开后补发逾期任务；周期用固定间隔（`every_seconds`，最小 300 秒）而非日历语义；无外部
推送渠道。排班由技能指导 agent 用 `schedule_create` 自建、任务完成后自续。

## Database location

By default the SQLite database lives at:

```
~/.dsh/data/literature/literature.db
```

(`$DSH_HOME/data/literature/literature.db` when `DSH_HOME` is set.) The plugin creates the directory
and schema on first load, and registers the directory as an extra sandbox **writable root** through
`sandboxPolicy.grant`, so agents may also read/write database backups and exports there.

Schema: `papers` (DOI-keyed), `journals` (ISSN-keyed), `papers_fts` (FTS5 over title/abstract/
journal/authors with sync triggers), a `meta` table carrying `schema_version`, and the v2 tracking
tables `tracking_plans` / `curated_papers` / `search_logs`.

## Package layout

```
dsh-literature/
  cordis.patch.yml        # bundle patch: inserts the plugin row into a dsh profile
  src/
    index.ts              # plugin entry (name/inject/apply): ctx.literature, grant, tools
    literature-service.ts # the ctx.literature Cordis service (db + engine)
    db/                   # node:sqlite database manager (CRUD, FTS5, backup, import/export)
    engine/               # Crossref client + merged search engine
    tools/                # literature_search / literature_get / literature_db
  tests/                  # db / engine / crossref / composition test suites
  scripts/
    link-dsh.sh           # symlink @deepseek-ai/* from the DSH checkout (dev)
    install-profile.sh    # install/update this bundle into a dsh profile
```

## Install into a profile

Requires the `dsh` CLI on `PATH`. The script forwards to `dsh plugin`, which links the package into
the profile and reconciles `dsh.profile.bundles` automatically:

```sh
cd dsh-literature
pnpm run build
./scripts/install-profile.sh web      # profile name defaults to "web"
```

or directly:

```sh
dsh plugin --profile web add "link:/Users/amphilagusgu/workspace/keyanqu/dsh-literature"
```

Restart the dsh process afterwards. To remove:

```sh
dsh plugin --profile web remove @amphilagus/dsh-literature
```

## Configuration

All fields are optional. Override them in the profile's own `cordis.patch.yml` (see the example at
the top of `cordis.patch.yml`):

| Key | Default | Meaning |
|---|---|---|
| `dbPath` | `$DSH_HOME/data/literature/literature.db` | SQLite file (supports `~/...` paths) |
| `mailto` | unset | Polite-pool email sent as the Crossref `mailto` parameter |
| `crossrefBaseUrl` | `https://api.crossref.org/works` | Crossref works endpoint (tests can point at a stub) |
| `arxivBaseUrl` | `https://export.arxiv.org/api/query` | arXiv export API endpoint |
| `cacheRemote` | `true` | Store Crossref hits into the local database |
| `remoteTimeoutMs` | `15000` | Per-request remote timeout |

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: literature-search
  config:
    mailto: you@example.com
    cacheRemote: true
```

## Development

```sh
pnpm install            # installs typescript/tsdown/vitest
bash scripts/link-dsh.sh  # symlink @deepseek-ai/* from the DSH checkout
pnpm run typecheck      # tsc --noEmit
pnpm run test           # vitest (db, crossref, engine, composition)
pnpm run build          # tsdown -> lib/index.mjs + lib/index.d.mts
```

The composition suite mounts the plugin over `@deepseek-ai/dsh-agent-loop-testkit` and asserts the
Loader-safe export shape, `ctx.literature`, all three tool registrations, tool execution, and the
sandbox-policy grant. Crossref calls are stubbed in unit tests; the suite is hermetic (no network).

## Relationship to the keyanqu backend

The Crossref semantics (polite-pool `mailto`, retry/backoff, JATS abstract stripping, ISSN-type
handling) and the papers/journals model were ported from
`keyanqu/literature_processor/literature_processor/`. Translation/enhancement (selenium, haystack,
celery) is intentionally out of scope for this plugin: agents get search + retrieval + a manageable
database, not the crawler pipeline.

## Known limitations

- **Crossref rate limits** — Crossref is a shared polite pool; heavy use without a `mailto` may be
  throttled. Configure `mailto`.
- **CJK search** — FTS5 `unicode61` tokenizes CJK per character, so CJK queries take the substring
  fallback path; results are substring matches rather than relevance-ranked.
- **No full-text PDF access** — abstracts come from Crossref metadata; paywalled full texts are not
  fetched.
- **Schema migrations** — version 2 (v1 papers/journals + v2 tracking tables, all `CREATE TABLE IF
  NOT EXISTS` so existing databases gain the new tables on open); future schema changes need
  migration code added beside `SCHEMA_VERSION`.
