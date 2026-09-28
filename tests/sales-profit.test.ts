import { describe, expect, it } from 'vitest';
import { calculateSaleProfit, isValidIssuanceTransition, sumIssuanceDirectCostCents } from '../shared/salesProfit.js';

describe('calculateSaleProfit', () => {
  it('computes gross profit and margin in basis points', () => {
    expect(calculateSaleProfit(100000, 70000)).toEqual({ grossProfitCents: 30000, marginBps: 3000 });
  });

  it('handles zero direct cost (100% margin)', () => {
    expect(calculateSaleProfit(50000, 0)).toEqual({ grossProfitCents: 50000, marginBps: 10000 });
  });

  it('handles direct cost exceeding net amount (negative margin)', () => {
    expect(calculateSaleProfit(50000, 60000)).toEqual({ grossProfitCents: -10000, marginBps: -2000 });
  });

  it('rejects a net amount of zero or negative instead of dividing by zero', () => {
    expect(() => calculateSaleProfit(0, 1000)).toThrow('invalid_net_amount');
    expect(() => calculateSaleProfit(-100, 0)).toThrow('invalid_net_amount');
  });

  it('rejects a negative direct cost', () => {
    expect(() => calculateSaleProfit(1000, -1)).toThrow('invalid_direct_cost');
  });
});

describe('sumIssuanceDirectCostCents', () => {
  it('sums every direct-cost field', () => {
    const total = sumIssuanceDirectCostCents({
      cashAmountCents: 10000, milesCostCents: 5000, airportFeesCents: 1000, issuanceFeeCents: 500,
      consolidatorFeeCents: 300, gatewayFeeCents: 200, agentCommissionCents: 1500, otherCostsCents: 100,
    });
    expect(total).toBe(18600);
  });

  it('sums to zero when every field is zero', () => {
    const total = sumIssuanceDirectCostCents({
      cashAmountCents: 0, milesCostCents: 0, airportFeesCents: 0, issuanceFeeCents: 0,
      consolidatorFeeCents: 0, gatewayFeeCents: 0, agentCommissionCents: 0, otherCostsCents: 0,
    });
    expect(total).toBe(0);
  });
});

describe('isValidIssuanceTransition', () => {
  it('allows pending to issued and pending to canceled', () => {
    expect(isValidIssuanceTransition('pending', 'issued')).toBe(true);
    expect(isValidIssuanceTransition('pending', 'canceled')).toBe(true);
  });

  it('allows issued to refunded only', () => {
    expect(isValidIssuanceTransition('issued', 'refunded')).toBe(true);
    expect(isValidIssuanceTransition('issued', 'canceled')).toBe(false);
  });

  it('rejects any transition out of a terminal state', () => {
    expect(isValidIssuanceTransition('canceled', 'issued')).toBe(false);
    expect(isValidIssuanceTransition('refunded', 'issued')).toBe(false);
  });

  it('rejects skipping straight from pending to refunded', () => {
    expect(isValidIssuanceTransition('pending', 'refunded')).toBe(false);
  });
});
