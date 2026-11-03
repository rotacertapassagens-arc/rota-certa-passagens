import { describe, expect, it } from 'vitest';
import { d1Timestamp } from '../shared/d1Timestamp.js';
import { lisbonMonthStartUtc } from '../shared/partnerCommission.js';

// O D1 grava CURRENT_TIMESTAMP assim; as consultas de semana/mês comparam como texto.
const created = (iso: string) => iso.replace('T', ' ').slice(0, 19);

describe('d1Timestamp: limite de semana/mês comparado com colunas do D1', () => {
  it('usa o formato do D1 (espaço, sem milissegundos nem Z)', () => {
    expect(d1Timestamp(new Date('2026-11-02T00:00:00.000Z'))).toBe('2026-11-02 00:00:00');
    expect(d1Timestamp(new Date('2026-07-15T09:08:07.654Z'))).toBe('2026-07-15 09:08:07');
  });

  it('inclui o que foi criado no próprio dia do limite (o bug do ISO deixava de fora)', () => {
    const limit = new Date('2026-11-02T00:00:00.000Z'); // segunda-feira, início da semana
    const rowSameDay = created('2026-11-02T14:39:00.000Z');
    // O comportamento antigo: ISO como texto, ' ' < 'T', então a linha do mesmo dia ficava de fora.
    expect(rowSameDay >= limit.toISOString()).toBe(false);
    expect(rowSameDay >= d1Timestamp(limit)).toBe(true);
    expect(created('2026-11-01T23:59:59.000Z') >= d1Timestamp(limit)).toBe(false);
    expect(created('2026-11-03T00:00:00.000Z') >= d1Timestamp(limit)).toBe(true);
  });

  it('dia 1 do mês em Lisboa: horário de inverno e de verão', () => {
    const winter = d1Timestamp(lisbonMonthStartUtc(new Date('2026-11-10T12:00:00Z')));
    expect(winter).toBe('2026-11-01 00:00:00');
    expect(created('2026-11-01T08:00:00.000Z') >= winter).toBe(true);

    // Verão (WEST, UTC+1): a meia-noite de 1 de julho em Lisboa é 23:00 UTC de 30 de junho.
    const summer = d1Timestamp(lisbonMonthStartUtc(new Date('2026-07-15T12:00:00Z')));
    expect(summer).toBe('2026-06-30 23:00:00');
    expect(created('2026-06-30T23:30:00.000Z') >= summer).toBe(true);
    expect(created('2026-06-30T22:59:59.000Z') >= summer).toBe(false);
  });
});
