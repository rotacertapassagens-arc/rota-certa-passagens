import { describe, expect, it } from 'vitest';
import { isValidSubscriptionTransition, nextChargeDate, subscriptionChargeIdempotencyKey } from '../shared/subscriptionSchedule.js';

describe('nextChargeDate', () => {
  it('advances monthly periodicity by one calendar month', () => {
    expect(nextChargeDate('2026-01-15', 'monthly')).toBe('2026-02-15');
  });

  it('clamps Jan 31 + 1 month to Feb 28 in a non-leap year', () => {
    expect(nextChargeDate('2026-01-31', 'monthly')).toBe('2026-02-28');
  });

  it('clamps Jan 31 + 1 month to Feb 29 in a leap year', () => {
    expect(nextChargeDate('2028-01-31', 'monthly')).toBe('2028-02-29');
  });

  it('advances quarterly periodicity by three months', () => {
    expect(nextChargeDate('2026-11-30', 'quarterly')).toBe('2027-02-28');
  });

  it('advances semiannual periodicity by six months', () => {
    expect(nextChargeDate('2026-03-15', 'semiannual')).toBe('2026-09-15');
  });

  it('advances annual periodicity by twelve months, crossing a leap day correctly', () => {
    expect(nextChargeDate('2028-02-29', 'annual')).toBe('2029-02-28');
  });

  it('rolls over the year boundary', () => {
    expect(nextChargeDate('2026-12-05', 'monthly')).toBe('2027-01-05');
  });

  it('advances custom periodicity by a fixed number of days', () => {
    expect(nextChargeDate('2026-01-01', 'custom', 45)).toBe('2026-02-15');
  });

  it('rejects an invalid or missing custom interval', () => {
    expect(() => nextChargeDate('2026-01-01', 'custom')).toThrow('invalid_custom_interval');
    expect(() => nextChargeDate('2026-01-01', 'custom', 0)).toThrow('invalid_custom_interval');
  });

  it('rejects a malformed date', () => {
    expect(() => nextChargeDate('not-a-date', 'monthly')).toThrow('invalid_date');
  });
});

describe('subscriptionChargeIdempotencyKey', () => {
  it('is deterministic for the same subscription and period', () => {
    const a = subscriptionChargeIdempotencyKey('sub-1', '2026-02-15');
    const b = subscriptionChargeIdempotencyKey('sub-1', '2026-02-15');
    expect(a).toBe(b);
  });

  it('differs across subscriptions and across periods', () => {
    expect(subscriptionChargeIdempotencyKey('sub-1', '2026-02-15')).not.toBe(subscriptionChargeIdempotencyKey('sub-2', '2026-02-15'));
    expect(subscriptionChargeIdempotencyKey('sub-1', '2026-02-15')).not.toBe(subscriptionChargeIdempotencyKey('sub-1', '2026-03-15'));
  });
});

describe('isValidSubscriptionTransition', () => {
  it('allows the documented state machine transitions', () => {
    expect(isValidSubscriptionTransition('trial', 'active')).toBe(true);
    expect(isValidSubscriptionTransition('active', 'suspended')).toBe(true);
    expect(isValidSubscriptionTransition('suspended', 'active')).toBe(true);
    expect(isValidSubscriptionTransition('active', 'ended')).toBe(true);
  });

  it('rejects transitions out of terminal states', () => {
    expect(isValidSubscriptionTransition('canceled', 'active')).toBe(false);
    expect(isValidSubscriptionTransition('ended', 'active')).toBe(false);
  });

  it('rejects skipping straight from trial to ended', () => {
    expect(isValidSubscriptionTransition('trial', 'ended')).toBe(false);
  });
});
