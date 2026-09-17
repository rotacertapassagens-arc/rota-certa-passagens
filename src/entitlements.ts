import type { Database } from './db.js';

export type AccountTier = 'free' | 'premium' | 'master';

export interface PlannerEntitlement {
  tier: AccountTier;
  unlimited: boolean;
  accessActive: boolean;
  endsAt: Date | null;
  activeTripLimit: number | null;
  archivedTripLimit: number | null;
  premiumFeatures: boolean;
}

export async function plannerEntitlement(db: Database, userId: string, roles: string[]): Promise<PlannerEntitlement> {
  if (roles.includes('master')) return entitlement('master', null);
  const subscription = await db.query<{ code: string; ends_at: Date }>(
    `SELECT p.code,s.ends_at
       FROM subscriptions s
       JOIN plans p ON p.id=s.plan_id
      WHERE s.user_id=$1
        AND s.status IN ('trialing','active')
        AND s.ends_at>now()
        AND p.code IN ('trial-10d','planner-30d')
      ORDER BY CASE WHEN p.code='planner-30d' THEN 0 ELSE 1 END,s.ends_at DESC
      LIMIT 1`,
    [userId],
  );
  const active = subscription.rows[0];
  if (active?.code === 'planner-30d') return entitlement('premium', active.ends_at);
  if (active?.code === 'trial-10d') return entitlement('free', active.ends_at);
  return { ...entitlement('free', null), accessActive: false };
}

function entitlement(tier: AccountTier, endsAt: Date | null): PlannerEntitlement {
  const unlimited = tier !== 'free';
  return {
    tier,
    unlimited,
    accessActive: true,
    endsAt,
    activeTripLimit: unlimited ? null : 1,
    archivedTripLimit: unlimited ? null : 2,
    premiumFeatures: unlimited,
  };
}
