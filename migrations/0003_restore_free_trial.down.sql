UPDATE plans
   SET name='Teste do Planner', active=false, checkout_enabled=false
 WHERE code='trial-10d';
DELETE FROM schema_migrations WHERE version='0003_restore_free_trial';
