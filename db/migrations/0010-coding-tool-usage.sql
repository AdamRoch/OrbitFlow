-- FACT-12 preserves the difference between usage OpenCode explicitly reports
-- as zero and usage it omits. Cache tokens remain separately attributable.
ALTER TABLE cost_events
  ALTER COLUMN tokens_in DROP NOT NULL,
  ALTER COLUMN tokens_out DROP NOT NULL,
  ALTER COLUMN computed_cost DROP NOT NULL,
  ADD COLUMN cache_read_tokens BIGINT,
  ADD COLUMN cache_write_tokens BIGINT;

ALTER TABLE cost_events
  ADD CONSTRAINT cost_events_cache_read_tokens_nonnegative
    CHECK (cache_read_tokens >= 0),
  ADD CONSTRAINT cost_events_cache_write_tokens_nonnegative
    CHECK (cache_write_tokens >= 0);
