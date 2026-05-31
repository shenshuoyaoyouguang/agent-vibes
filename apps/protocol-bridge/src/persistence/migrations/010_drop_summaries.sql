-- Migration 010: Drop unused summaries cache table
--
-- Migration 003 introduced a `summaries` table intended to cache
-- conversation summaries keyed by content hash, but the runtime path
-- that would have written / read it was never implemented in
-- ContextCompactionService. The table sat unused while still being
-- swept by `clearAllSessionCaches`, which made the cache-clear flow
-- look like it was doing more than it was.
--
-- Per the agent-vibes turn-system architecture refactor, persisted
-- caches are owned exclusively by SessionPersistenceService (sessions
-- + cascade tables) and the on-disk tool-results spool. There is no
-- second layer of "summary" caching anymore, so the table is
-- retired.
--
-- Strategy: drop the table on every database that still has it.
-- Fresh databases never created it (since 003 ran with
-- `IF NOT EXISTS`), so the guarded `IF EXISTS` keeps the migration
-- runnable on both lineages.

DROP INDEX IF EXISTS idx_summaries_last_used;
DROP TABLE IF EXISTS summaries;
