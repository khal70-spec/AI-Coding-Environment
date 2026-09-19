-- 005_skills — Plan §40/§41 (P6.3). Skill bundles are TAMPER-EVIDENT: `sha256`
-- captures the whole bundle at review time; `status` moves only human-recorded
-- transitions (pending_review → approved | blocked). Execution reads only
-- `status='approved'`. Digests come from `digestSkillBundle()` (packages/mcp).
CREATE TABLE IF NOT EXISTS skills (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  version          TEXT,
  source_path      TEXT NOT NULL,
  sha256           TEXT NOT NULL, -- whole-bundle digest, recorded AT REVIEW time
  permissions_json TEXT NOT NULL, -- declared grants (fs.pattern:, net:, tool:, effect:)
  status           TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','approved','blocked')),
  reviewed_by      TEXT,
  reviewed_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (5, '005_skills');
