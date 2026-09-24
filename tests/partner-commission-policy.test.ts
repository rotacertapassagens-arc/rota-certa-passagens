import { describe, expect, it } from 'vitest';
import { calculateProgramCommission, nextProgressiveTier, progressiveCommissionBps } from '../shared/partnerCommission.js';

const progressive = {
  mode: 'progressive' as const,
  flatBps: 200,
  tier1MaxPassengers: 20,
  tier1Bps: 200,
  tier2MaxPassengers: 50,
  tier2Bps: 300,
  tier3MaxPassengers: 100,
  tier3Bps: 350,
  tier4Bps: 400,
};

describe('global partner commission policy', () => {
  it('uses the configured progressive bands without retroactively repricing earlier passengers', () => {
    expect(progressiveCommissionBps(1)).toBe(200);
    expect(progressiveCommissionBps(21)).toBe(300);
    expect(progressiveCommissionBps(51)).toBe(350);
    expect(progressiveCommissionBps(101)).toBe(400);
    expect(calculateProgramCommission(70_000, 1, 20, progressive)).toEqual({ amountCents: 2_100, effectiveRateBps: 300, startPosition: 21, endPosition: 21 });
  });

  it('splits a multi-passenger sale proportionally when it crosses a tier', () => {
    // Passenger 20 earns 2%; passengers 21 and 22 earn 3%: €900 × average 2.666…% = €24.
    expect(calculateProgramCommission(90_000, 3, 19, progressive)).toEqual({ amountCents: 2_400, effectiveRateBps: 267, startPosition: 20, endPosition: 22 });
  });

  it('can switch globally to a flat rate', () => {
    const flat = { ...progressive, mode: 'flat' as const, flatBps: 250 };
    expect(calculateProgramCommission(200_000, 4, 99, flat)).toEqual({ amountCents: 5_000, effectiveRateBps: 250, startPosition: 100, endPosition: 103 });
    expect(nextProgressiveTier(20, progressive)).toEqual({ nextTierAt: 51, passengersToNextTier: 30, nextRateBps: 350 });
  });
});
