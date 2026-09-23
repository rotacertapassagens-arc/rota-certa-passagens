-- Pre-staging correction pass on the partner referral program (migration 0005).
-- Created as a new migration rather than editing 0005 in place: 0005 cannot be proven to have
-- never been applied outside this local/test environment, so per the project's migration
-- discipline this ships as an additive 0006 instead of rewriting history.

-- 1) A proposal can now have more than one *historical* commission row (converted -> voided ->
--    reconverted), but at most one non-voided commission at a time. Replace the absolute unique
--    constraint on lead_request_id with a partial unique index that only applies to active rows.
ALTER TABLE partner_commissions DROP CONSTRAINT IF EXISTS partner_commissions_lead_request_id_key;
CREATE UNIQUE INDEX partner_commissions_active_unique_idx
  ON partner_commissions (lead_request_id)
  WHERE status <> 'void';
-- Historical lookups (master detail view, ledger current-commission subquery) still need an
-- index on the plain column since it's no longer backed by the dropped unique constraint.
CREATE INDEX partner_commissions_lead_request_idx ON partner_commissions (lead_request_id, created_at DESC);

-- 2) A partner's email is the join key used by the invite flow; without a uniqueness guarantee
--    two partner rows could race to claim the same user account. Enforced case-insensitively
--    since the application always normalizes email to lowercase before writing it.
CREATE UNIQUE INDEX partners_email_unique_idx ON partners (lower(email));

-- 3) Currency fields become a real ISO allowlist instead of "any 3 characters", matching
--    security.ts's ALLOWED_CURRENCIES so the database is a second line of defense, not just the
--    application layer.
ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_currency_allowlist_check;
ALTER TABLE partners ADD CONSTRAINT partners_currency_allowlist_check CHECK (currency IN ('EUR','USD','BRL','GBP'));
ALTER TABLE lead_requests DROP CONSTRAINT IF EXISTS lead_requests_sale_currency_allowlist_check;
ALTER TABLE lead_requests ADD CONSTRAINT lead_requests_sale_currency_allowlist_check CHECK (sale_currency IS NULL OR sale_currency IN ('EUR','USD','BRL','GBP'));
ALTER TABLE partner_commissions DROP CONSTRAINT IF EXISTS partner_commissions_currency_allowlist_check;
ALTER TABLE partner_commissions ADD CONSTRAINT partner_commissions_currency_allowlist_check CHECK (currency IN ('EUR','USD','BRL','GBP'));

-- 4) Outbox claim/lease columns so two concurrent processors can never both send the same
--    notification: a worker must atomically claim a row (status='processing', its own lock
--    token, a lease expiry) before it is allowed to send, and only that same token may later
--    flip the row to 'sent'/'failed'. An expired lease (crash mid-send) becomes claimable again.
-- As with 0005's user_roles/account_tokens constraints: the original inline, unnamed CHECK on
-- notification_outbox.status gets Postgres's standard auto-generated name
-- (notification_outbox_status_check), but pg-mem (used only by this repo's test suite) names the
-- very same constraint differently (notification_outbox_constraint_3, being the third unnamed
-- inline CHECK in that table's original definition order). Both spellings are dropped
-- defensively so this migration behaves identically in every environment it actually runs in.
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_status_check;
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_constraint_3;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_status_check
  CHECK (status IN ('pending','processing','sent','failed','skipped'));
ALTER TABLE notification_outbox ADD COLUMN lock_token uuid;
ALTER TABLE notification_outbox ADD COLUMN lease_expires_at timestamptz;
CREATE INDEX notification_outbox_claimable_idx ON notification_outbox (status, next_attempt_at, lease_expires_at);
