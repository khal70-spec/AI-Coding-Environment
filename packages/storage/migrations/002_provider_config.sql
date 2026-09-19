-- 002_provider_config — Plan §13. Adapter config blob on providers (key style,
-- endpoint paths, static model lists, probe tuning). Operator config ONLY — the
-- check in 001 still stands: no secret values anywhere; credentials stay vault refs.
-- Forward-only ALTER; schema.sql mirror carries the same column (drift-guard enforced).
ALTER TABLE providers ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (2, '002_provider_config');
