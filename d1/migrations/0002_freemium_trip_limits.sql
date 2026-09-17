ALTER TABLE trips ADD COLUMN archived_at TEXT;

CREATE INDEX trips_owner_active_idx
  ON trips(owner_user_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX trips_owner_archived_idx
  ON trips(owner_user_id, archived_at DESC)
  WHERE archived_at IS NOT NULL;

UPDATE plans
   SET active=0, checkout_enabled=0
 WHERE code='trial-10d';

UPDATE plans
   SET name='Rota Certa Premium'
 WHERE code='planner-30d';

INSERT OR IGNORE INTO plans (id,code,name,price_cents,currency,duration_days,checkout_enabled,active)
VALUES ('00000000-0000-4000-8000-000000000004','free','Rota Certa Free',0,'EUR',NULL,0,1);
