/**
 * SQLite DDL for the literature database: papers cache, journals, FTS5
 * indexes, tracking plans, the v3 curated_papers table (kept for migration),
 * the v4 global library, search logs, and researcher profiles.
 * @module @amphilagus/dsh-literature/db/schema
 */

/** Current database schema version, recorded in the `meta` table. */
export const SCHEMA_VERSION = 4

export const SCHEMA_DDL = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS papers (
    doi TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    authors TEXT NOT NULL DEFAULT '[]',
    journal TEXT,
    issn TEXT,
    eissn TEXT,
    publication_date TEXT,
    year INTEGER,
    abstract TEXT,
    url TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    is_open_access INTEGER NOT NULL DEFAULT 0,
    citation_count INTEGER NOT NULL DEFAULT 0,
    impact_factor REAL,
    cas_partition INTEGER,
    is_sci INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(year)`,
  `CREATE INDEX IF NOT EXISTS idx_papers_journal ON papers(journal)`,
  `CREATE INDEX IF NOT EXISTS idx_papers_source ON papers(source)`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
    title,
    abstract,
    journal,
    authors,
    content = 'papers',
    content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2'
  )`,

  `CREATE TRIGGER IF NOT EXISTS papers_ai AFTER INSERT ON papers BEGIN
    INSERT INTO papers_fts(rowid, title, abstract, journal, authors)
    VALUES (new.rowid, new.title, COALESCE(new.abstract, ''), COALESCE(new.journal, ''), new.authors);
  END`,

  `CREATE TRIGGER IF NOT EXISTS papers_ad AFTER DELETE ON papers BEGIN
    INSERT INTO papers_fts(papers_fts, rowid, title, abstract, journal, authors)
    VALUES ('delete', old.rowid, old.title, COALESCE(old.abstract, ''), COALESCE(old.journal, ''), old.authors);
  END`,

  `CREATE TRIGGER IF NOT EXISTS papers_au AFTER UPDATE ON papers BEGIN
    INSERT INTO papers_fts(papers_fts, rowid, title, abstract, journal, authors)
    VALUES ('delete', old.rowid, old.title, COALESCE(old.abstract, ''), COALESCE(old.journal, ''), old.authors);
    INSERT INTO papers_fts(rowid, title, abstract, journal, authors)
    VALUES (new.rowid, new.title, COALESCE(new.abstract, ''), COALESCE(new.journal, ''), new.authors);
  END`,

  `CREATE TABLE IF NOT EXISTS journals (
    id TEXT PRIMARY KEY,
    journal_title TEXT NOT NULL,
    abbreviated_title TEXT,
    issn TEXT,
    eissn TEXT,
    impact_factor REAL,
    impact_factor_5year REAL,
    cas_partition INTEGER,
    cas_discipline TEXT,
    is_sci INTEGER NOT NULL DEFAULT 0,
    web_of_science_categories TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_journals_title ON journals(journal_title)`,

  // ------------------------------------------------- v2: literature tracking

  // 文献跟踪方案表: one row per tracked direction (topic or person).
  `CREATE TABLE IF NOT EXISTS tracking_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('topic', 'person')),
    journal_whitelist TEXT,
    orcid TEXT,
    time_window_days INTEGER NOT NULL DEFAULT 7,
    search_interval_days INTEGER NOT NULL DEFAULT 7,
    enabled INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,

  // 新库(方向库): 人工筛查后按方向入藏的文献. UNIQUE(plan_id, unique_id)
  // 实现「同一方向已有即筛掉, 跨方向可重复入藏」的去重语义.
  `CREATE TABLE IF NOT EXISTS curated_papers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL REFERENCES tracking_plans(id) ON DELETE CASCADE,
    unique_id TEXT NOT NULL,
    relevance TEXT NOT NULL CHECK (relevance IN ('very_high', 'high', 'medium', 'low')),
    note TEXT,
    added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(plan_id, unique_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_curated_plan ON curated_papers(plan_id)`,

  // v4 全局新库: 筛查后的唯一馆藏. unique_id 主键; 主题与研究者入同一张表.
  `CREATE TABLE IF NOT EXISTS library_papers (
    unique_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    authors TEXT NOT NULL DEFAULT '[]',
    journal TEXT,
    issn TEXT,
    eissn TEXT,
    publication_date TEXT,
    year INTEGER,
    abstract TEXT,
    url TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    is_open_access INTEGER NOT NULL DEFAULT 0,
    citation_count INTEGER NOT NULL DEFAULT 0,
    impact_factor REAL,
    cas_partition INTEGER,
    is_sci INTEGER NOT NULL DEFAULT 0,
    relevance TEXT NOT NULL CHECK (relevance IN ('very_high', 'high', 'medium', 'low')),
    note TEXT,
    source_plan_id TEXT REFERENCES tracking_plans(id) ON DELETE SET NULL,
    added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_library_year ON library_papers(year)`,
  `CREATE INDEX IF NOT EXISTS idx_library_source_plan ON library_papers(source_plan_id)`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(
    title,
    abstract,
    journal,
    authors,
    content = 'library_papers',
    content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2'
  )`,

  `CREATE TRIGGER IF NOT EXISTS library_ai AFTER INSERT ON library_papers BEGIN
    INSERT INTO library_fts(rowid, title, abstract, journal, authors)
    VALUES (new.rowid, new.title, COALESCE(new.abstract, ''), COALESCE(new.journal, ''), new.authors);
  END`,

  `CREATE TRIGGER IF NOT EXISTS library_ad AFTER DELETE ON library_papers BEGIN
    INSERT INTO library_fts(library_fts, rowid, title, abstract, journal, authors)
    VALUES ('delete', old.rowid, old.title, COALESCE(old.abstract, ''), COALESCE(old.journal, ''), old.authors);
  END`,

  `CREATE TRIGGER IF NOT EXISTS library_au AFTER UPDATE ON library_papers BEGIN
    INSERT INTO library_fts(library_fts, rowid, title, abstract, journal, authors)
    VALUES ('delete', old.rowid, old.title, COALESCE(old.abstract, ''), COALESCE(old.journal, ''), old.authors);
    INSERT INTO library_fts(rowid, title, abstract, journal, authors)
    VALUES (new.rowid, new.title, COALESCE(new.abstract, ''), COALESCE(new.journal, ''), new.authors);
  END`,

  // 搜索记录表: 一次跟踪搜索任务的日志, 以 status='done' 为任务完成终点.
  `CREATE TABLE IF NOT EXISTS search_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL REFERENCES tracking_plans(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done')),
    findings TEXT,
    summary TEXT,
    completed_at TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_search_logs_plan ON search_logs(plan_id)`,

  // ------------------------------------------------- v3: researcher profiles

  // 研究员档案: 身份/方向/消歧证据跨会话存活. id = profile-{orcid}.
  `CREATE TABLE IF NOT EXISTS researcher_profiles (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    family_name TEXT,
    given_name TEXT,
    name_zh TEXT,
    orcid TEXT NOT NULL UNIQUE,
    institution TEXT,
    homepage TEXT,
    email TEXT,
    research_areas TEXT,
    aliases TEXT,
    disambiguation_notes TEXT,
    plan_id TEXT REFERENCES tracking_plans(id) ON DELETE SET NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_profiles_orcid ON researcher_profiles(orcid)`,
  `CREATE INDEX IF NOT EXISTS idx_profiles_plan ON researcher_profiles(plan_id)`,
  `CREATE INDEX IF NOT EXISTS idx_profiles_name ON researcher_profiles(family_name, given_name)`,
]
