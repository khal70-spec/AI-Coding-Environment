-- 004_agent_runs — Plan §26 (P4.5). Persistence for governed agent-loop invocations
-- (investigate/plan/implement). RULE: transcripts are UNTRUSTED model I/O — they are
-- stored verbatim for replay/audit and are never re-executed from the DB. Content
-- lives here ONLY (audit_events stays content-free per convention).
CREATE TABLE IF NOT EXISTS agent_runs (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  phase           TEXT NOT NULL CHECK (phase IN ('investigate','plan','implement')),
  model_id        TEXT,
  status          TEXT NOT NULL
    CHECK (status IN ('completed','awaiting-approval','max-iterations','transport-error')),
  rounds          INTEGER NOT NULL DEFAULT 0,
  tool_calls      INTEGER NOT NULL DEFAULT 0,
  denials         INTEGER NOT NULL DEFAULT 0,
  transcript_json TEXT NOT NULL,
  final_text      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (4, '004_agent_runs');
