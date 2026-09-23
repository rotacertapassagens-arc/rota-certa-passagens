/**
 * Shared notification-outbox payload contract between the Node/Postgres backend
 * (src/routes/notifications.ts) and the Cloudflare Worker/D1 backend (worker/index.ts).
 *
 * Both backends read and write the exact same `notification_outbox.payload` shapes for a given
 * `event_type`. A previous version of this code let the two backends drift independently
 * (camelCase vs snake_case field names, a currency silently hardcoded to EUR on one side only),
 * which meant a real commission amount could render as "0.00 EUR" even when the underlying data
 * was correct. This module is the single source of truth for those shapes so drift like that
 * fails typecheck/tests instead of shipping silently. See docs/openapi.yaml for the
 * human-readable API description of the endpoints that produce/consume these payloads.
 */

export const NOTIFICATION_CURRENCIES = ['EUR', 'USD', 'BRL', 'GBP'] as const;
export type NotificationCurrency = (typeof NOTIFICATION_CURRENCIES)[number];

export function isNotificationCurrency(value: unknown): value is NotificationCurrency {
  return typeof value === 'string' && (NOTIFICATION_CURRENCIES as readonly string[]).includes(value.toUpperCase());
}

export interface WeeklySummaryPayload {
  weekStart: string;
  clicks: number;
  proposals: number;
  conversions: number;
  commissionCents: number;
  /** The partner's own configured currency at the time the summary was generated — never a
   * hardcoded default. Required; a payload without it is treated as invalid. */
  currency: NotificationCurrency;
}

/**
 * Validates and normalizes a `weekly_summary` outbox row payload. Throws (rather than silently
 * defaulting a missing/invalid field to 0 or EUR) so a malformed payload surfaces as a failed
 * outbox attempt with a clear error, never as a partner-facing email with a wrong amount.
 */
export function parseWeeklySummaryPayload(payload: unknown): WeeklySummaryPayload {
  const value = (payload ?? {}) as Record<string, unknown>;
  const weekStart = typeof value.weekStart === 'string' && value.weekStart.length > 0 ? value.weekStart : null;
  const clicks = Number(value.clicks);
  const proposals = Number(value.proposals);
  const conversions = Number(value.conversions);
  const commissionCents = Number(value.commissionCents);
  const currencyRaw = typeof value.currency === 'string' ? value.currency.toUpperCase() : '';
  if (
    !weekStart
    || !Number.isFinite(clicks) || clicks < 0
    || !Number.isFinite(proposals) || proposals < 0
    || !Number.isFinite(conversions) || conversions < 0
    || !Number.isFinite(commissionCents) || commissionCents < 0
    || !isNotificationCurrency(currencyRaw)
  ) {
    throw new Error('invalid_weekly_summary_payload');
  }
  return { weekStart, clicks, proposals, conversions, commissionCents, currency: currencyRaw as NotificationCurrency };
}

export interface CommissionPaidPayload {
  commissionId: string;
  amountCents: number;
  currency: NotificationCurrency;
}

/** Validates a `commission_paid` outbox row payload; same fail-closed rationale as above. */
export function parseCommissionPaidPayload(payload: unknown): CommissionPaidPayload {
  const value = (payload ?? {}) as Record<string, unknown>;
  const commissionId = typeof value.commissionId === 'string' && value.commissionId.length > 0 ? value.commissionId : null;
  const amountCents = Number(value.amountCents);
  const currencyRaw = typeof value.currency === 'string' ? value.currency.toUpperCase() : '';
  if (!commissionId || !Number.isFinite(amountCents) || amountCents < 0 || !isNotificationCurrency(currencyRaw)) {
    throw new Error('invalid_commission_paid_payload');
  }
  return { commissionId, amountCents, currency: currencyRaw as NotificationCurrency };
}
