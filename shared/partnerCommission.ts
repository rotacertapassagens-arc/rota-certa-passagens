export const PARTNER_PRIVACY_POLICY_VERSION = '2026-09-24';

export type PartnerCommissionMode = 'flat' | 'progressive';

export interface PartnerCommissionPolicy {
  mode: PartnerCommissionMode;
  flatBps: number;
  tier1MaxPassengers: number;
  tier1Bps: number;
  tier2MaxPassengers: number;
  tier2Bps: number;
  tier3MaxPassengers: number;
  tier3Bps: number;
  tier4Bps: number;
}

export function progressiveCommissionBps(position: number): number {
  if (!Number.isInteger(position) || position < 1) throw new Error('invalid_commission_position');
  if (position <= 20) return 200;
  if (position <= 50) return 300;
  if (position <= 100) return 350;
  return 400;
}

export function calculateProgramCommission(
  saleAmountCents: number,
  passengerCount: number,
  alreadyClosedPassengers: number,
  policy: PartnerCommissionPolicy,
): { amountCents: number; effectiveRateBps: number; startPosition: number; endPosition: number } {
  if (!Number.isInteger(saleAmountCents) || saleAmountCents < 0) throw new Error('invalid_sale_amount');
  if (!Number.isInteger(passengerCount) || passengerCount < 1) throw new Error('invalid_passenger_count');
  if (!Number.isInteger(alreadyClosedPassengers) || alreadyClosedPassengers < 0) throw new Error('invalid_month_passengers');
  const startPosition = alreadyClosedPassengers + 1;
  const endPosition = alreadyClosedPassengers + passengerCount;
  let summedBps = 0;
  for (let position = startPosition; position <= endPosition; position += 1) {
    if (policy.mode === 'flat') summedBps += policy.flatBps;
    else if (position <= policy.tier1MaxPassengers) summedBps += policy.tier1Bps;
    else if (position <= policy.tier2MaxPassengers) summedBps += policy.tier2Bps;
    else if (position <= policy.tier3MaxPassengers) summedBps += policy.tier3Bps;
    else summedBps += policy.tier4Bps;
  }
  const effectiveRateBps = Math.round(summedBps / passengerCount);
  const amountCents = Math.round((saleAmountCents * summedBps) / (passengerCount * 10_000));
  return { amountCents, effectiveRateBps, startPosition, endPosition };
}

export function nextProgressiveTier(currentMonthPassengers: number, policy?: PartnerCommissionPolicy): { nextTierAt: number | null; passengersToNextTier: number; nextRateBps: number | null } {
  const limits = policy ?? { tier1MaxPassengers: 20, tier1Bps: 200, tier2MaxPassengers: 50, tier2Bps: 300, tier3MaxPassengers: 100, tier3Bps: 350, tier4Bps: 400, mode: 'progressive', flatBps: 200 };
  if (currentMonthPassengers < limits.tier1MaxPassengers) return { nextTierAt: limits.tier1MaxPassengers + 1, passengersToNextTier: limits.tier1MaxPassengers - currentMonthPassengers, nextRateBps: limits.tier2Bps };
  if (currentMonthPassengers < limits.tier2MaxPassengers) return { nextTierAt: limits.tier2MaxPassengers + 1, passengersToNextTier: limits.tier2MaxPassengers - currentMonthPassengers, nextRateBps: limits.tier3Bps };
  if (currentMonthPassengers < limits.tier3MaxPassengers) return { nextTierAt: limits.tier3MaxPassengers + 1, passengersToNextTier: limits.tier3MaxPassengers - currentMonthPassengers, nextRateBps: limits.tier4Bps };
  return { nextTierAt: null, passengersToNextTier: 0, nextRateBps: null };
}

/** Returns the UTC instant corresponding to day 1, 00:00 in Europe/Lisbon. */
export function lisbonMonthStartUtc(reference: Date): Date {
  const localParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(reference);
  const year = Number(localParts.find((part) => part.type === 'year')?.value);
  const month = Number(localParts.find((part) => part.type === 'month')?.value);
  const utcGuess = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  const offsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Lisbon', timeZoneName: 'shortOffset',
  }).formatToParts(new Date(utcGuess));
  const zone = offsetParts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?)?$/.exec(zone);
  const sign = match?.groups?.sign === '-' ? -1 : 1;
  const offsetMinutes = match?.groups?.hours
    ? sign * (Number(match.groups.hours) * 60 + Number(match.groups.minutes ?? 0))
    : 0;
  return new Date(utcGuess - offsetMinutes * 60_000);
}
