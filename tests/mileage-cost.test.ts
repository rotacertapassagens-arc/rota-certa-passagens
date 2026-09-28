import { describe, expect, it } from 'vitest';
import { allocationCostCents, unitCostMicros } from '../shared/mileageCost.js';

describe('allocationCostCents', () => {
  it('computes an exact proportional cost when it divides evenly', () => {
    // 100 000 cents for 100 000 miles = 1 cent/mile; allocating 30 000 miles costs 30 000 cents.
    expect(allocationCostCents(100_000, 100_000, 30_000)).toBe(30_000);
  });

  it('rounds half up instead of truncating', () => {
    // 100 cents for 3 miles = 33.333.. cents/mile; allocating 1 mile rounds to 33, not 33.33.
    expect(allocationCostCents(100, 3, 1)).toBe(33);
    // Allocating all 3 miles must recover the full total.
    expect(allocationCostCents(100, 3, 3)).toBe(100);
  });

  it('never drifts due to floating point, even with large totals', () => {
    // A total that is exactly representable but whose naive float division is not.
    expect(allocationCostCents(1_000_000_007, 3, 1)).toBe(Math.round(1_000_000_007 / 3));
  });

  it('rejects non-positive or non-integer inputs', () => {
    expect(() => allocationCostCents(0, 100, 10)).toThrow('invalid_total_cost');
    expect(() => allocationCostCents(100, 0, 10)).toThrow('invalid_quantity_purchased');
    expect(() => allocationCostCents(100, 100, 0)).toThrow('invalid_quantity_allocated');
    expect(() => allocationCostCents(100.5, 100, 10)).toThrow('invalid_total_cost');
  });

  it('allocating the full purchased quantity always recovers exactly the total cost', () => {
    expect(allocationCostCents(777, 13, 13)).toBe(777);
  });
});

describe('unitCostMicros', () => {
  it('computes cost per mile in micros of a cent', () => {
    // 1 cent/mile = 1_000_000 micros/mile.
    expect(unitCostMicros(100_000, 100_000)).toBe(1_000_000);
  });

  it('truncates (never used for further money math, only display)', () => {
    expect(unitCostMicros(100, 3)).toBe(33_333_333);
  });

  it('rejects non-positive inputs', () => {
    expect(() => unitCostMicros(0, 100)).toThrow('invalid_total_cost');
    expect(() => unitCostMicros(100, 0)).toThrow('invalid_quantity_purchased');
  });
});
