// WHA-04: rota exclusiva de servidor para servidor. O n8n consulta um pedido de proposta pelo protocolo
// e pelo telefone do WhatsApp e recebe só os campos mínimos do contrato (shared/proposalHandoff.ts).
// Nada aqui é usado por páginas do site; o token vive só no segredo ROTA_CERTA_SITE_API_TOKEN do Worker.
import { lookupPhoneDigits, normalizeProtocol, toInternalProposal } from '../shared/proposalHandoff.js';

type Row = Record<string, unknown>;
type InternalApiSecrets = { ROTA_CERTA_SITE_API_TOKEN?: string };

export interface InternalApiDeps {
  reply: (data: unknown, status?: number, headers?: HeadersInit) => Response;
  safeEqual: (a: string, b: string) => Promise<boolean>;
  rateLimit: (req: Request, env: Env, scope: string, target: string, max: number, windowSeconds: number) => Promise<boolean>;
  rateLimitBlocked: (req: Request, env: Env, scope: string, target: string) => Promise<boolean>;
}

const MIN_TOKEN_LENGTH = 32;
// Por IP de origem. O n8n faz uma consulta por mensagem com protocolo; 120 por minuto sobra para picos.
const REQUESTS_PER_MINUTE = 120;
// Credencial errada: 10 tentativas em 15 minutos bloqueiam aquele IP por 15 minutos.
const AUTH_FAILURES = 10;
const AUTH_FAILURE_WINDOW_SECONDS = 900;

export async function internalApi(req: Request, env: Env, url: URL, deps: InternalApiDeps): Promise<Response> {
  if (await deps.rateLimitBlocked(req, env, 'internal_api_auth_fail', 'all')) return deps.reply({ error: 'try_again_later' }, 429);
  if (!(await deps.rateLimit(req, env, 'internal_api', 'all', REQUESTS_PER_MINUTE, 60))) return deps.reply({ error: 'try_again_later' }, 429);
  if (!(await authorized(req, env, deps))) {
    await deps.rateLimit(req, env, 'internal_api_auth_fail', 'all', AUTH_FAILURES, AUTH_FAILURE_WINDOW_SECONDS);
    return deps.reply({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
  }
  const match = url.pathname.match(/^\/api\/internal\/proposals\/([^/]+)$/);
  if (req.method !== 'GET' || !match) return deps.reply({ error: 'not_found' }, 404);
  return proposalByProtocol(env, match[1]!, url.searchParams.get('phone'), deps);
}

async function authorized(req: Request, env: Env, deps: InternalApiDeps) {
  const expected = (env as Env & InternalApiSecrets).ROTA_CERTA_SITE_API_TOKEN ?? '';
  if (expected.length < MIN_TOKEN_LENGTH) {
    console.error(JSON.stringify({ message: 'internal_api_token_not_configured' }));
    return false;
  }
  const header = req.headers.get('authorization') ?? '';
  const bearer = /^Bearer ([^\s]+)$/.exec(header)?.[1];
  if (!bearer) return false;
  return deps.safeEqual(bearer, expected);
}

async function proposalByProtocol(env: Env, rawProtocol: string, rawPhone: string | null, deps: InternalApiDeps) {
  let decoded = '';
  try { decoded = decodeURIComponent(rawProtocol); } catch { return deps.reply({ error: 'not_found' }, 404); }
  const protocol = normalizeProtocol(decoded);
  const phone = lookupPhoneDigits(rawPhone);
  if (!protocol || !phone) return deps.reply({ error: 'not_found' }, 404);
  const row = await env.DB.prepare(
    `SELECT protocol,customer_phone_digits,customer_name,origin,destination,trip_type,outbound_on,return_on,
            adults,children,infants,cabin_class,baggage,stops_preference,contact_consent,whatsapp_consent_at
       FROM lead_requests WHERE protocol=? AND kind='flight_quote'`,
  ).bind(protocol).first<Row>();
  const stored = typeof row?.customer_phone_digits === 'string' ? row.customer_phone_digits : '';
  // Número inteiro e em tempo constante: final igual ou número sem código do país não servem.
  const samePhone = await deps.safeEqual(stored, phone);
  if (!row || !stored || !samePhone) return deps.reply({ error: 'not_found' }, 404);
  return deps.reply(toInternalProposal(row));
}
