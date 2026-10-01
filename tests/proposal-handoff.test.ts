/**
 * WHA-04: regras puras da passagem do formulário de proposta para o WhatsApp (shared/proposalHandoff.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  customerPhoneDigits, formatProtocol, lookupPhoneDigits, normalizeProtocol, QUOTE_CONSENT_VERSION, stopsPreferenceOf,
  submissionIdOf, toInternalProposal, visitSourceOf, whatsappHandoffMessage, whatsappHandoffUrl,
} from '../shared/proposalHandoff.js';

const EXPECTED_MESSAGE = 'Olá! Acabei de enviar uma solicitação de orçamento pelo site da Rota Certa. Meu protocolo é RC-2026-00125. Quero continuar o atendimento pelo WhatsApp.';

const row = {
  protocol: 'RC-2026-00125', customer_phone_digits: '351912345678', customer_name: 'Maria Souza', customer_email: 'maria@example.com',
  origin: 'Lisboa', destination: 'São Paulo', trip_type: 'Ida e volta', outbound_on: '2026-11-10', return_on: '2026-11-25',
  adults: 2, children: 0, infants: 0, cabin_class: 'Econômica', baggage: 'Ainda não sei', stops_preference: 'Aceito escalas',
  payment_preference: 'Pix', notes: 'nota interna', contact_consent: 1, whatsapp_consent_at: '2026-10-01 10:00:00',
  utm_source: 'instagram', internal_notes: 'segredo', sale_amount_cents: 99900,
};

describe('mensagem e link do WhatsApp', () => {
  it('usa exatamente a mensagem definida, trocando só o protocolo', () => {
    expect(whatsappHandoffMessage('RC-2026-00125')).toBe(EXPECTED_MESSAGE);
  });
  it('abre o WhatsApp da Rota Certa com a mensagem codificada', () => {
    const url = new URL(whatsappHandoffUrl('RC-2026-00125'));
    expect(url.origin + url.pathname).toBe('https://wa.me/351925307391');
    expect(url.searchParams.get('text')).toBe(EXPECTED_MESSAGE);
  });
});

describe('protocolo RC-AAAA-NNNNN', () => {
  it('formata ano e sequência com zeros à esquerda', () => {
    expect(formatProtocol(2026, 1)).toBe('RC-2026-00001');
    expect(formatProtocol(2026, 125)).toBe('RC-2026-00125');
  });
  it('aceita só o formato novo, em maiúsculas', () => {
    expect(normalizeProtocol(' rc-2026-00125 ')).toBe('RC-2026-00125');
    expect(normalizeProtocol('RC-20260928-ABC123')).toBeNull();
    expect(normalizeProtocol('RC-2026-0012')).toBeNull();
    expect(normalizeProtocol("RC-2026-00125' OR 1=1")).toBeNull();
    expect(normalizeProtocol(undefined)).toBeNull();
  });
});

describe('telefone', () => {
  it('exige código do país e guarda só os dígitos', () => {
    expect(customerPhoneDigits('+351 912 345 678')).toBe('351912345678');
    expect(customerPhoneDigits('+55 (11) 91234-5678')).toBe('5511912345678');
    expect(customerPhoneDigits('0055 11 91234 5678')).toBe('5511912345678');
    expect(customerPhoneDigits('912 345 678')).toBeNull();
    expect(customerPhoneDigits('(11) 91234-5678')).toBeNull();
    expect(customerPhoneDigits('+0 912 345 678')).toBeNull();
    expect(customerPhoneDigits('+1234567890123456')).toBeNull();
    expect(customerPhoneDigits('')).toBeNull();
  });
  it('celular brasileiro sem o 9 vira o mesmo número com o 9; fixo e outros países não mudam', () => {
    expect(customerPhoneDigits('+55 11 9123-4567')).toBe('5511991234567');
    expect(lookupPhoneDigits('551191234567')).toBe('5511991234567');
    expect(lookupPhoneDigits('5511991234567')).toBe('5511991234567');
    expect(lookupPhoneDigits('551132345678')).toBe('551132345678');
    expect(lookupPhoneDigits('351912345678')).toBe('351912345678');
  });
  it('na consulta, qualquer formatação vira só dígitos, sem completar número parcial', () => {
    expect(lookupPhoneDigits('+351 912 345 678')).toBe('351912345678');
    expect(lookupPhoneDigits(' 351912345678')).toBe('351912345678');
    expect(lookupPhoneDigits('912345678')).toBe('912345678');
    expect(lookupPhoneDigits('1234')).toBeNull();
    expect(lookupPhoneDigits(null)).toBeNull();
  });
});

describe('campos opcionais do envio', () => {
  it('identificador de envio: ausente é null, fora do formato é inválido', () => {
    expect(submissionIdOf(undefined)).toBeNull();
    expect(submissionIdOf('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(submissionIdOf('abc')).toBe(false);
  });
  it('escalas: só as opções do formulário', () => {
    expect(stopsPreferenceOf(undefined)).toBeNull();
    expect(stopsPreferenceOf('Somente voo direto')).toBe('Somente voo direto');
    expect(stopsPreferenceOf('Qualquer')).toBe(false);
  });
  it('origem da visita: preserva UTMs, página e horário; descarta o que vem fora do formato', () => {
    const capturedAt = new Date(Date.now() - 60_000).toISOString();
    expect(visitSourceOf({ utm_source: 'instagram', utm_medium: 'bio', utm_campaign: 'outubro', utm_content: 'reel-1', utm_term: 'lisboa', page: '/proposta-voo.html', referrer: 'L.Instagram.com', capturedAt })).toEqual({
      utm_source: 'instagram', utm_medium: 'bio', utm_campaign: 'outubro', utm_content: 'reel-1', utm_term: 'lisboa',
      source_page: '/proposta-voo.html', source_referrer: 'l.instagram.com', source_captured_at: capturedAt,
    });
    expect(visitSourceOf({ utm_source: 'x'.repeat(201), page: '//evil.example', referrer: 'https://evil.example/path', capturedAt: '2099-01-01T00:00:00Z' })).toEqual({
      utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null,
      source_page: null, source_referrer: null, source_captured_at: null,
    });
    expect(visitSourceOf(undefined).utm_source).toBeNull();
  });
});

describe('contrato devolvido ao WHA-04', () => {
  it('traduz os nomes do banco e devolve só os campos mínimos', () => {
    expect(toInternalProposal(row)).toEqual({
      protocol: 'RC-2026-00125',
      phone: '351912345678',
      name: 'Maria Souza',
      contactName: 'Maria Souza',
      collected: {
        origem: 'Lisboa', destino: 'São Paulo', tipoViagem: 'ida_e_volta', dataIda: '2026-11-10', dataVolta: '2026-11-25',
        adultos: 2, criancas: 0, bebes: 0, cabine: 'economica', bagagem: null, aceitaEscalas: true, vooDireto: false,
        companhiaPreferida: null, maxEscalas: null, consentimento: true,
      },
      classificacao: 'normal',
    });
    const json = JSON.stringify(toInternalProposal(row));
    for (const leaked of ['maria@example.com', 'Pix', 'nota interna', 'segredo', '99900', 'instagram']) expect(json).not.toContain(leaked);
  });
  it('usa os valores canônicos do WHA-04 para todas as classes e trechos', () => {
    const cabine = (cabin_class: string) => toInternalProposal({ ...row, cabin_class }).collected.cabine;
    expect(['Econômica', 'Premium Economy', 'Executiva', 'Primeira classe'].map(cabine)).toEqual(['economica', 'premium_economica', 'executiva', 'primeira']);
    expect(toInternalProposal({ ...row, trip_type: 'Somente ida' }).collected.tipoViagem).toBe('so_ida');
  });
  it('mapeia as demais opções do formulário', () => {
    const one = toInternalProposal({ ...row, trip_type: 'Somente ida', return_on: null, cabin_class: 'Executiva', baggage: 'Bagagem despachada', stops_preference: 'Somente voo direto' });
    expect(one.collected).toMatchObject({ tipoViagem: 'so_ida', dataVolta: null, cabine: 'executiva', bagagem: 'bagagem_despachada', aceitaEscalas: false, vooDireto: true });
    const none = toInternalProposal({ ...row, stops_preference: null });
    expect(none.collected).toMatchObject({ aceitaEscalas: null, vooDireto: null });
  });
  it('consentimento ausente nunca vira true', () => {
    expect(toInternalProposal({ ...row, whatsapp_consent_at: null }).collected.consentimento).toBe(false);
    expect(toInternalProposal({ ...row, whatsapp_consent_at: '' }).collected.consentimento).toBe(false);
    expect(toInternalProposal({ ...row, contact_consent: 0 }).collected.consentimento).toBe(false);
    expect(toInternalProposal({ ...row, contact_consent: undefined, whatsapp_consent_at: undefined }).collected.consentimento).toBe(false);
  });
  it('a versão do consentimento é a mesma da página', async () => {
    const { readFileSync } = await import('node:fs');
    const quoteJs = readFileSync(new URL('../public/assets/quote.js', import.meta.url), 'utf8');
    expect(quoteJs).toContain(`const CONSENT_VERSION='${QUOTE_CONSENT_VERSION}';`);
  });
});
