-- 003_budgets — Plan §13 (P2.7). Spend guardrails for provider consumption:
--   budgets        — limits per provider or model, per window (hard_block default on)
--   budget_events  — append-only usage/allowance ledger (cost when rates are known,
--                    tokens always; NEVER message content — usage numbers only)
--   models         — gains optional declared cost rates so $ limits can be enforced
CREATE TABLE IF NOT EXISTS budgets (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN ('provider','model')),
  scope_id     TEXT NOT NULL,
  window       TEXT NOT NULL CHECK (window IN ('daily','weekly','monthly','total')),
  limit_usd    REAL,
  limit_tokens_in  INTEGER,
  limit_tokens_out INTEGER,
  hard_block   INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_scope_window ON budgets(scope, scope_id, window);

CREATE TABLE IF NOT EXISTS budget_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  provider_id TEXT NOT NULL,
  model_id    TEXT,
  task_id     TEXT,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
  decision    TEXT NOT NULL CHECK (decision IN ('allowed','blocked')),
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_budget_events_at ON budget_events(at);

ALTER TABLE models ADD COLUMN cost_per_mtok_in REAL;
ALTER TABLE models ADD COLUMN cost_per_mtok_out REAL;

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (3, '003_budgets');
