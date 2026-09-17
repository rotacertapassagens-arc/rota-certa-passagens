DROP INDEX IF EXISTS trips_owner_archived_idx;
DROP INDEX IF EXISTS trips_owner_active_idx;
ALTER TABLE trips DROP COLUMN IF EXISTS archived_at;
DELETE FROM plans WHERE code='free';
UPDATE plans SET active=true WHERE code='trial-10d';
UPDATE plans SET name='Rota Certa Planner' WHERE code='planner-30d';
DELETE FROM schema_migrations WHERE version='0002_freemium_trip_limits';
