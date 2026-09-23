import { describe, expect, it } from 'vitest';
import { isValidCurrency, lisbonWeekStartUtc } from '../src/security.js';

describe('lisbonWeekStartUtc', () => {
  it('returns the correct Monday 00:00 Europe/Lisbon instant in winter (WET, UTC+0)', () => {
    // Thursday 2026-01-15 12:00 UTC -> week's Monday is 2026-01-12, and Lisbon is UTC+0 in
    // January, so Monday 00:00 Lisbon local time is also 2026-01-12T00:00:00Z.
    const reference = new Date('2026-01-15T12:00:00Z');
    const weekStart = lisbonWeekStartUtc(reference);
    expect(weekStart.toISOString()).toBe('2026-01-12T00:00:00.000Z');
  });

  it('returns the correct Monday 00:00 Europe/Lisbon instant in summer (WEST, UTC+1)', () => {
    // Thursday 2026-07-16 12:00 UTC -> week's Monday is 2026-07-13, and Lisbon is UTC+1 in July
    // (daylight saving), so Monday 00:00 Lisbon local time is 2026-07-12T23:00:00Z.
    const reference = new Date('2026-07-16T12:00:00Z');
    const weekStart = lisbonWeekStartUtc(reference);
    expect(weekStart.toISOString()).toBe('2026-07-12T23:00:00.000Z');
  });

  it('is stable regardless of the reference instant\'s own time of day', () => {
    const early = lisbonWeekStartUtc(new Date('2026-03-04T00:05:00Z'));
    const late = lisbonWeekStartUtc(new Date('2026-03-06T23:55:00Z'));
    expect(early.toISOString()).toBe(late.toISOString());
  });

  it('handles a reference date that already is the Monday', () => {
    // 2026-02-02 is a Monday; Lisbon is still UTC+0 in February.
    const reference = new Date('2026-02-02T08:00:00Z');
    const weekStart = lisbonWeekStartUtc(reference);
    expect(weekStart.toISOString()).toBe('2026-02-02T00:00:00.000Z');
  });
});

describe('isValidCurrency', () => {
  it('accepts only the product\'s supported ISO currencies', () => {
    expect(isValidCurrency('EUR')).toBe(true);
    expect(isValidCurrency('usd')).toBe(true);
    expect(isValidCurrency('BRL')).toBe(true);
    expect(isValidCurrency('GBP')).toBe(true);
    expect(isValidCurrency('JPY')).toBe(false);
    expect(isValidCurrency('XXX')).toBe(false);
    expect(isValidCurrency('EU')).toBe(false);
  });
});
