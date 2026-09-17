import type { Database } from './db.js';

export type AccountTier = 'free' | 'premium' | 'master';

export interface PlannerEntitlement {
  tier: AccountTier;
  unlimited: boolean;
  activeTripLimit: number | null;
  archivedTripLimit: number | null;
  premiumFeatures: boolean;
}

export async function plannerEntitlement(db: Database, userId: string, roles: string[]): Promise<PlannerEntitlement> {
  if (roles.includes('master')) return entitlement('master');
  const subscription = await db.query(
    `SELECT 1
       FROM subscriptions s
       JOIN plans p ON p.id=s.plan_id
      WHERE s.user_id=$1
        AND s.status IN ('trialing','active')
        AND s.ends_at>now()
        AND p.code IN ('trial-10d','planner-30d')
      LIMIT 1`,
    [userId],
  );
  return entitlement(subscription.rowCount ? 'premium' : 'free');
}

function entitlement(tier: AccountTier): PlannerEntitlement {
  const unlimited = tier !== 'free';
  return {
    tier,
    unlimited,
    activeTripLimit: unlimited ? null : 1,
    archivedTripLimit: unlimited ? null : 2,
    premiumFeatures: unlimited,
  };
}
