-- fin_obligation_payments self-references itself (reversal_of), so CASCADE here only drops its
-- own internal FK, not any other table (same reasoning as 0009's fin_categories self-reference).
DROP TABLE IF EXISTS fin_obligation_payments CASCADE;
DROP TABLE IF EXISTS fin_obligations;
DROP TABLE IF EXISTS fin_subscription_price_history;
DROP TABLE IF EXISTS fin_subscriptions;
