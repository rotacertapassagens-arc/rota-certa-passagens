DROP TABLE IF EXISTS fin_counterparties;
DROP TABLE IF EXISTS fin_accounts;
-- fin_categories self-references itself (parent_id), so a plain DROP TABLE fails with
-- "depends on it" against its own FK constraint; CASCADE here only removes that internal
-- self-reference, not any other table (fin_categories has no dependents outside this migration).
DROP TABLE IF EXISTS fin_categories CASCADE;
DROP TABLE IF EXISTS fin_cost_centers;
