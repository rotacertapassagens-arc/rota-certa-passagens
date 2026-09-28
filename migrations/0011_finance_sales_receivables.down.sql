-- fin_receivable_payments self-references itself (reversal_of); CASCADE only drops that own FK.
DROP TABLE IF EXISTS fin_receivable_payments CASCADE;
DROP TABLE IF EXISTS fin_receivables;
DROP TABLE IF EXISTS fin_sales;
