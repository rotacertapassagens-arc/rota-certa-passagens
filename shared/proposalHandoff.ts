/**
 * WHA-04: o formulário de proposta do site passa o atendimento para o WhatsApp.
 *
 * O formulário é a fonte dos dados. Depois de salvo, o cliente recebe um protocolo RC-AAAA-NNNNN e
 * um botão que abre o WhatsApp da Rota Certa com uma mensagem pronta. O WHA-01 reconhece o
 * protocolo nessa mensagem e chama o WHA-04, que consulta o site de servidor para servidor
 * (GET /api/internal/proposals/{protocol}?phone=...) e cria o orçamento no Notion.
 *
 * Este módulo guarda só regras puras (sem banco nem rede), para o Worker e os testes usarem a
 * mesma fonte: formato do protocolo, telefone, mensagem do WhatsApp e o contrato devolvido ao WHA-04.
 */

export const ROTA_CERTA_WHATSAPP_NUMBER = '351925307391';

/** Versão do texto de consentimento que cita o WhatsApp. Pedido sem ela não conta como aceite do WhatsApp. */
export const QUOTE_CONSENT_VERSION = 'proposta-whatsapp-2026-10-01';

export const RECEIVED_STATUS = 'received_awaiting_whatsapp';
export const RECEIVED_STATUS_LABEL = 'Recebida — aguardando início no WhatsApp';

export const STOPS_OPTIONS = ['Sem preferência', 'Aceito escalas', 'Somente voo direto'] as const;

const PROTOCOL_RE = /^RC-\d{4}-\d{5,}$/;
const PHONE_DIGITS_RE = /^[1-9]\d{7,14}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Mesmo formato do printf('RC-%04d-%05d', ...) usado na gravação do pedido. */
export function formatProtocol(year: number, sequence: number) {
  return `RC-${String(year).padStart(4, '0')}-${String(sequence).padStart(5, '0')}`;
}

export function normalizeProtocol(value: unknown): string | null {
  const protocol = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return PROTOCOL_RE.test(protocol) ? protocol : null;
}

export function whatsappHandoffMessage(protocol: string) {
  return `Olá! Acabei de enviar uma solicitação de orçamento pelo site da Rota Certa. Meu protocolo é ${protocol}. Quero continuar o atendimento pelo WhatsApp.`;
}

export function whatsappHandoffUrl(protocol: string) {
  return `https://wa.me/${ROTA_CERTA_WHATSAPP_NUMBER}?text=${encodeURIComponent(whatsappHandoffMessage(protocol))}`;
}

/**
 * Telefone digitado no formulário. Exige o código do país (+ ou 00), porque o WhatsApp identifica o
 * cliente pelo número internacional completo e a conferência do WHA-04 não aceita número parcial.
 * Devolve só os dígitos (E.164 sem o +).
 */
export function customerPhoneDigits(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!/^(\+|00)[0-9 ().-]{7,30}$/.test(raw)) return null;
  const digits = (raw.startsWith('+') ? raw.slice(1) : raw.slice(2)).replace(/\D/g, '');
  return PHONE_DIGITS_RE.test(digits) ? canonicalBrazilMobile(digits) : null;
}

/** Telefone que chega do WHA-04: qualquer formatação vira só dígitos; a comparação é sempre do número inteiro. */
export function lookupPhoneDigits(value: unknown): string | null {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  return PHONE_DIGITS_RE.test(digits) ? canonicalBrazilMobile(digits) : null;
}

/**
 * Celular brasileiro no formato antigo (55 + DDD + 8 dígitos começando por 6-9) ganha o 9. É o mesmo
 * número escrito de duas formas: o WhatsApp ainda entrega contas antigas sem o 9. Igual ao WHA-04.
 */
export function canonicalBrazilMobile(digits: string) {
  return digits.length === 12 && digits.startsWith('55') && /[6-9]/.test(digits[4]!) ? `${digits.slice(0, 4)}9${digits.slice(4)}` : digits;
}

/** undefined = campo ausente (página antiga em cache); false = inválido. */
export function submissionIdOf(value: unknown): string | null | false {
  if (value === undefined || value === null || value === '') return null;
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return UUID_RE.test(id) ? id : false;
}

export function stopsPreferenceOf(value: unknown): (typeof STOPS_OPTIONS)[number] | null | false {
  if (value === undefined || value === null || value === '') return null;
  return (STOPS_OPTIONS as readonly string[]).includes(String(value)) ? value as (typeof STOPS_OPTIONS)[number] : false;
}

export interface VisitSource {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  source_page: string | null;
  source_referrer: string | null;
  source_captured_at: string | null;
}

