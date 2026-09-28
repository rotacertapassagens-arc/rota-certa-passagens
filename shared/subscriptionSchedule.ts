export type SubscriptionPeriodicity = 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'custom';

const PERIOD_MONTHS: Record<Exclude<SubscriptionPeriodicity, 'custom'>, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

function daysInMonth(year: number, month1to12: number): number {
  // Day 0 of the *next* month is the last day of this one — plain UTC calendar math, no
  // timezone involved (subscription due dates are civil dates, never timestamps).
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/**
 * Advances a subscription's next-charge civil date by exactly one period. Month-based
 * periodicities clamp the day-of-month to the last valid day of the target month instead of
 * overflowing into the following month (Jan 31 + 1 month -> Feb 28, or Feb 29 in a leap year) —
 * this is the "mês com quantidade diferente de dias" case the finance module's tests must cover.
 * `custom` adds a fixed number of days instead of a calendar month count.
 */
export function nextChargeDate(currentDateIso: string, periodicity: SubscriptionPeriodicity, customIntervalDays?: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(currentDateIso);
  if (!match) throw new Error('invalid_date');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (periodicity === 'custom') {
    if (!Number.isInteger(customIntervalDays) || (customIntervalDays as number) < 1 || (customIntervalDays as number) > 3650) {
      throw new Error('invalid_custom_interval');
    }
    const base = Date.UTC(year, month - 1, day);
    const next = new Date(base + (customIntervalDays as number) * 86_400_000);
    return next.toISOString().slice(0, 10);
  }

  const monthsToAdd = PERIOD_MONTHS[periodicity];
  const totalMonths = (month - 1) + monthsToAdd;
  const nextYear = year + Math.floor(totalMonths / 12);
  const nextMonth = (totalMonths % 12) + 1;
  const clampedDay = Math.min(day, daysInMonth(nextYear, nextMonth));
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}

/** Idempotency key for a subscription's charge in a given period — same subscription + same period date never creates a second fin_obligations row. */
export function subscriptionChargeIdempotencyKey(subscriptionId: string, periodDateIso: string): string {
  return `subscription_charge:${subscriptionId}:${periodDateIso}`;
}

const SUBSCRIPTION_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  trial: ['active', 'canceled'],
  active: ['suspended', 'canceled', 'ended'],
  suspended: ['active', 'canceled', 'ended'],
  canceled: [],
  ended: [],
};

export function isValidSubscriptionTransition(from: string, to: string): boolean {
  return (SUBSCRIPTION_STATUS_TRANSITIONS[from] ?? []).includes(to);
}
