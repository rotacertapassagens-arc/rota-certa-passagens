-- Preserve the customer's declared discovery channel separately from technical visit attribution.
-- Existing leads remain valid and have no backfilled value.
ALTER TABLE lead_requests ADD COLUMN how_heard TEXT;