/** Origem da visita (UTMs, página de entrada, site de onde veio e horário). Tudo opcional; o que vier fora do formato é descartado. */
export function visitSourceOf(value: unknown): VisitSource {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const clean = (input: unknown, max: number) => {
    const v = typeof input === 'string' ? input.trim() : '';
    return v && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : null;
  };
  const page = clean(raw.page, 300);
  const referrer = clean(raw.referrer, 253);
  const capturedText = clean(raw.capturedAt, 40);
  const capturedMs = capturedText ? Date.parse(capturedText) : Number.NaN;
  const capturedOk = Number.isFinite(capturedMs) && capturedMs <= Date.now() + 5 * 60_000 && capturedMs >= Date.now() - 90 * 86_400_000;
  return {
    utm_source: clean(raw.utm_source, 200),
    utm_medium: clean(raw.utm_medium, 200),
    utm_campaign: clean(raw.utm_campaign, 200),
    utm_content: clean(raw.utm_content, 200),
    utm_term: clean(raw.utm_term, 200),
    source_page: page && page.startsWith('/') && !page.startsWith('//') ? page : null,
    source_referrer: referrer && /^[a-z0-9.-]+$/i.test(referrer) ? referrer.toLowerCase() : null,
    source_captured_at: capturedOk ? new Date(capturedMs).toISOString() : null,
  };
}

/**
 * Contrato devolvido ao WHA-04. Nomes internos do banco são traduzidos aqui, na borda da API, para os
 * valores canônicos do WHA-04 (integrations/n8n/wha04/wha04Logic.js): tipoViagem so_ida/ida_e_volta,
 * cabine economica/premium_economica/executiva/primeira.
 */
export interface InternalProposal {
  protocol: string;
  phone: string;
  name: string;
  contactName: string;
  collected: {
    origem: string;
    destino: string;
    tipoViagem: 'ida_e_volta' | 'so_ida' | null;
    dataIda: string | null;
    dataVolta: string | null;
    adultos: number;
    criancas: number;
    bebes: number;
    cabine: 'economica' | 'premium_economica' | 'executiva' | 'primeira' | null;
    bagagem: 'item_pessoal' | 'bagagem_de_mao' | 'bagagem_despachada' | null;
    aceitaEscalas: boolean | null;
    vooDireto: boolean | null;
    companhiaPreferida: string | null;
    maxEscalas: number | null;
    consentimento: boolean;
  };
  classificacao: 'normal';
}

const TRIP_TYPES: Record<string, InternalProposal['collected']['tipoViagem']> = { 'Ida e volta': 'ida_e_volta', 'Somente ida': 'so_ida' };
const CABINS: Record<string, InternalProposal['collected']['cabine']> = { 'Econômica': 'economica', 'Premium Economy': 'premium_economica', 'Executiva': 'executiva', 'Primeira classe': 'primeira' };
const BAGGAGE: Record<string, InternalProposal['collected']['bagagem']> = { 'Somente item pessoal': 'item_pessoal', 'Bagagem de mão': 'bagagem_de_mao', 'Bagagem despachada': 'bagagem_despachada' };

export function toInternalProposal(row: Record<string, unknown>): InternalProposal {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const int = (v: unknown) => (Number.isInteger(Number(v)) ? Number(v) : 0);
  const stops = str(row.stops_preference);
  const name = str(row.customer_name) ?? '';
  return {
    protocol: String(row.protocol),
    phone: String(row.customer_phone_digits),
    name,
    contactName: name,
    collected: {
      origem: str(row.origin) ?? '',
      destino: str(row.destination) ?? '',
      tipoViagem: TRIP_TYPES[String(row.trip_type)] ?? null,
      dataIda: str(row.outbound_on),
      dataVolta: str(row.return_on),
      adultos: int(row.adults),
      criancas: int(row.children),
      bebes: int(row.infants),
      cabine: CABINS[String(row.cabin_class)] ?? null,
      // "Ainda não sei" e valores desconhecidos ficam null: o site nunca inventa uma preferência.
      bagagem: BAGGAGE[String(row.baggage)] ?? null,
      aceitaEscalas: stops === 'Aceito escalas' ? true : stops === 'Somente voo direto' ? false : null,
      vooDireto: stops === 'Somente voo direto' ? true : stops === 'Aceito escalas' ? false : null,
      companhiaPreferida: null,
      maxEscalas: null,
      // Só é true quando o aceite do texto que cita o WhatsApp foi gravado neste pedido.
      consentimento: Number(row.contact_consent) === 1 && typeof row.whatsapp_consent_at === 'string' && row.whatsapp_consent_at.length > 0,
    },
    classificacao: 'normal',
  };
}
