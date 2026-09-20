-- 006_memory — Plan §25. Agent memory, scope-isolated (T20): every row is pinned to
-- exactly one scope; scope ids default to '' so the UNIQUE key is total and all reads
-- are scope+id-exact — cross-project UNION reads are impossible by construction.
-- Secrets never reach this table: the service layer refuses secret-shaped values and
-- export re-runs redaction. Deletion/retention are first-class (§25 requirements).
CREATE TABLE IF NOT EXISTS memory_entries (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('global','project','task','model','scratchpad')),
  project_id  TEXT NOT NULL DEFAULT '',
  task_id     TEXT NOT NULL DEFAULT '',
  model_id    TEXT NOT NULL DEFAULT '',
  key         TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT, -- NULL = no TTL; scratchpad defaults to +7d at the service layer
  UNIQUE (scope, project_id, task_id, model_id, key)
);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_entries(scope, project_id, task_id);
CREATE INDEX IF NOT EXISTS idx_memory_expiry ON memory_entries(expires_at);

CREATE TABLE IF NOT EXISTS memory_retention (
  scope          TEXT PRIMARY KEY CHECK (scope IN ('global','project','task','model','scratchpad')),
  retention_days INTEGER NOT NULL CHECK (retention_days >= 0), -- 0 = keep forever
  max_entries    INTEGER NOT NULL CHECK (max_entries > 0)
);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (6, '006_memory');
