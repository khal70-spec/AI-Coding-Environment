-- Baseline schema — Plan §30, ADR-008. Driver-neutral SQLite (WAL at runtime).
-- RULE: no secret VALUES in any table. provider_credentials stores vault REFS only.
-- Convention: audit_events is append-only (no UPDATE/DELETE paths in DAOs — tested).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version   INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  root_path     TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'internal'
    CHECK (classification IN ('public','internal','confidential','restricted')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at   TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id     TEXT,
  path        TEXT NOT NULL,
  branch      TEXT NOT NULL,
  base_sha    TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active','archived','removed')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, path)
);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'CREATED',
  risk          TEXT NOT NULL DEFAULT 'medium' CHECK (risk IN ('low','medium','high')),
  classification TEXT NOT NULL DEFAULT 'internal'
    CHECK (classification IN ('public','internal','confidential','restricted')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent       TEXT NOT NULL,
  model_id    TEXT,
  from_state  TEXT NOT NULL,
  to_state    TEXT NOT NULL,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at    TEXT,
  summary     TEXT
);

CREATE TABLE IF NOT EXISTS agents (
  name        TEXT PRIMARY KEY,
  manifest_version INTEGER NOT NULL,
  description TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  protocol    TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  max_classification TEXT NOT NULL DEFAULT 'internal'
    CHECK (max_classification IN ('public','internal','confidential','restricted')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS provider_credentials (
  provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  vault_ref   TEXT NOT NULL, -- e.g. vault://providers/<id>/key — NEVER the value
  last4       TEXT NOT NULL DEFAULT '••••',
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS models (
  id              TEXT PRIMARY KEY,
  provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  display_name    TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  verified        INTEGER NOT NULL DEFAULT 0,
  context_window  INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'unverified',
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  transport     TEXT NOT NULL,
  trust         TEXT NOT NULL DEFAULT 'low' CHECK (trust IN ('low','medium','high')),
  config_json   TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS permissions (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL, -- agent:<name> | mcp:<id> | skill:<name>
  resource    TEXT NOT NULL,
  effect      TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (subject, resource)
);

-- APPEND-ONLY: redacted summaries + hashes only, never secrets or full contents.
CREATE TABLE IF NOT EXISTS audit_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id     TEXT,
  decision    TEXT,
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS test_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  suite       TEXT NOT NULL,
  passed      INTEGER NOT NULL,
  failed      INTEGER NOT NULL,
  skipped     INTEGER NOT NULL DEFAULT 0,
  output_ref  TEXT, -- pointer to redacted log artifact, not inline content
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS security_findings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  severity    TEXT NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
  rule_id     TEXT NOT NULL,
  location    TEXT,
  summary     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','fixed','wontfix')),
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_events(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action);
CREATE INDEX IF NOT EXISTS idx_findings_task ON security_findings(task_id);

-- Idempotent self-record: re-applying this file (e.g. via the sqlite3 CLI) must not fail.
INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (1, '001_initial');
