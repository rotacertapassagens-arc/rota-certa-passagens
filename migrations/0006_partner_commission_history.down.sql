-- Down migration for 0006. Note: this can only succeed if the data at rollback time still
-- satisfies the constraints being restored (e.g. at most one commission per lead_request_id in
-- total, not just one non-voided one). If reconversions created real history, restoring the
-- absolute unique constraint will fail with a clear Postgres error — that is intentional: an
-- automatic rollback must never silently delete financial history to make a constraint fit.
DROP INDEX IF EXISTS notification_outbox_claimable_idx;
ALTER TABLE notification_outbox DROP COLUMN IF EXISTS lease_expires_at;
ALTER TABLE notification_outbox DROP COLUMN IF EXISTS lock_token;
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_status_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_status_check
  CHECK (status IN ('pending','sent','failed','skipped'));

ALTER TABLE partner_commissions DROP CONSTRAINT IF EXISTS partner_commissions_currency_allowlist_check;
ALTER TABLE lead_requests DROP CONSTRAINT IF EXISTS lead_requests_sale_currency_allowlist_check;
ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_currency_allowlist_check;

DROP INDEX IF EXISTS partners_email_unique_idx;

DROP INDEX IF EXISTS partner_commissions_lead_request_idx;
DROP INDEX IF EXISTS partner_commissions_active_unique_idx;
ALTER TABLE partner_commissions ADD CONSTRAINT partner_commissions_lead_request_id_key UNIQUE (lead_request_id);
