import { timingSafeEqual } from 'node:crypto';
import { parseCommissionPaidPayload, parseWeeklySummaryPayload } from '../shared/notificationPayloads.js';

type Row = Record<string, unknown>;
type Auth = { userId: string; sessionId: string; email: string; name: string; roles: string[] };
type Entitlement = { tier: 'free'|'premium'|'master'; unlimited: boolean; accessActive:boolean; endsAt:string|null; activeTripLimit: number|null; archivedTripLimit: number|null; premiumFeatures: boolean };
type OptionalNotificationSecrets = {
  WHATSAPP_WEBHOOK_URL?: string;
  WHATSAPP_WEBHOOK_TOKEN?: string;
  NOTIFICATIONS_CRON_TOKEN?: string;
};

const enc = new TextEncoder();
const sessionCookie = '__Host-rc_session';
const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/i/')) return env.ASSETS.fetch(request);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
      return await route(request, env, url);
    } catch (error) {
      console.error(JSON.stringify({ message: 'request_failed', error: error instanceof Error ? error.message : 'unknown', path: url.pathname }));
      return reply({ error: 'internal_error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  if (req.method === 'POST' && p === '/api/partner-applications') return partnerApplicationCreate(req, env);
  if (req.method === 'GET' && p === '/api/admin/partner-applications') return adminPartnerApplications(req, env);
  const applicationReject = p.match(/^\/api\/admin\/partner-applications\/([0-9a-f-]+)\/reject$/i);
  if (req.method === 'POST' && applicationReject) return adminPartnerApplicationReject(req, env, applicationReject[1]!);
  const referralRedirect = p.match(/^\/i\/([^/]+)$/);
  if (req.method === 'GET' && referralRedirect) return referralClick(req, env, referralRedirect[1]!);
  if (req.method === 'GET' && p === '/api/partners/attribution') return partnerAttribution(req, env, url);
  if (req.method === 'GET' && p === '/api/admin/partners') return adminPartners(req, env, url);
  if (req.method === 'POST' && p === '/api/admin/partners') return adminPartnerCreate(req, env);
  const partnerId = p.match(/^\/api\/admin\/partners\/([0-9a-f-]+)$/i);
  if (req.method === 'GET' && partnerId) return adminPartnerDetail(req, env, partnerId[1]!);
  if (req.method === 'PATCH' && partnerId) return adminPartnerUpdate(req, env, partnerId[1]!);
  const partnerInvite = p.match(/^\/api\/admin\/partners\/([0-9a-f-]+)\/invite$/i);
  if (req.method === 'POST' && partnerInvite) return adminPartnerInvite(req, env, partnerInvite[1]!);
  if (req.method === 'POST' && p === '/api/partner-invites/accept') return partnerInviteAccept(req, env);
  if (req.method === 'GET' && p === '/api/partner/summary') return partnerSummary(req, env);
  if (req.method === 'GET' && p === '/api/partner/ledger') return partnerLedger(req, env);
  const commissionAction = p.match(/^\/api\/admin\/commissions\/([0-9a-f-]+)\/(approve|pay|void)$/i);
  if (req.method === 'POST' && commissionAction) return commissionTransition(req, env, commissionAction[1]!, commissionAction[2]! as 'approve' | 'pay' | 'void');
  if (req.method === 'POST' && p === '/api/admin/notifications/process') return notificationsProcess(req, env);
  if (req.method === 'POST' && p === '/api/admin/notifications/weekly-summary') return notificationsWeeklySummary(req, env);
  if (req.method === 'GET' && p === '/api/health') return reply({ ok: true, runtime: 'cloudflare-workers' });
  if (req.method === 'GET' && p === '/api/geo') return reply({ country: req.headers.get('cf-ipcountry') || 'PT' });
  if (req.method === 'POST' && p === '/api/lead') return flightQuoteLead(req, env);
  if (req.method === 'POST' && p === '/api/auth/signup') return signup(req, env);
  if (req.method === 'POST' && p === '/api/auth/verify-email') return verifyEmail(req, env);
  if (req.method === 'POST' && p === '/api/auth/login') return login(req, env);
  if (req.method === 'GET' && p === '/api/auth/session') return session(req, env);
  if (req.method === 'POST' && p === '/api/auth/logout') return logout(req, env);
  if (req.method === 'POST' && p === '/api/auth/password-reset/request') return resetRequest(req, env);
  if (req.method === 'POST' && p === '/api/auth/password-reset/confirm') return resetConfirm(req, env);
  if (req.method === 'POST' && p === '/api/auth/change-password') return changePassword(req, env);
  if (req.method === 'POST' && p === '/api/admin/bootstrap/master-invites') return bootstrapMaster(req, env);
  if (req.method === 'POST' && p === '/api/admin/master-invites/accept') return acceptMaster(req, env);
  if (req.method === 'POST' && p === '/api/admin/master-invites') return inviteMaster(req, env);
  if (req.method === 'GET' && p === '/api/admin/overview') return adminOverview(req, env);
  if (req.method === 'GET' && p === '/api/admin/users') return adminUsers(req, env);
  if (req.method === 'GET' && p === '/api/admin/plans') return adminPlans(req, env);
  if (req.method === 'GET' && p === '/api/admin/payments') return adminPayments(req, env);
  if (req.method === 'GET' && p === '/api/admin/leads') return adminLeads(req, env, url);
  const adminLead = p.match(/^\/api\/admin\/leads\/([0-9a-f-]+)$/i);
  if (req.method === 'PATCH' && adminLead) return adminLeadUpdate(req, env, adminLead[1]);
  if (req.method === 'POST' && p === '/api/payments/checkout') return reply({ error: 'payments_disabled' }, 503);
  if (req.method === 'POST' && p === '/api/payments/stripe-webhook') return reply({ error: 'payments_disabled' }, 503);
  if (req.method === 'GET' && p === '/api/planner') return plannerGet(req, env, url);
  if (req.method === 'POST' && p === '/api/planner/trips') return plannerTrip(req, env);
  const tripAction = p.match(/^\/api\/planner\/trips\/([0-9a-f-]+)\/(archive|restore)$/i);
  if (req.method === 'POST' && tripAction) return plannerTripAction(req, env, tripAction[1], tripAction[2]);
  if (req.method === 'POST' && p === '/api/planner/import-local') return plannerImport(req, env);
  const match = p.match(/^\/api\/planner\/([0-9a-f-]+)\/(itinerary|places|budget|expenses|checklist)(?:\/([0-9a-f-]+))?$/i);
  if (match) return plannerItem(req, env, match[1], match[2], match[3]);
  return reply({ error: 'not_found' }, 404);
}

async function body(req: Request): Promise<Row | null> {
  try { return await req.json() as Row; } catch { return null; }
}
function reply(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), { status, headers: { ...jsonHeaders, ...headers } });
}
function emailOf(value: unknown) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254 ? v : null;
}
function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}
function text(value: unknown, max: number, min = 0) {
  const v = typeof value === 'string' ? value.trim() : '';
  return v.length >= min && v.length <= max ? v : null;
}
function phoneOf(value: unknown) { const v=typeof value==='string'?value.trim():'';if(!/^\+?[0-9 ()-]{8,30}$/.test(v))return null;return `${v.startsWith('+')?'+':''}${v.replace(/\D/g,'')}`; }
function dateOf(value: unknown) { const v=typeof value==='string'?value:'';return /^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(`${v}T00:00:00Z`))?v:null; }
function intOf(value: unknown,min:number,max:number) { const n=Number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:null; }
function html(value:string) { return value.replace(/[&<>'"]/g,(character)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[character]!); }
function isoAfter(seconds: number) { return new Date(Date.now() + seconds * 1000).toISOString(); }
function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function code6() { return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0'); }
function hex(data: ArrayBuffer | Uint8Array) { const bytes = data instanceof Uint8Array ? data : new Uint8Array(data); return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''); }
async function sha(value: string) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(value))); }
async function digest(value: string, env: Env) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.TOKEN_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(value)));
}
async function passwordHash(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return `pbkdf2$100000$${hex(salt)}$${hex(bits)}`;
}
async function verifyPassword(password: string, stored: string) {
  const [kind, iterations, saltHex, expected] = stored.split('$');
  if (kind !== 'pbkdf2' || !iterations || !saltHex || !expected) return false;
  const salt = new Uint8Array(saltHex.match(/../g)!.map((x) => parseInt(x, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: Number(iterations) }, key, 256);
  return safeEqual(hex(bits), expected);
}
async function safeEqual(a: string, b: string) {
  const [left, right] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
}
function cookies(req: Request) {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('='); if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}
function clientKey(req: Request) { return req.headers.get('cf-connecting-ip') || 'unknown'; }

const REF_COOKIE = 'rc_ref';
const PARTNER_CODE_RE = /^[a-z0-9-]{3,32}$/;
// Mirrors src/security.ts's ALLOWED_CURRENCIES exactly — the product's supported currencies for
// partner commissions and sale amounts, kept small and explicit rather than accepting any
// 3-letter string.
const ALLOWED_CURRENCIES = ['EUR', 'USD', 'BRL', 'GBP'];
function validCurrency(value: string) { return ALLOWED_CURRENCIES.includes(value.toUpperCase()); }
function normalizeCode(value: string) { return value.trim().toLowerCase(); }
function validCode(value: string) { return PARTNER_CODE_RE.test(value); }
async function signRef(codeValue: string, capturedAtMs: number, env: Env) {
  const payload = `${codeValue}.${capturedAtMs}`;
  return `${payload}.${await digest(payload, env)}`;
}
async function verifyRef(token: string, env: Env): Promise<{ code: string; capturedAtMs: number } | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [codeValue, capturedAtText, signature] = parts;
  const capturedAtMs = Number(capturedAtText);
  if (!codeValue || !Number.isFinite(capturedAtMs) || capturedAtMs <= 0) return null;
  const expected = await digest(`${codeValue}.${capturedAtText}`, env);
  return (await safeEqual(signature!, expected)) ? { code: codeValue, capturedAtMs } : null;
}
function maskProtocol(protocol: string) {
  const parts = protocol.split('-'); const suffix = parts[2] ?? ''; const visible = suffix.slice(0, 2);
  return `${parts[0]}-${parts[1]}-${visible}${'•'.repeat(Math.max(0, suffix.length - 2))}`;
}

interface Attribution { partnerId: string; code: string; source: 'link' | 'manual'; capturedAtIso: string; expiresAtIso: string }
async function resolveAttribution(req: Request, env: Env, manualCode?: string | null): Promise<Attribution | null> {
  const cookieToken = cookies(req)[REF_COOKIE];
  if (cookieToken) {
    const verified = await verifyRef(cookieToken, env);
    if (verified) {
      const partner = await env.DB.prepare('SELECT id,attribution_window_days FROM partners WHERE code=? AND active=1').bind(verified.code).first<{ id: string; attribution_window_days: number }>();
      if (partner) {
        const expiresAtMs = verified.capturedAtMs + partner.attribution_window_days * 86400000;
        if (expiresAtMs > Date.now()) {
          return { partnerId: String(partner.id), code: verified.code, source: 'link', capturedAtIso: new Date(verified.capturedAtMs).toISOString(), expiresAtIso: new Date(expiresAtMs).toISOString() };
        }
      }
    }
  }
  if (manualCode) {
    const codeValue = normalizeCode(manualCode);
    if (validCode(codeValue)) {
      const partner = await env.DB.prepare('SELECT id,attribution_window_days FROM partners WHERE code=? AND active=1').bind(codeValue).first<{ id: string; attribution_window_days: number }>();
      if (partner) {
        const now = Date.now();
        return { partnerId: String(partner.id), code: codeValue, source: 'manual', capturedAtIso: new Date(now).toISOString(), expiresAtIso: new Date(now + partner.attribution_window_days * 86400000).toISOString() };
      }
    }
  }
  return null;
}

async function rateLimit(req: Request, env: Env, scope: string, target: string, max: number, windowSeconds: number) {
  const key = await sha(`${env.RATE_LIMIT_SECRET}|${scope}|${target}|${clientKey(req)}`);
  const current = await env.DB.prepare('SELECT attempts,window_started_at,blocked_until FROM rate_limit_buckets WHERE key_hash=?').bind(key).first<{attempts:number;window_started_at:string;blocked_until:string|null}>();
  const now = Date.now();
  if (current?.blocked_until && Date.parse(current.blocked_until) > now) return false;
  if (!current || now - Date.parse(current.window_started_at) >= windowSeconds * 1000) {
    await env.DB.prepare('INSERT INTO rate_limit_buckets(key_hash,window_started_at,attempts,blocked_until) VALUES(?,CURRENT_TIMESTAMP,1,NULL) ON CONFLICT(key_hash) DO UPDATE SET window_started_at=CURRENT_TIMESTAMP,attempts=1,blocked_until=NULL').bind(key).run();
    return true;
  }
  const attempts = current.attempts + 1;
  const blocked = attempts > max ? isoAfter(windowSeconds) : null;
  await env.DB.prepare('UPDATE rate_limit_buckets SET attempts=?,blocked_until=? WHERE key_hash=?').bind(attempts, blocked, key).run();
  return attempts <= max;
}

async function getAuth(req: Request, env: Env): Promise<Auth | null> {
  const raw = cookies(req)[sessionCookie]; if (!raw) return null;
  const row = await env.DB.prepare(`SELECT s.id AS session_id,u.id AS user_id,u.email,p.display_name
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN profiles p ON p.user_id=u.id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP AND u.status='active'`).bind(await digest(raw, env)).first<Row>();
  if (!row) return null;
  const roles = await env.DB.prepare('SELECT role FROM user_roles WHERE user_id=?').bind(row.user_id).all<{role:string}>();
  return { userId: String(row.user_id), sessionId: String(row.session_id), email: String(row.email), name: String(row.display_name), roles: roles.results.map((r) => r.role) };
}
async function mutationAuth(req: Request, env: Env) {
  if (req.headers.get('origin') !== env.APP_ORIGIN) return null;
  const auth = await getAuth(req, env); if (!auth) return null;
  const csrf = req.headers.get('x-csrf-token') || '';
  const csrfCookie = cookies(req).rc_csrf || '';
  if (!csrf || !(await safeEqual(csrf, csrfCookie))) return null;
  const ok = await env.DB.prepare('SELECT 1 FROM sessions WHERE id=? AND csrf_token_hash=?').bind(auth.sessionId, await digest(csrf, env)).first();
  return ok ? auth : null;
}
async function createSession(userId: string, env: Env) {
  const token = randomToken(); const csrf = randomToken(); const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,expires_at) VALUES(?,?,?,?,?)').bind(id, userId, await digest(token, env), await digest(csrf, env), isoAfter(30 * 86400)).run();
  return { token, csrf };
}
function sessionHeaders(token: string, csrf: string) {
  const h = new Headers(jsonHeaders);
  h.append('set-cookie', `${sessionCookie}=${encodeURIComponent(token)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);
  h.append('set-cookie', `rc_csrf=${encodeURIComponent(csrf)}; Path=/; Max-Age=2592000; Secure; SameSite=Strict`);
  return h;
}
async function entitlement(auth: Auth, env: Env): Promise<Entitlement> {
  if(auth.roles.includes('master'))return {tier:'master',unlimited:true,accessActive:true,endsAt:null,activeTripLimit:null,archivedTripLimit:null,premiumFeatures:true};
  const active=await env.DB.prepare("SELECT p.code,s.ends_at FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=? AND s.status IN ('trialing','active') AND s.ends_at>CURRENT_TIMESTAMP AND p.code IN ('trial-10d','planner-30d') ORDER BY CASE WHEN p.code='planner-30d' THEN 0 ELSE 1 END,s.ends_at DESC LIMIT 1").bind(auth.userId).first<{code:string;ends_at:string}>();
  const tier=active?.code==='planner-30d'?'premium':'free';
  const unlimited=tier!=='free';
  return {tier,unlimited,accessActive:Boolean(active),endsAt:active?.ends_at||null,activeTripLimit:unlimited?null:1,archivedTripLimit:unlimited?null:2,premiumFeatures:unlimited};
}
async function canCreateActiveTrip(auth:Auth,env:Env,access?:Entitlement){const e=access||await entitlement(auth,env);if(e.unlimited)return true;const row=await env.DB.prepare('SELECT count(*) n FROM trips WHERE owner_user_id=? AND archived_at IS NULL').bind(auth.userId).first<{n:number}>();return Number(row?.n||0)<1;
}
async function requirePlannerAccess(auth:Auth,env:Env){const access=await entitlement(auth,env);return access.accessActive?access:null;}

// Mirrors src/email.ts's EMAIL_MODE contract exactly: 'capture' (the default, used locally and
// in every automated test — including the Worker/D1 smoke test) never makes network I/O and just
// records the event in email_events with provider='local-capture'; 'resend' is the real
// Resend-backed provider and must be explicitly configured (EMAIL_MODE=resend as a wrangler var)
// before any network call is ever made. Earlier revisions of this file always called Resend
// regardless of a (non-existent) "capture mode" claimed only in comments — this is the actual
// fix, not just documentation.
async function sendEmail(env: Env, userId: string | null, to: string, template: string, subject: string, htmlBody: string, textBody?: string, idempotencyKey?: string) {
  const recipientHash = await digest(to, env); const id = crypto.randomUUID();
  // Wrangler generates the current literal value ("capture"). Keep the runtime validation wide
  // enough for the same code to remain valid after an approved config change to "resend".
  const mode = env.EMAIL_MODE as 'capture' | 'resend';
  if (mode === 'capture') {
    await env.DB.prepare("INSERT INTO email_events(id,user_id,template,recipient_hash,provider,status) VALUES(?,?,?,?,'local-capture','captured')").bind(id,userId,template,recipientHash).run();
    return;
  }
  const headers: Record<string,string> = { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' };
  // See src/email.ts's EmailMessage.idempotencyKey: passed through to Resend's documented
  // Idempotency-Key header so a genuine duplicate send (lost outbox lock / caller-level retry) is
  // deduplicated by the provider — "at least once, provider-deduplicated", never "exactly once".
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers, body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html: htmlBody, text: textBody }) });
  let reference: string | null = null; try { reference = String(((await response.json()) as Row).id || '') || null; } catch {}
  await env.DB.prepare('INSERT INTO email_events(id,user_id,template,recipient_hash,provider,provider_reference,status,error_code) VALUES(?,?,?,?,?,?,?,?)').bind(id,userId,template,recipientHash,'resend',reference,response.ok?'sent':'failed',response.ok?null:`http_${response.status}`).run();
  if (!response.ok) throw new Error('email_delivery_failed');
}

async function signup(req: Request, env: Env) {
  const b = await body(req); const email = emailOf(b?.email); const name = text(b?.name,120,2); const password = b?.password;
  if (!email || !name || !validPassword(password) || b?.termsAccepted !== true) return reply({ error: 'invalid_signup' },400);
  if (!(await rateLimit(req,env,'signup',email,5,900))) return reply({error:'try_again_later'},429);
  let user = await env.DB.prepare('SELECT id,status,email_verified_at FROM users WHERE email=?').bind(email).first<Row>();
  if (!user) {
    const id=crypto.randomUUID(); const hash=await passwordHash(password);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users(id,email,password_hash) VALUES(?,?,?)').bind(id,email,hash),
      env.DB.prepare('INSERT INTO profiles(user_id,display_name) VALUES(?,?)').bind(id,name),
      env.DB.prepare("INSERT INTO user_roles(user_id,role) VALUES(?,'customer')").bind(id),
    ]); user={id,status:'pending',email_verified_at:null};
  }
  if (!user.email_verified_at && user.status==='pending') {
    const code=code6(); const tokenHash=await digest(code,env);
    await env.DB.batch([
      env.DB.prepare("UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND purpose='email_verification' AND used_at IS NULL").bind(user.id),
      env.DB.prepare("INSERT INTO account_tokens(id,user_id,purpose,token_hash,expires_at) VALUES(?,?,'email_verification',?,?)").bind(crypto.randomUUID(),user.id,tokenHash,isoAfter(600)),
    ]);
    await sendEmail(env,String(user.id),email,'verify_email','Confirme seu e-mail - Rota Certa Passagens',`<p>Seu código de confirmação é <strong>${code}</strong>.</p><p>Ele expira em 10 minutos e só pode ser usado uma vez.</p>`);
  }
  return reply({ok:true},202);
}

async function verifyEmail(req: Request, env: Env) {
  const b=await body(req); const email=emailOf(b?.email); const code=typeof b?.code==='string'&&/^\d{6}$/.test(b.code)?b.code:null;
  if(!email||!code) return reply({error:'invalid_code'},400);
  if(!(await rateLimit(req,env,'verify',email,6,600))) return reply({error:'try_again_later'},429);
  const user=await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first<Row>();
  if(!user) return reply({error:'invalid_or_expired_code'},400);
  const token=await env.DB.prepare("SELECT id FROM account_tokens WHERE user_id=? AND purpose='email_verification' AND token_hash=? AND used_at IS NULL AND expires_at>CURRENT_TIMESTAMP AND failed_attempts<5 ORDER BY created_at DESC LIMIT 1").bind(user.id,await digest(code,env)).first<Row>();
  if(!token){await env.DB.prepare("UPDATE account_tokens SET failed_attempts=failed_attempts+1 WHERE id=(SELECT id FROM account_tokens WHERE user_id=? AND purpose='email_verification' AND used_at IS NULL ORDER BY created_at DESC LIMIT 1)").bind(user.id).run();return reply({error:'invalid_or_expired_code'},400);}
  const tripId=crypto.randomUUID();const now=new Date().toISOString();const end=isoAfter(10*86400);
  await env.DB.batch([
    env.DB.prepare('UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?').bind(token.id),
    env.DB.prepare("UPDATE users SET email_verified_at=CURRENT_TIMESTAMP,status='active',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(user.id),
    env.DB.prepare("INSERT INTO subscriptions(id,user_id,plan_id,status,starts_at,ends_at,provider) SELECT ?,?,?, 'trialing',?,?,'internal' WHERE NOT EXISTS(SELECT 1 FROM subscriptions WHERE user_id=?)").bind(crypto.randomUUID(),user.id,'00000000-0000-4000-8000-000000000001',now,end,user.id),
    env.DB.prepare("INSERT INTO trips(id,owner_user_id,name) VALUES(?,?,'Minha viagem')").bind(tripId,user.id),
    env.DB.prepare("INSERT INTO budgets(trip_id,owner_user_id,amount_cents,currency) VALUES(?,?,150000,'EUR')").bind(tripId,user.id),
  ]);
  const items=['Passaporte válido','Seguro viagem','Documentos de viagem','Check-in online','Bagagem despachada','Dinheiro / cartões','Adaptador de tomada','Medicamentos'];
  await env.DB.batch(items.map((item,i)=>env.DB.prepare('INSERT INTO checklist_items(id,trip_id,owner_user_id,text,sort_order) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),tripId,user.id,item,i)));
  const s=await createSession(String(user.id),env); return new Response(JSON.stringify({ok:true,csrfToken:s.csrf}),{headers:sessionHeaders(s.token,s.csrf)});
}

async function login(req: Request, env: Env) {
  const b=await body(req); const email=emailOf(b?.email); const password=typeof b?.password==='string'?b.password:'';
  if(!email||!password) return reply({error:'invalid_credentials'},400);
  if(!(await rateLimit(req,env,'login',email,8,900))) return reply({error:'try_again_later'},429);
  const user=await env.DB.prepare("SELECT id,password_hash FROM users WHERE email=? AND status='active' AND email_verified_at IS NOT NULL").bind(email).first<Row>();
  if(!user||typeof user.password_hash!=='string'||!(await verifyPassword(password,user.password_hash))) return reply({error:'invalid_credentials'},401);
  const s=await createSession(String(user.id),env); await env.DB.prepare('UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?').bind(user.id).run();
  return new Response(JSON.stringify({ok:true,csrfToken:s.csrf}),{headers:sessionHeaders(s.token,s.csrf)});
}
async function session(req: Request, env: Env) {
  const auth=await getAuth(req,env); if(!auth) return reply({authenticated:false},401);
  const access=await entitlement(auth,env);
  return reply({authenticated:true,user:{id:auth.userId,email:auth.email,name:auth.name,roles:auth.roles},access});
}
async function logout(req: Request, env: Env) {
  const auth=await mutationAuth(req,env); if(!auth) return reply({error:'unauthorized'},401);
  await env.DB.prepare('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=?').bind(auth.sessionId).run();
  const h=new Headers(jsonHeaders);h.append('set-cookie',`${sessionCookie}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);h.append('set-cookie','rc_csrf=; Path=/; Max-Age=0; Secure; SameSite=Strict');return new Response(JSON.stringify({ok:true}),{headers:h});
}

async function resetRequest(req: Request, env: Env) {
  const b=await body(req);const email=emailOf(b?.email);if(!email)return reply({ok:true},202);
  if(!(await rateLimit(req,env,'reset-request',email,4,1800))) return reply({ok:true},202);
  const user=await env.DB.prepare("SELECT id FROM users WHERE email=? AND status='active'").bind(email).first<Row>();
  if(user){const raw=randomToken();await env.DB.batch([env.DB.prepare("UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND purpose='password_reset' AND used_at IS NULL").bind(user.id),env.DB.prepare("INSERT INTO account_tokens(id,user_id,purpose,token_hash,expires_at) VALUES(?,?,'password_reset',?,?)").bind(crypto.randomUUID(),user.id,await digest(raw,env),isoAfter(2700))]);await sendEmail(env,String(user.id),email,'password_reset','Redefina sua senha - Rota Certa Passagens',`<p><a href="${env.APP_ORIGIN}/reset-password.html?token=${encodeURIComponent(raw)}">Redefinir senha</a></p><p>O link expira em 45 minutos.</p>`);}
  return reply({ok:true},202);
}
async function resetConfirm(req: Request, env: Env) {
  const b=await body(req);const token=typeof b?.token==='string'?b.token:'';const password=b?.password;if(token.length<32||!validPassword(password))return reply({error:'invalid_or_expired_token'},400);
  const row=await env.DB.prepare("SELECT id,user_id FROM account_tokens WHERE token_hash=? AND purpose='password_reset' AND used_at IS NULL AND expires_at>CURRENT_TIMESTAMP LIMIT 1").bind(await digest(token,env)).first<Row>();if(!row)return reply({error:'invalid_or_expired_token'},400);
  await env.DB.batch([env.DB.prepare('UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(await passwordHash(password),row.user_id),env.DB.prepare('UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?').bind(row.id),env.DB.prepare('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND revoked_at IS NULL').bind(row.user_id)]);return reply({ok:true});
}
async function changePassword(req: Request, env: Env) {
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);const b=await body(req);if(typeof b?.currentPassword!=='string'||!validPassword(b?.newPassword))return reply({error:'invalid_password'},400);
  const row=await env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(auth.userId).first<Row>();if(typeof row?.password_hash!=='string'||!(await verifyPassword(b.currentPassword,row.password_hash)))return reply({error:'invalid_password'},400);
  await env.DB.batch([env.DB.prepare('UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(await passwordHash(b.newPassword),auth.userId),env.DB.prepare('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND id<>?').bind(auth.userId,auth.sessionId)]);return reply({ok:true});
}

async function createMasterInvite(req: Request, env: Env, actor: string|null) {
  const b=await body(req);const email=emailOf(b?.email);const name=text(b?.name,120,2);if(!email||!name)return reply({error:'invalid_invite'},400);
  let user=await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first<Row>();
  if(!user){const id=crypto.randomUUID();await env.DB.batch([env.DB.prepare("INSERT INTO users(id,email,status) VALUES(?,?,'pending')").bind(id,email),env.DB.prepare('INSERT INTO profiles(user_id,display_name) VALUES(?,?)').bind(id,name)]);user={id};}
  const code=code6();await env.DB.batch([env.DB.prepare("UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND purpose='master_invite' AND used_at IS NULL").bind(user.id),env.DB.prepare("INSERT INTO account_tokens(id,user_id,purpose,token_hash,expires_at) VALUES(?,?,'master_invite',?,?)").bind(crypto.randomUUID(),user.id,await digest(code,env),isoAfter(900))]);
  await sendEmail(env,String(user.id),email,'master_invite','Código de ativação master - Rota Certa Passagens',`<p>Seu código de ativação master é:</p><p><strong>${code}</strong></p><p>Digite-o em <a href="${env.APP_ORIGIN}/master-invite.html">${env.APP_ORIGIN}/master-invite.html</a>. Ele expira em 15 minutos.</p>`);
  await audit(env,actor,'admin.master_invite_created','user',String(user.id));return reply({ok:true},201);
}
async function bootstrapMaster(req: Request, env: Env) {
  const provided=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');if(!env.MASTER_BOOTSTRAP_TOKEN||!(await safeEqual(provided,env.MASTER_BOOTSTRAP_TOKEN)))return reply({error:'not_found'},404);
  if(await env.DB.prepare("SELECT 1 FROM user_roles WHERE role='master' LIMIT 1").first())return reply({error:'master_already_exists'},409);return createMasterInvite(req,env,null);
}
async function inviteMaster(req: Request, env: Env) {const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);return createMasterInvite(req,env,auth.userId);}
async function acceptMaster(req: Request, env: Env) {
  const b=await body(req);const email=emailOf(b?.email);const code=typeof b?.code==='string'&&/^\d{6}$/.test(b.code)?b.code:null;const password=b?.password;
  if(!validPassword(password))return reply({error:'invalid_password_requirements'},400);
  if(!email||!code)return reply({error:'invalid_or_expired_invite'},400);
  if(!(await rateLimit(req,env,'master-accept',email,8,900)))return reply({error:'too_many_attempts'},429);
  const row=await env.DB.prepare("SELECT t.id,t.user_id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email=? AND t.token_hash=? AND t.purpose='master_invite' AND t.used_at IS NULL AND t.expires_at>CURRENT_TIMESTAMP AND t.failed_attempts<5 LIMIT 1").bind(email,await digest(code,env)).first<Row>();
  if(!row){await env.DB.prepare("UPDATE account_tokens SET failed_attempts=failed_attempts+1 WHERE id=(SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email=? AND t.purpose='master_invite' AND t.used_at IS NULL ORDER BY t.created_at DESC LIMIT 1)").bind(email).run();return reply({error:'invalid_or_expired_invite'},400);}
  const tripId=crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash=?,status='active',email_verified_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(await passwordHash(password),row.user_id),
    env.DB.prepare("INSERT OR IGNORE INTO user_roles(user_id,role) VALUES(?,'master')").bind(row.user_id),
    env.DB.prepare('UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?').bind(row.id),
    env.DB.prepare("INSERT INTO trips(id,owner_user_id,name) SELECT ?,?,'Minha viagem' WHERE NOT EXISTS(SELECT 1 FROM trips WHERE owner_user_id=?)").bind(tripId,row.user_id,row.user_id),
    env.DB.prepare("INSERT OR IGNORE INTO budgets(trip_id,owner_user_id,amount_cents,currency) SELECT id,owner_user_id,0,'EUR' FROM trips WHERE id=?").bind(tripId),
  ]);await audit(env,String(row.user_id),'admin.master_invite_accepted','user',String(row.user_id));return reply({ok:true});
}
async function requireMaster(req:Request,env:Env){const a=await getAuth(req,env);return a?.roles.includes('master')?a:null;}
// Mirrors src/routes/notifications.ts requireMasterOrCron: an unattended Cloudflare Scheduled
// Event has no session cookie, so it authenticates with the NOTIFICATIONS_CRON_TOKEN bearer
// secret instead, following the same bootstrap-token pattern already used for master.
async function requireMasterOrCronUserId(req:Request,env:Env):Promise<string|null|undefined>{
  const provided=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
  const cronToken=(env as Env & OptionalNotificationSecrets).NOTIFICATIONS_CRON_TOKEN;
  if(cronToken&&provided&&(await safeEqual(provided,cronToken)))return null;
  const auth=await mutationAuth(req,env);
  if(!auth||!auth.roles.includes('master'))return undefined;
  return auth.userId;
}
async function adminOverview(req:Request,env:Env){if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);const u=await env.DB.prepare("SELECT count(*) n FROM users WHERE status<>'deleted'").first<{n:number}>();const a=await env.DB.prepare("SELECT count(*) n FROM users WHERE status='active'").first<{n:number}>();const p=await env.DB.prepare("SELECT count(*) n FROM payments WHERE status IN ('pending','processing')").first<{n:number}>();const paid=await env.DB.prepare("SELECT count(*) n FROM payments WHERE status='paid'").first<{n:number}>();const fresh=await env.DB.prepare("SELECT count(*) n FROM lead_requests WHERE kind='flight_quote' AND status='new'").first<{n:number}>();const overdue=await env.DB.prepare("SELECT count(*) n FROM lead_requests WHERE kind='flight_quote' AND deadline_at<CURRENT_TIMESTAMP AND status NOT IN ('sent','converted','lost','canceled','closed')").first<{n:number}>();return reply({users:u?.n||0,active_access:a?.n||0,pending_payments:p?.n||0,paid_payments:paid?.n||0,new_leads:fresh?.n||0,overdue_leads:overdue?.n||0});}
async function adminUsers(req:Request,env:Env){if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);const users=await env.DB.prepare('SELECT u.id,u.email,p.display_name,u.status,u.email_verified_at,u.created_at,u.last_login_at FROM users u JOIN profiles p ON p.user_id=u.id ORDER BY u.created_at DESC LIMIT 200').all<Row>();const roles=await env.DB.prepare('SELECT user_id,role FROM user_roles').all<Row>();return reply({users:users.results.map(u=>({...u,roles:roles.results.filter(r=>r.user_id===u.id).map(r=>r.role)}))});}
async function adminPlans(req:Request,env:Env){if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);return reply({plans:(await env.DB.prepare('SELECT * FROM plans ORDER BY price_cents').all()).results});}
async function adminPayments(req:Request,env:Env){if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);return reply({payments:(await env.DB.prepare('SELECT p.*,u.email,pl.code plan_code FROM payments p JOIN users u ON u.id=p.user_id LEFT JOIN plans pl ON pl.id=p.plan_id ORDER BY p.created_at DESC LIMIT 200').all()).results});}

const leadStatuses=['new','reviewing','awaiting_customer','ready','sent','converted','lost','canceled','closed'];
async function adminLeads(req:Request,env:Env,url:URL){
  if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);
  const status=url.searchParams.get('status');const partnerId=url.searchParams.get('partnerId');
  if(status&&!leadStatuses.includes(status))return reply({error:'invalid_filter'},400);
  const conds=["l.kind='flight_quote'"];const binds:unknown[]=[];
  if(status){conds.push('l.status=?');binds.push(status);}
  if(partnerId){conds.push('l.partner_id=?');binds.push(partnerId);}
  const sql=`SELECT l.id,l.protocol,l.customer_name,l.customer_email,l.customer_phone,l.origin,l.destination,l.outbound_on,l.return_on,l.adults,l.children,l.infants,l.trip_type,l.cabin_class,l.baggage,l.date_flexibility,l.payment_preference,l.notes,l.internal_notes,l.status,l.deadline_at,l.created_at,l.updated_at,l.assigned_to,p.display_name assigned_name,l.partner_id,l.referral_code_snapshot,l.referral_source,l.sale_amount_cents,l.sale_currency,l.converted_at,partner.code partner_code,partner.display_name partner_display_name FROM lead_requests l LEFT JOIN profiles p ON p.user_id=l.assigned_to LEFT JOIN partners partner ON partner.id=l.partner_id WHERE ${conds.join(' AND ')} ORDER BY CASE WHEN l.status IN ('new','reviewing','awaiting_customer','ready') THEN 0 ELSE 1 END,l.deadline_at ASC,l.created_at DESC LIMIT 200`;
  const leads=(await env.DB.prepare(sql).bind(...binds).all<Row>()).results;
  // A lead can have more than one *historical* commission row (converted -> voided ->
  // reconverted); this listing must attach exactly one "current" commission per lead without
  // duplicating rows. Fetched separately and merged here in a fully deterministic order: the
  // SQL ORDER BY guarantees the first row seen per lead_request_id is the active (non-void)
  // commission if one exists, otherwise the most recently voided one.
  const leadIdSet=new Set(leads.map((row)=>String(row.id)));
  const commissionByLead=new Map<string,{id:string;status:string;amount_cents:number;currency:string}>();
  if(leadIdSet.size){
    const commissions=await env.DB.prepare(`SELECT pc.id,pc.lead_request_id,pc.status,pc.amount_cents,pc.currency FROM partner_commissions pc JOIN lead_requests l ON l.id=pc.lead_request_id WHERE l.kind='flight_quote' ORDER BY (pc.status='void') ASC, pc.created_at DESC LIMIT 2000`).all<{id:string;lead_request_id:string;status:string;amount_cents:number;currency:string}>();
    for(const row of commissions.results){
      const leadRequestId=String(row.lead_request_id);
      if(leadIdSet.has(leadRequestId)&&!commissionByLead.has(leadRequestId))commissionByLead.set(leadRequestId,row);
    }
  }
  return reply({leads:leads.map((row)=>{
    const commission=commissionByLead.get(String(row.id));
    return {...row,commission_id:commission?.id??null,commission_status:commission?.status??null,commission_amount_cents:commission?.amount_cents??null,commission_currency:commission?.currency??null};
  })});
}

/**
 * Mirrors src/routes/admin.ts's createCommissionForLead: at most one *active* (non-void)
 * commission per lead (migration 0006's partial unique index), convert -> void -> reconvert
 * creates real history, a repeat call is idempotent and never silently changes a sale
 * amount/currency that already produced a live commission, and a percentage sale must be in the
 * partner's own configured currency.
 */
async function createCommissionForLead(env:Env,actorUserId:string,leadId:string,partnerId:string,saleAmountCents:number|null,saleCurrency:string|null,currentSaleAmountCents:number|null,currentSaleCurrency:string|null):Promise<{amountCents:number;currency:string}|{error:string;statusCode:number}>{
  const active=await env.DB.prepare("SELECT id,amount_cents,currency FROM partner_commissions WHERE lead_request_id=? AND status<>'void'").bind(leadId).first<{id:string;amount_cents:number;currency:string}>();
  if(active){
    const amountChanged=saleAmountCents!==null&&saleAmountCents!==currentSaleAmountCents;
    const currencyChanged=saleCurrency!==null&&saleCurrency.toUpperCase()!==currentSaleCurrency;
    if(amountChanged||currencyChanged)return{error:'sale_amount_locked',statusCode:409};
    return{amountCents:active.amount_cents,currency:active.currency};
  }
  const rule=await env.DB.prepare('SELECT commission_type,commission_fixed_cents,commission_percentage_bps,currency FROM partners WHERE id=?').bind(partnerId).first<{commission_type:string;commission_fixed_cents:number|null;commission_percentage_bps:number|null;currency:string}>();
  if(!rule)return{error:'partner_not_found',statusCode:404};
  let amountCents:number,currency:string,rateSnapshot:number,effectiveSaleAmountCents:number|null=null;
  if(rule.commission_type==='percentage'){
    const effectiveAmount=saleAmountCents??currentSaleAmountCents;
    const effectiveCurrency=(saleCurrency??currentSaleCurrency)?.toUpperCase();
    if(effectiveAmount===null||effectiveAmount===undefined||!effectiveCurrency)return{error:'sale_amount_required',statusCode:422};
    if(!validCurrency(effectiveCurrency))return{error:'invalid_currency',statusCode:422};
    if(effectiveCurrency!==rule.currency)return{error:'sale_currency_must_match_partner_currency',statusCode:409};
    amountCents=Math.round((effectiveAmount*(rule.commission_percentage_bps||0))/10000);currency=effectiveCurrency;rateSnapshot=rule.commission_percentage_bps||0;
    effectiveSaleAmountCents=effectiveAmount;
  }else{amountCents=rule.commission_fixed_cents||0;currency=rule.currency;rateSnapshot=rule.commission_fixed_cents||0;}
  const id=crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO partner_commissions (id,partner_id,lead_request_id,amount_cents,currency,status,commission_type_snapshot,commission_rate_snapshot,sale_amount_cents_snapshot,created_by) VALUES (?,?,?,?,?,'pending',?,?,?,?)`)
      .bind(id,partnerId,leadId,amountCents,currency,rule.commission_type,rateSnapshot,effectiveSaleAmountCents,actorUserId).run();
  } catch (error) {
    // Lost a race against a concurrent conversion request enforced by the partial unique index;
    // fall back to whatever the winner created.
    const raceExisting=await env.DB.prepare("SELECT amount_cents,currency FROM partner_commissions WHERE lead_request_id=? AND status<>'void'").bind(leadId).first<{amount_cents:number;currency:string}>();
    return raceExisting?{amountCents:raceExisting.amount_cents,currency:raceExisting.currency}:{error:'commission_not_created',statusCode:500};
  }
  await audit(env,actorUserId,'admin.commission_created','partner_commission',id);
  return{amountCents,currency};
}

async function adminLeadUpdate(req:Request,env:Env,id:string){
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);
  const b=await body(req);const status=typeof b?.status==='string'&&leadStatuses.includes(b.status)?b?.status:null;const notes=text(b?.internalNotes,3000),assign=b?.assignToMe===true;
  const saleAmountCents=Number.isInteger(b?.saleAmountCents)&&Number(b?.saleAmountCents)>=0?Number(b?.saleAmountCents):null;
  const saleCurrencyRaw=typeof b?.saleCurrency==='string'&&b.saleCurrency.length===3?b?.saleCurrency.toUpperCase():null;
  const voidReason=text(b?.voidCommissionReason,500,3);
  if(!status)return reply({error:'invalid_request'},400);
  if(saleCurrencyRaw!==null&&!validCurrency(saleCurrencyRaw))return reply({error:'invalid_currency'},422);
  const existing=await env.DB.prepare("SELECT id,status,partner_id,protocol,destination,sale_amount_cents,sale_currency FROM lead_requests WHERE id=? AND kind='flight_quote'").bind(id).first<Row>();
  if(!existing)return reply({error:'not_found'},404);

  // Everything below is submitted as a single env.DB.batch() call, which D1 runs as one atomic
  // unit (all statements succeed or none do) — mirroring the single database transaction the
  // Node/Postgres backend uses for the same operation, so a failure partway through can never
  // leave a converted proposal without its expected commission, nor a commission without its
  // proposal update. The lead UPDATE at the end carries an optimistic-concurrency guard
  // (WHERE status=? matching the status just read above) so a second D1 batch that started
  // concurrently against the same row cannot silently clobber this one's effects.
  const statements: D1PreparedStatement[] = [];

  if(existing.status==='converted'&&status!=='converted'){
    const paid=await env.DB.prepare("SELECT id FROM partner_commissions WHERE lead_request_id=? AND status='paid'").bind(id).first<Row>();
    if(paid)return reply({error:'commission_paid_immutable'},409);
    const active=await env.DB.prepare("SELECT id FROM partner_commissions WHERE lead_request_id=? AND status IN ('pending','approved')").bind(id).first<Row>();
    if(active){
      if(!voidReason)return reply({error:'commission_void_reason_required'},409);
      statements.push(env.DB.prepare("UPDATE partner_commissions SET status='void',voided_at=CURRENT_TIMESTAMP,voided_by=?,void_reason=?,updated_at=CURRENT_TIMESTAMP WHERE lead_request_id=? AND status IN ('pending','approved')").bind(auth.userId,voidReason,id));
      statements.push(env.DB.prepare('INSERT INTO audit_events(id,actor_user_id,action,target_type,target_id) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),auth.userId,'admin.commission_voided','lead_request',id));
    }
  }

  let commissionPreview:{amountCents:number;currency:string}|{error:string}|null=null;
  let finalSaleAmountCents=existing.sale_amount_cents as number|null;
  let finalSaleCurrency=existing.sale_currency as string|null;
  if(status==='converted'&&existing.partner_id){
    const created=await createCommissionForLead(env,auth.userId,id,String(existing.partner_id),saleAmountCents,saleCurrencyRaw,existing.sale_amount_cents as number|null,existing.sale_currency as string|null);
    if('error'in created)return reply({error:created.error},created.statusCode);
    commissionPreview=created;
    // A repeated/idempotent conversion call that omits saleAmountCents/saleCurrency must never
    // null out financial data that already exists on the proposal.
    finalSaleAmountCents=saleAmountCents??(existing.sale_amount_cents as number|null);
    finalSaleCurrency=saleCurrencyRaw??(existing.sale_currency as string|null);
  }

  statements.push(
    env.DB.prepare(`UPDATE lead_requests SET status=?,internal_notes=?,assigned_to=CASE WHEN ? THEN ? ELSE assigned_to END,
      sale_amount_cents=CASE WHEN ?='converted' THEN ? ELSE sale_amount_cents END,
      sale_currency=CASE WHEN ?='converted' THEN ? ELSE sale_currency END,
      converted_at=CASE WHEN ?='converted' THEN COALESCE(converted_at,CURRENT_TIMESTAMP) ELSE converted_at END,
      updated_at=CURRENT_TIMESTAMP WHERE id=? AND kind='flight_quote' AND status=?`)
      .bind(status,notes,assign?1:0,auth.userId,status,finalSaleAmountCents,status,finalSaleCurrency,status,id,existing.status),
  );
  const leadUpdateIndex=statements.length-1;
  statements.push(env.DB.prepare('INSERT INTO audit_events(id,actor_user_id,action,target_type,target_id) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),auth.userId,'admin.lead_updated','lead_request',id));
  if(status==='converted'&&existing.partner_id){
    statements.push(
      env.DB.prepare(`INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload) VALUES (?,?,'proposal_converted',?,?) ON CONFLICT(idempotency_key) DO NOTHING`)
        .bind(crypto.randomUUID(),`proposal_converted:${id}`,existing.partner_id,JSON.stringify({leadId:id,protocol:existing.protocol})),
    );
  }
  const results=await env.DB.batch(statements);
  const leadUpdateResult=results[leadUpdateIndex];
  if(!leadUpdateResult?.meta.changes)return reply({error:'conflict_retry'},409);
  return reply({lead:{id,status,internal_notes:notes,assigned_to:assign?auth.userId:null,updated_at:new Date().toISOString()},commissionPreview});
}

async function flightQuoteLead(req:Request,env:Env){
  const b=await body(req);
  const name=text(b?.name,120,2),email=emailOf(b?.email),phone=phoneOf(b?.phone),origin=text(b?.origem,160,2),destination=text(b?.destino,160,2);
  const outbound=dateOf(b?.ida),returnOn=b?.volta?dateOf(b.volta):null,adults=intOf(b?.adults,1,20),children=intOf(b?.children,0,20),infants=intOf(b?.infants,0,20);
  const tripType=b?.tipo==='Ida e volta'||b?.tipo==='Somente ida'?b.tipo:null;
  const cabin=['Econômica','Premium Economy','Executiva','Primeira classe'].includes(String(b?.cabinClass))?String(b?.cabinClass):null;
  const baggage=['Somente item pessoal','Bagagem de mão','Bagagem despachada','Ainda não sei'].includes(String(b?.baggage))?String(b?.baggage):null;
  const flexibility=['Datas fixas','Até 3 dias','Até 7 dias','Datas flexíveis'].includes(String(b?.flexibility))?String(b?.flexibility):null;
  const payment=['Dinheiro','Milhas','Dinheiro ou milhas'].includes(String(b?.paymentPreference))?String(b?.paymentPreference):null,notes=text(b?.observacoes,3000);
  if(b?.type!=='quote'||!name||!email||!phone||!origin||!destination||!outbound||adults===null||children===null||infants===null||!tripType||!cabin||!baggage||!flexibility||!payment||b?.contactConsent!==true||(tripType==='Ida e volta'&&!returnOn)||(returnOn&&returnOn<outbound))return reply({error:'invalid_request'},400);
  if(!(await rateLimit(req,env,'flight_quote',email,4,1800)))return reply({error:'try_again_later'},429);
  const id=crypto.randomUUID(),protocol=`RC-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${id.replaceAll('-','').slice(0,6).toUpperCase()}`,deadline=isoAfter(48*3600);
  const howHeard=typeof b?.howHeard==='string'?b.howHeard:null;
  const manualCode=howHeard==='Indicação de um parceiro/influenciador'&&typeof b?.referralCode==='string'?b.referralCode:null;
  const attribution=await resolveAttribution(req,env,manualCode);
  await env.DB.prepare(`INSERT INTO lead_requests
    (id,kind,protocol,customer_name,customer_email,customer_phone,origin,destination,outbound_on,return_on,
     passengers,adults,children,infants,trip_type,cabin_class,baggage,date_flexibility,payment_preference,notes,
     contact_consent,status,deadline_at,ip_hash,updated_at,
     partner_id,referral_code_snapshot,referral_source,referral_captured_at,attribution_expires_at)
    VALUES (?,'flight_quote',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'new',?,?,CURRENT_TIMESTAMP,?,?,?,?,?)`)
    .bind(id,protocol,name,email,phone,origin,destination,outbound,returnOn,`${adults} adulto(s), ${children} criança(s), ${infants} bebê(s)`,adults,children,infants,tripType,cabin,baggage,flexibility,payment,notes,deadline,await sha(clientKey(req)),
      attribution?.partnerId??null,attribution?.code??null,attribution?.source??'none',attribution?.capturedAtIso??null,attribution?.expiresAtIso??null).run();
  if(attribution){
    await env.DB.prepare(`INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload) VALUES (?,?,'referral_confirmed',?,?) ON CONFLICT(idempotency_key) DO NOTHING`)
      .bind(crypto.randomUUID(),`referral_confirmed:${id}`,attribution.partnerId,JSON.stringify({leadId:id,protocol,destination})).run();
  }
  const masters=await env.DB.prepare("SELECT u.id,u.email FROM users u JOIN user_roles r ON r.user_id=u.id WHERE r.role='master' AND u.status='active' AND u.email_verified_at IS NOT NULL").all<Row>();
  const route=`${origin} → ${destination}`,adminUrl=`${env.APP_ORIGIN.replace(/\/$/,'')}/admin.html`;
  const customerHtml=`<p>Olá, ${html(name)}.</p><p>Recebemos sua solicitação de proposta para <strong>${html(route)}</strong>.</p><p>Protocolo: <strong>${protocol}</strong></p><p>Nossa equipe analisará as melhores opções e responderá por e-mail em até 48 horas.</p><p>Rota Certa Passagens</p>`;
  const customerText=`Olá, ${name}. Recebemos sua solicitação para ${route}. Protocolo: ${protocol}. Nossa equipe responderá por e-mail em até 48 horas.`;
  const masterHtml=`<p>Nova proposta de voo recebida.</p><p><strong>${protocol}</strong> — ${html(route)}</p><p>Cliente: ${html(name)} (${html(email)})</p><p>Prazo: ${html(deadline)}</p><p><a href="${html(adminUrl)}">Abrir Central de Propostas</a></p>`;
  const masterText=`Nova proposta ${protocol}: ${route}. Cliente: ${name} (${email}). Prazo: ${deadline}. Painel: ${adminUrl}`;
  const customer=await Promise.allSettled([sendEmail(env,null,email,'flight_quote_customer',`Recebemos sua solicitação ${protocol}`,customerHtml,customerText)]);
  const masterResults=await Promise.allSettled(masters.results.map(m=>sendEmail(env,String(m.id),String(m.email),'flight_quote_master',`Nova proposta de voo ${protocol}`,masterHtml,masterText)));
  return reply({ok:true,protocol,responseDeadlineHours:48,confirmationEmailSent:customer[0]?.status==='fulfilled',mastersNotified:masterResults.filter(x=>x.status==='fulfilled').length},201);
}

async function audit(env:Env,actor:string|null,action:string,targetType:string,targetId:string){await env.DB.prepare('INSERT INTO audit_events(id,actor_user_id,action,target_type,target_id) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),actor,action,targetType,targetId).run();}

async function plannerGet(req:Request,env:Env,url:URL){const a=await getAuth(req,env);if(!a)return reply({error:'unauthorized'},401);const access=await requirePlannerAccess(a,env);if(!access)return reply({error:'free_trial_expired',upgrade_required:true},402);const id=url.searchParams.get('tripId');const trip=id?await env.DB.prepare('SELECT id,name,destination,starts_on,ends_on,source,travelers,archived_at FROM trips WHERE id=? AND owner_user_id=?').bind(id,a.userId).first<Row>():await env.DB.prepare('SELECT id,name,destination,starts_on,ends_on,source,travelers,archived_at FROM trips WHERE owner_user_id=? ORDER BY (archived_at IS NOT NULL),updated_at DESC LIMIT 1').bind(a.userId).first<Row>();if(!trip)return reply({error:'trip_not_found'},404);const tripId=String(trip.id);const [it,places,expenses,budget,checklist,trips]=await Promise.all([env.DB.prepare('SELECT id,day_number day,starts_at time,title,kind,notes FROM itinerary_items WHERE owner_user_id=? AND trip_id=? ORDER BY day_number,sort_order,starts_at').bind(a.userId,tripId).all(),env.DB.prepare('SELECT id,name,category,address,notes,latitude,longitude FROM places WHERE owner_user_id=? AND trip_id=? ORDER BY created_at').bind(a.userId,tripId).all(),env.DB.prepare('SELECT id,category,description,amount_cents,currency,spent_on FROM expenses WHERE owner_user_id=? AND trip_id=? ORDER BY created_at DESC').bind(a.userId,tripId).all(),env.DB.prepare('SELECT amount_cents,currency FROM budgets WHERE owner_user_id=? AND trip_id=?').bind(a.userId,tripId).first(),env.DB.prepare('SELECT id,text,completed,sort_order FROM checklist_items WHERE owner_user_id=? AND trip_id=? ORDER BY sort_order,created_at').bind(a.userId,tripId).all(),env.DB.prepare('SELECT id,name,destination,starts_on,ends_on,travelers,archived_at,updated_at FROM trips WHERE owner_user_id=? ORDER BY (archived_at IS NOT NULL),updated_at DESC').bind(a.userId).all()]);return reply({trip,trips:trips.results,entitlement:access,itinerary:it.results,places:places.results,expenses:expenses.results,budget:budget||{amount_cents:0,currency:'EUR'},checklist:checklist.results.map((x:Row)=>({...x,completed:Boolean(x.completed)}))});}
async function plannerTrip(req:Request,env:Env){const a=await mutationAuth(req,env);if(!a)return reply({error:'unauthorized'},401);const access=await requirePlannerAccess(a,env);if(!access)return reply({error:'free_trial_expired',upgrade_required:true},402);if(!(await canCreateActiveTrip(a,env,access)))return reply({error:'free_active_trip_limit',upgrade_required:true},403);const b=await body(req);const name=text(b?.name,120,1);if(!name)return reply({error:'invalid_trip'},400);const id=crypto.randomUUID();const travelers=Number.isInteger(b?.travelers)?Number(b?.travelers):1;await env.DB.batch([env.DB.prepare('INSERT INTO trips(id,owner_user_id,name,destination,starts_on,ends_on,travelers) VALUES(?,?,?,?,?,?,?)').bind(id,a.userId,name,text(b?.destination,180),text(b?.startsOn,10),text(b?.endsOn,10),travelers),env.DB.prepare("INSERT INTO budgets(trip_id,owner_user_id,amount_cents,currency) VALUES(?,?,0,'EUR')").bind(id,a.userId)]);return reply({id},201);}
async function plannerTripAction(req:Request,env:Env,tripId:string,action:string){const a=await mutationAuth(req,env);if(!a)return reply({error:'unauthorized'},401);const access=await requirePlannerAccess(a,env);if(!access)return reply({error:'free_trial_expired',upgrade_required:true},402);const trip=await env.DB.prepare('SELECT id,archived_at FROM trips WHERE id=? AND owner_user_id=?').bind(tripId,a.userId).first<Row>();if(!trip)return reply({error:'trip_not_found'},404);if(action==='archive'){if(trip.archived_at)return reply({ok:true});if(!access.unlimited){const count=await env.DB.prepare('SELECT count(*) n FROM trips WHERE owner_user_id=? AND archived_at IS NOT NULL').bind(a.userId).first<{n:number}>();if(Number(count?.n||0)>=2)return reply({error:'free_archived_trip_limit',upgrade_required:true},403);}await env.DB.prepare('UPDATE trips SET archived_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_user_id=?').bind(tripId,a.userId).run();await audit(env,a.userId,'planner.trip_archived','trip',tripId);return reply({ok:true});}if(action==='restore'){if(!trip.archived_at)return reply({ok:true});if(!(await canCreateActiveTrip(a,env,access)))return reply({error:'free_active_trip_limit',upgrade_required:true},403);await env.DB.prepare('UPDATE trips SET archived_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_user_id=?').bind(tripId,a.userId).run();await audit(env,a.userId,'planner.trip_restored','trip',tripId);return reply({ok:true});}return reply({error:'not_found'},404);}
async function ownedTrip(env:Env,userId:string,tripId:string){return await env.DB.prepare('SELECT archived_at FROM trips WHERE id=? AND owner_user_id=?').bind(tripId,userId).first<Row>();}
async function plannerItem(req:Request,env:Env,tripId:string,kind:string,itemId?:string){const a=await mutationAuth(req,env);if(!a)return reply({error:'unauthorized'},401);if(!(await requirePlannerAccess(a,env)))return reply({error:'free_trial_expired',upgrade_required:true},402);const trip=await ownedTrip(env,a.userId,tripId);if(!trip)return reply({error:'trip_not_found'},404);if(trip.archived_at)return reply({error:'trip_archived'},409);const b=await body(req);
  if(req.method==='DELETE'&&itemId){const table=kind==='itinerary'?'itinerary_items':kind==='places'?'places':kind==='expenses'?'expenses':kind==='checklist'?'checklist_items':null;if(!table)return reply({error:'invalid_item'},400);const r=await env.DB.prepare(`DELETE FROM ${table} WHERE id=? AND trip_id=? AND owner_user_id=?`).bind(itemId,tripId,a.userId).run();return r.meta.changes?reply({ok:true}):reply({error:'item_not_found'},404);}
  if(kind==='budget'&&req.method==='PUT'){const amount=Number(b?.amount);if(!Number.isFinite(amount)||amount<0)return reply({error:'invalid_budget'},400);await env.DB.prepare('UPDATE budgets SET amount_cents=?,updated_at=CURRENT_TIMESTAMP WHERE trip_id=? AND owner_user_id=?').bind(Math.round(amount*100),tripId,a.userId).run();return reply({ok:true});}
  if(kind==='checklist'&&req.method==='PATCH'&&itemId){if(typeof b?.completed!=='boolean')return reply({error:'invalid_checklist_item'},400);const r=await env.DB.prepare('UPDATE checklist_items SET completed=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND trip_id=? AND owner_user_id=?').bind(b.completed?1:0,itemId,tripId,a.userId).run();return r.meta.changes?reply({ok:true}):reply({error:'item_not_found'},404);}
  const id=crypto.randomUUID();
  if(kind==='itinerary'&&req.method==='POST'){const day=Number(b?.day),title=text(b?.title,240,1),itemKind=text(b?.kind,60,1);if(!Number.isInteger(day)||day<1||!title||!itemKind)return reply({error:'invalid_itinerary_item'},400);await env.DB.prepare('INSERT INTO itinerary_items(id,trip_id,owner_user_id,day_number,starts_at,title,kind,notes) VALUES(?,?,?,?,?,?,?,?)').bind(id,tripId,a.userId,day,text(b?.time,5),title,itemKind,text(b?.notes,2000)).run();return reply({id},201);}
  if(kind==='places'&&req.method==='POST'){const name=text(b?.name,240,1),category=text(b?.category,60,1);if(!name||!category)return reply({error:'invalid_place'},400);await env.DB.prepare('INSERT INTO places(id,trip_id,owner_user_id,name,category,address,notes) VALUES(?,?,?,?,?,?,?)').bind(id,tripId,a.userId,name,category,text(b?.address,500),text(b?.notes,2000)).run();return reply({id},201);}
  if(kind==='expenses'&&req.method==='POST'){const amount=Number(b?.amount),category=text(b?.category,60,1),description=text(b?.description,500,1);if(!Number.isFinite(amount)||amount<=0||!category||!description)return reply({error:'invalid_expense'},400);await env.DB.prepare("INSERT INTO expenses(id,trip_id,owner_user_id,category,description,amount_cents,currency) VALUES(?,?,?,?,?,?,'EUR')").bind(id,tripId,a.userId,category,description,Math.round(amount*100)).run();return reply({id},201);}
  if(kind==='checklist'&&req.method==='POST'){const itemText=text(b?.text,300,1);if(!itemText)return reply({error:'invalid_checklist_item'},400);await env.DB.prepare('INSERT INTO checklist_items(id,trip_id,owner_user_id,text,sort_order) VALUES(?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM checklist_items WHERE trip_id=? AND owner_user_id=?))').bind(id,tripId,a.userId,itemText,tripId,a.userId).run();return reply({id},201);}return reply({error:'not_found'},404);
}
async function plannerImport(req:Request,env:Env){const a=await mutationAuth(req,env);if(!a)return reply({error:'unauthorized'},401);const access=await requirePlannerAccess(a,env);if(!access)return reply({error:'free_trial_expired',upgrade_required:true},402);if(!(await canCreateActiveTrip(a,env,access)))return reply({error:'free_active_trip_limit',upgrade_required:true},403);const b=await body(req);if(!b||!Array.isArray(b.itinerary)||!Array.isArray(b.places)||!Array.isArray(b.expenses)||!Array.isArray(b.checklist))return reply({error:'invalid_import'},400);const id=crypto.randomUUID();await env.DB.batch([env.DB.prepare("INSERT INTO trips(id,owner_user_id,name,source) VALUES(?,?,'Viagem importada do navegador','local_import')").bind(id,a.userId),env.DB.prepare("INSERT INTO budgets(trip_id,owner_user_id,amount_cents,currency) VALUES(?,?,?,'EUR')").bind(id,a.userId,Math.round(Number(b.budget||0)*100))]);const stmts:D1PreparedStatement[]=[];for(const x of b.itinerary.slice(0,1000) as Row[]){const title=text(x.what,240,1);if(title)stmts.push(env.DB.prepare('INSERT INTO itinerary_items(id,trip_id,owner_user_id,day_number,starts_at,title,kind,notes) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,a.userId,Math.max(1,Number(x.day)||1),text(x.time,5),title,text(x.type,60)||'Atividade',text(x.notes,2000)));}for(const x of b.places.slice(0,1000) as Row[]){const name=text(x.name,240,1);if(name)stmts.push(env.DB.prepare('INSERT INTO places(id,trip_id,owner_user_id,name,category,address,notes) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,a.userId,name,text(x.type,60)||'Outro',text(x.address,500),text(x.notes,2000)));}for(const x of b.expenses.slice(0,1000) as Row[]){const amount=Number(x.value),description=text(x.desc,500,1);if(amount>0&&description)stmts.push(env.DB.prepare("INSERT INTO expenses(id,trip_id,owner_user_id,category,description,amount_cents,currency) VALUES(?,?,?,?,?,?,'EUR')").bind(crypto.randomUUID(),id,a.userId,text(x.type,60)||'Outros',description,Math.round(amount*100)));}for(const [i,x] of (b.checklist.slice(0,1000) as Row[]).entries()){const t=text(x.text,300,1);if(t)stmts.push(env.DB.prepare('INSERT INTO checklist_items(id,trip_id,owner_user_id,text,completed,sort_order) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),id,a.userId,t,x.done?1:0,i));}for(let i=0;i<stmts.length;i+=100)await env.DB.batch(stmts.slice(i,i+100));return reply({id},201);}

// --- Partner referral program -------------------------------------------------------------

async function referralClick(req:Request,env:Env,rawCode:string){
  const fallback=()=>new Response(null,{status:302,headers:{location:'/',...{'cache-control':'no-store'}}});
  const codeValue=normalizeCode(decodeURIComponent(rawCode));
  if(!validCode(codeValue))return fallback();
  const partner=await env.DB.prepare('SELECT id,attribution_window_days FROM partners WHERE code=? AND active=1').bind(codeValue).first<{id:string;attribution_window_days:number}>();
  if(!partner)return fallback();
  // Anonymous burst-click protection, mirroring the Node backend: a repeated click from the
  // same (IP, user-agent) pair for the same code within 60s is deduplicated so it cannot inflate
  // click metrics. Reuses the same rate_limit_buckets table/helper as every other rate-limited
  // route. Only a raw client IP is never stored — `sha()` (SHA-256) is applied first, same as
  // the existing ip_hash/visitor_hash columns already did. The visitor still always gets their
  // cookie and redirect below regardless of whether this click was counted.
  const visitorKey=await sha(`${clientKey(req)}|${req.headers.get('user-agent')||''}`);
  const firstClickInWindow=await rateLimit(req,env,'referral_click',`${codeValue}:${visitorKey}`,1,60);
  if(firstClickInWindow){
    try{
      await env.DB.prepare('INSERT INTO referral_clicks (id,partner_id,landing_path,visitor_hash,ip_hash,user_agent) VALUES (?,?,?,?,?,?)')
        .bind(crypto.randomUUID(),partner.id,'/proposta-voo.html',visitorKey,await sha(clientKey(req)),(req.headers.get('user-agent')||'').slice(0,300)).run();
    }catch{/* telemetry must never block the redirect */}
  }
  const capturedAtMs=Date.now();
  const token=await signRef(codeValue,capturedAtMs,env);
  const headers=new Headers({location:`/proposta-voo.html?ref=${encodeURIComponent(codeValue)}`,'cache-control':'no-store'});
  headers.append('set-cookie',`${REF_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${partner.attribution_window_days*86400}; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null,{status:302,headers});
}

async function partnerAttribution(req:Request,env:Env,url:URL){
  const attribution=await resolveAttribution(req,env,url.searchParams.get('ref'));
  if(!attribution)return reply({active:false},200,{'cache-control':'no-store'});
  const partner=await env.DB.prepare('SELECT display_name FROM partners WHERE id=?').bind(attribution.partnerId).first<{display_name:string}>();
  if(!partner)return reply({active:false},200,{'cache-control':'no-store'});
  return reply({active:true,code:attribution.code,displayName:partner.display_name},200,{'cache-control':'no-store'});
}

function serializePartnerRow(row:Row){
  return {id:row.id,code:row.code,displayName:row.display_name,instagram:row.instagram,whatsapp:row.whatsapp,email:row.email,
    commissionType:row.commission_type,commissionFixedCents:row.commission_fixed_cents,commissionPercentageBps:row.commission_percentage_bps,
    currency:row.currency,attributionWindowDays:row.attribution_window_days,active:Boolean(row.active),hasAccount:Boolean(row.user_id),accountActivated:Boolean(row.account_activated),createdAt:row.created_at,
    clicks:row.clicks,proposals:row.proposals,conversions:row.conversions,commissionPendingCents:row.commission_pending_cents,commissionApprovedCents:row.commission_approved_cents,commissionPaidCents:row.commission_paid_cents};
}

async function adminPartners(req:Request,env:Env,url:URL){
  if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);
  const activeParam=url.searchParams.get('active');
  const rows=await env.DB.prepare(`SELECT p.*,
    (SELECT count(*) FROM referral_clicks c WHERE c.partner_id=p.id) clicks,
    (SELECT count(*) FROM lead_requests l WHERE l.partner_id=p.id) proposals,
    (SELECT count(*) FROM lead_requests l WHERE l.partner_id=p.id AND l.status='converted') conversions,
    (SELECT COALESCE(sum(amount_cents),0) FROM partner_commissions pc WHERE pc.partner_id=p.id AND pc.status='pending') commission_pending_cents,
    (SELECT COALESCE(sum(amount_cents),0) FROM partner_commissions pc WHERE pc.partner_id=p.id AND pc.status='approved') commission_approved_cents,
    (SELECT COALESCE(sum(amount_cents),0) FROM partner_commissions pc WHERE pc.partner_id=p.id AND pc.status='paid') commission_paid_cents,
    (activated.user_id IS NOT NULL) account_activated
    FROM partners p LEFT JOIN (SELECT DISTINCT user_id FROM user_roles WHERE role='partner') activated ON activated.user_id=p.user_id
    ${activeParam!==null?'WHERE p.active=?':''} ORDER BY p.created_at DESC LIMIT 200`)
    .bind(...(activeParam!==null?[activeParam==='true'?1:0]:[])).all<Row>();
  return reply({partners:rows.results.map(serializePartnerRow)});
}

async function partnerApplicationCreate(req:Request,env:Env){
  const b=await body(req);
  const displayName=text(b?.displayName,120,2);
  const email=emailOf(b?.email);
  const instagram=text(b?.instagram,120,2);
  const whatsapp=phoneOf(b?.whatsapp);
  if(b?.website)return reply({ok:true},202);
  if(!displayName||!email||!instagram||!whatsapp||b?.privacyConsent!==true)return reply({error:'invalid_partner_application'},400);
  if(!(await rateLimit(req,env,'partner-application',email,3,3600)))return reply({error:'too_many_attempts'},429);
  const pending=await env.DB.prepare("SELECT 1 FROM partner_applications WHERE lower(email)=lower(?) AND status='pending'").bind(email).first();
  if(pending)return reply({error:'partner_application_already_pending'},409);
  const id=crypto.randomUUID();
  try{
    await env.DB.prepare("INSERT INTO partner_applications(id,display_name,email,instagram,whatsapp,privacy_consent) VALUES(?,?,?,?,?,1)").bind(id,displayName,email,instagram,whatsapp).run();
  }catch(error){return reply({error:'partner_application_already_pending'},409);}
  await audit(env,null,'public.partner_application_created','partner_application',id);
  return reply({ok:true},201);
}

async function adminPartnerApplications(req:Request,env:Env){
  if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);
  const rows=await env.DB.prepare("SELECT id,display_name,email,instagram,whatsapp,status,partner_id,created_at,reviewed_at FROM partner_applications ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,created_at DESC LIMIT 200").all<Row>();
  return reply({applications:rows.results.map((row)=>({id:row.id,displayName:row.display_name,email:row.email,instagram:row.instagram,whatsapp:row.whatsapp,status:row.status,partnerId:row.partner_id,createdAt:row.created_at,reviewedAt:row.reviewed_at}))});
}

async function adminPartnerApplicationReject(req:Request,env:Env,id:string){
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);
  const updated=await env.DB.prepare("UPDATE partner_applications SET status='rejected',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(auth.userId,id).run();
  if(!updated.meta.changes)return reply({error:'partner_application_not_pending'},409);
  await audit(env,auth.userId,'admin.partner_application_rejected','partner_application',id);
  return reply({ok:true});
}

async function adminPartnerCreate(req:Request,env:Env){
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);
  const b=await body(req);
  const codeValue=typeof b?.code==='string'?normalizeCode(b.code):'';
  const displayName=text(b?.displayName,120,2);
  const email=emailOf(b?.email);
  const applicationId=typeof b?.applicationId==='string'&&/^[0-9a-f-]{36}$/i.test(b.applicationId)?b.applicationId:null;
  const commissionType=b?.commissionType==='fixed'||b?.commissionType==='percentage'?b?.commissionType:null;
  const commissionFixedCents=Number.isInteger(b?.commissionFixedCents)?Number(b?.commissionFixedCents):null;
  const commissionPercentageBps=Number.isInteger(b?.commissionPercentageBps)?Number(b?.commissionPercentageBps):null;
  const currency=typeof b?.currency==='string'&&b.currency.length===3?b?.currency.toUpperCase():'EUR';
  const attributionWindowDays=Number.isInteger(b?.attributionWindowDays)&&Number(b?.attributionWindowDays)>0?Number(b?.attributionWindowDays):30;
  if(!validCode(codeValue)||!displayName||!email||!commissionType)return reply({error:'invalid_partner'},400);
  if(commissionType==='fixed'&&(commissionFixedCents===null||commissionPercentageBps!==null))return reply({error:'invalid_partner'},400);
  if(commissionType==='percentage'&&(commissionPercentageBps===null||commissionFixedCents!==null))return reply({error:'invalid_partner'},400);
  if(!validCurrency(currency))return reply({error:'invalid_currency'},422);
  let application:Row|null=null;
  if(applicationId){
    application=await env.DB.prepare("SELECT id,email FROM partner_applications WHERE id=? AND status='pending'").bind(applicationId).first<Row>();
    if(!application||emailOf(application.email)!==email)return reply({error:'partner_application_not_pending'},409);
  }
  const existing=await env.DB.prepare('SELECT 1 FROM partners WHERE code=?').bind(codeValue).first();
  if(existing)return reply({error:'code_already_used'},409);
  const existingEmail=await env.DB.prepare('SELECT 1 FROM partners WHERE lower(email)=lower(?)').bind(email).first();
  if(existingEmail)return reply({error:'email_already_used_by_partner'},409);
  const id=crypto.randomUUID();
  try {
    const statements=[env.DB.prepare(`INSERT INTO partners (id,code,display_name,instagram,whatsapp,email,commission_type,commission_fixed_cents,commission_percentage_bps,currency,attribution_window_days,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`)
      .bind(id,codeValue,displayName,text(b?.instagram,120)||null,text(b?.whatsapp,30)||null,email,commissionType,commissionFixedCents,commissionPercentageBps,currency,attributionWindowDays)];
    if(application)statements.push(env.DB.prepare("UPDATE partner_applications SET status='accepted',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,partner_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(auth.userId,id,application.id));
    const results=await env.DB.batch(statements);
    if(application&&!results[1]?.meta.changes){await env.DB.prepare('DELETE FROM partners WHERE id=?').bind(id).run();return reply({error:'partner_application_not_pending'},409);}
  } catch (error) {
    return reply({error:'code_or_email_already_used'},409);
  }
  await audit(env,auth.userId,'admin.partner_created','partner',id);
  if(application)await audit(env,auth.userId,'admin.partner_application_accepted','partner_application',String(application.id));
  return reply({id,code:codeValue},201);
}

async function adminPartnerDetail(req:Request,env:Env,id:string){
  if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);
  const partner=await env.DB.prepare("SELECT p.*,(activated.user_id IS NOT NULL) account_activated FROM partners p LEFT JOIN (SELECT DISTINCT user_id FROM user_roles WHERE role='partner') activated ON activated.user_id=p.user_id WHERE p.id=?").bind(id).first<Row>();
  if(!partner)return reply({error:'not_found'},404);
  const commissions=await env.DB.prepare(`SELECT pc.id,pc.amount_cents,pc.currency,pc.status,pc.created_at,pc.approved_at,pc.paid_at,pc.voided_at,pc.void_reason,l.protocol,l.status lead_status,l.origin,l.destination FROM partner_commissions pc JOIN lead_requests l ON l.id=pc.lead_request_id WHERE pc.partner_id=? ORDER BY pc.created_at DESC LIMIT 200`).bind(id).all<Row>();
  return reply({partner:serializePartnerRow(partner),commissions:commissions.results});
}

async function adminPartnerUpdate(req:Request,env:Env,id:string){
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);
  const partner=await env.DB.prepare('SELECT * FROM partners WHERE id=?').bind(id).first<Row>();
  if(!partner)return reply({error:'not_found'},404);
  const b=await body(req);
  const commissionType=b?.commissionType==='fixed'||b?.commissionType==='percentage'?b?.commissionType:String(partner.commission_type);
  const commissionFixedCents=commissionType==='fixed'?(Number.isInteger(b?.commissionFixedCents)?Number(b?.commissionFixedCents):partner.commission_fixed_cents):null;
  const commissionPercentageBps=commissionType==='percentage'?(Number.isInteger(b?.commissionPercentageBps)?Number(b?.commissionPercentageBps):partner.commission_percentage_bps):null;
  if(commissionType==='fixed'&&commissionFixedCents===null)return reply({error:'invalid_partner'},400);
  if(commissionType==='percentage'&&commissionPercentageBps===null)return reply({error:'invalid_partner'},400);
  const displayName=text(b?.displayName,120,2)||String(partner.display_name);
  const instagram=b?.instagram!==undefined?(text(b?.instagram,120)||null):partner.instagram;
  const whatsapp=b?.whatsapp!==undefined?(text(b?.whatsapp,30)||null):partner.whatsapp;
  const currency=typeof b?.currency==='string'&&b.currency.length===3?b?.currency.toUpperCase():String(partner.currency);
  if(!validCurrency(currency))return reply({error:'invalid_currency'},422);
  const attributionWindowDays=Number.isInteger(b?.attributionWindowDays)&&Number(b?.attributionWindowDays)>0?Number(b?.attributionWindowDays):Number(partner.attribution_window_days);
  const active=typeof b?.active==='boolean'?b?.active:Boolean(partner.active);
  if(currency!==String(partner.currency)){
    // Changing currency after real commission history exists would make aggregate totals mix
    // currencies (or silently reinterpret historical amounts). Locked once non-void commissions
    // exist, same rule as the Node/Postgres backend.
    const hasCommissions=await env.DB.prepare("SELECT 1 FROM partner_commissions WHERE partner_id=? AND status<>'void' LIMIT 1").bind(id).first();
    if(hasCommissions)return reply({error:'currency_locked_existing_commissions'},409);
  }
  await env.DB.prepare(`UPDATE partners SET display_name=?,instagram=?,whatsapp=?,commission_type=?,commission_fixed_cents=?,commission_percentage_bps=?,currency=?,attribution_window_days=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(displayName,instagram,whatsapp,commissionType,commissionFixedCents,commissionPercentageBps,currency,attributionWindowDays,active?1:0,id).run();
  await audit(env,auth.userId,'admin.partner_updated','partner',id);
  return reply({ok:true});
}

async function adminPartnerInvite(req:Request,env:Env,id:string){
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);
  const partner=await env.DB.prepare('SELECT * FROM partners WHERE id=?').bind(id).first<Row>();
  if(!partner)return reply({error:'not_found'},404);
  if(!partner.active)return reply({error:'partner_inactive'},409);
  // Another partner already owns this email/account (partners.user_id and lower(partners.email)
  // are both unique as of migration 0006) — checked explicitly here for a clear, safe error
  // instead of letting a raw unique-constraint violation surface later.
  const conflicting=await env.DB.prepare('SELECT p.id FROM partners p JOIN users u ON u.id=p.user_id WHERE u.email=? AND p.id<>?').bind(partner.email,id).first<Row>();
  if(conflicting)return reply({error:'email_linked_to_other_partner'},409);
  let user=await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(partner.email).first<Row>();
  const userId=user?String(user.id):crypto.randomUUID();
  if(!user){
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users(id,email,status) VALUES(?,?,'pending')").bind(userId,partner.email),
      env.DB.prepare('INSERT INTO profiles(user_id,display_name) VALUES(?,?)').bind(userId,partner.display_name),
    ]);
  }
  const code=code6();
  // Links the account and prepares the invite token, but never grants the 'partner' role here —
  // that only happens in partnerInviteAccept below, after the single-use code is validated. An
  // already-active account (e.g. an existing customer with this email) gains no access just
  // because an invite was created; resending also invalidates every previous unused token.
  await env.DB.batch([
    env.DB.prepare('UPDATE partners SET user_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(userId,id),
    env.DB.prepare("UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND purpose='partner_invite' AND used_at IS NULL").bind(userId),
    env.DB.prepare("INSERT INTO account_tokens(id,user_id,purpose,token_hash,expires_at) VALUES(?,?,'partner_invite',?,?)").bind(crypto.randomUUID(),userId,await digest(code,env),isoAfter(900)),
  ]);
  await sendEmail(env,userId,String(partner.email),'partner_invite','Convite para o painel de parceiros - Rota Certa Passagens',`<p>Você foi convidado(a) para acompanhar suas indicações no painel de parceiros da Rota Certa Passagens.</p><p>Seu código de ativação é: <strong>${code}</strong></p><p><a href="${env.APP_ORIGIN}/parceiro-convite.html">Finalizar cadastro do parceiro</a></p><p>Use o mesmo e-mail que recebeu este convite. O código expira em 15 minutos e só pode ser usado uma vez.</p>`,`Você foi convidado(a) para o painel de parceiros da Rota Certa Passagens. Código de ativação: ${code}. Finalize em ${env.APP_ORIGIN}/parceiro-convite.html. O código expira em 15 minutos e só pode ser usado uma vez.`);
  await audit(env,auth.userId,'admin.partner_invite_created','partner',id);
  return reply({ok:true},201);
}

async function partnerInviteAccept(req:Request,env:Env){
  const b=await body(req);const email=emailOf(b?.email);const codeValue=typeof b?.code==='string'&&/^\d{6}$/.test(b.code)?b.code:null;const password=b?.password;
  if(!validPassword(password)||!email||!codeValue)return reply({error:'invalid_or_expired_invite'},400);
  if(!(await rateLimit(req,env,'partner-invite-accept',email,8,900)))return reply({error:'too_many_attempts'},429);
  const row=await env.DB.prepare("SELECT t.id,t.user_id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email=? AND t.token_hash=? AND t.purpose='partner_invite' AND t.used_at IS NULL AND t.expires_at>CURRENT_TIMESTAMP AND t.failed_attempts<5 LIMIT 1").bind(email,await digest(codeValue,env)).first<Row>();
  if(!row){await env.DB.prepare("UPDATE account_tokens SET failed_attempts=failed_attempts+1 WHERE id=(SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email=? AND t.purpose='partner_invite' AND t.used_at IS NULL ORDER BY t.created_at DESC LIMIT 1)").bind(email).run();return reply({error:'invalid_or_expired_invite'},400);}
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash=?,status='active',email_verified_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(await passwordHash(password),row.user_id),
      // The 'partner' role is granted only here, transactionally, right after the single-use
      // code was validated above — never at invite-creation time.
      env.DB.prepare("INSERT OR IGNORE INTO user_roles(user_id,role) VALUES(?,'partner')").bind(row.user_id),
      env.DB.prepare('UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?').bind(row.id),
    ]);
  } catch (error) {
    return reply({error:'email_linked_to_other_partner'},409);
  }
  await audit(env,String(row.user_id),'partner.invite_accepted','user',String(row.user_id));
  return reply({ok:true});
}

async function requirePartnerSelf(req:Request,env:Env):Promise<Row|null>{
  const auth=await getAuth(req,env);if(!auth||!auth.roles.includes('partner'))return null;
  // A deactivated partner loses panel access immediately: only an active row is ever returned,
  // so a deactivated partner gets the same "forbidden" outcome as no partner record at all.
  const partner=await env.DB.prepare('SELECT * FROM partners WHERE user_id=? AND active=1').bind(auth.userId).first<Row>();
  return partner||null;
}

async function partnerSummary(req:Request,env:Env){
  const partner=await requirePartnerSelf(req,env);if(!partner)return reply({error:'forbidden'},403,{'cache-control':'no-store'});
  const clicks=await env.DB.prepare('SELECT count(*) n FROM referral_clicks WHERE partner_id=?').bind(partner.id).first<{n:number}>();
  const proposals=await env.DB.prepare('SELECT count(*) n FROM lead_requests WHERE partner_id=?').bind(partner.id).first<{n:number}>();
  const conversions=await env.DB.prepare("SELECT count(*) n FROM lead_requests WHERE partner_id=? AND status='converted'").bind(partner.id).first<{n:number}>();
  const commissionRows=await env.DB.prepare('SELECT status,COALESCE(sum(amount_cents),0) total FROM partner_commissions WHERE partner_id=? GROUP BY status').bind(partner.id).all<{status:string;total:number}>();
  const totals:Record<string,number>={pending:0,approved:0,paid:0,void:0};
  for(const row of commissionRows.results)totals[row.status]=row.total;
  return reply({
    partner:{code:partner.code,displayName:partner.display_name,active:Boolean(partner.active),commissionType:partner.commission_type,commissionFixedCents:partner.commission_fixed_cents,commissionPercentageBps:partner.commission_percentage_bps,currency:partner.currency,attributionWindowDays:partner.attribution_window_days,link:`${env.APP_ORIGIN.replace(/\/$/,'')}/i/${partner.code}`},
    stats:{clicks:clicks?.n||0,proposals:proposals?.n||0,conversions:conversions?.n||0},
    commissionTotalsCents:totals,
  },200,{'cache-control':'no-store'});
}

async function partnerLedger(req:Request,env:Env){
  const partner=await requirePartnerSelf(req,env);if(!partner)return reply({error:'forbidden'},403,{'cache-control':'no-store'});
  const leads=await env.DB.prepare('SELECT id,protocol,status,origin,destination,created_at,converted_at,referral_source FROM lead_requests WHERE partner_id=? ORDER BY created_at DESC LIMIT 200').bind(partner.id).all<Row>();
  // Documented, deterministic "current commission per lead" rule (mirrors the Node backend): a
  // lead can have more than one historical commission row (converted -> voided -> reconverted).
  // The SQL ORDER BY guarantees the first row seen per lead_request_id is the active (non-void)
  // commission if one exists, otherwise the most recently voided one — the Map below is safe
  // because of that explicit order, not because of an unspecified database row order.
  const commissions=await env.DB.prepare("SELECT lead_request_id,amount_cents,currency,status FROM partner_commissions WHERE partner_id=? ORDER BY (status='void') ASC, created_at DESC").bind(partner.id).all<Row>();
  const byLead=new Map<string,Row>();
  for(const c of commissions.results){const key=String(c.lead_request_id);if(!byLead.has(key))byLead.set(key,c);}
  return reply({entries:leads.results.map(lead=>{
    const commission=byLead.get(String(lead.id));
    return {protocolMasked:maskProtocol(String(lead.protocol)),route:lead.origin&&lead.destination?`${lead.origin} → ${lead.destination}`:null,status:lead.status,referralSource:lead.referral_source,requestedAt:lead.created_at,convertedAt:lead.converted_at,
      commission:commission?{amountCents:commission.amount_cents,currency:commission.currency,status:commission.status}:null};
  })},200,{'cache-control':'no-store'});
}

async function commissionTransition(req:Request,env:Env,id:string,action:'approve'|'pay'|'void'){
  const auth=await mutationAuth(req,env);if(!auth)return reply({error:'unauthorized'},401);if(!auth.roles.includes('master'))return reply({error:'forbidden'},403);
  if(action==='void'){
    const b=await body(req);const reasonValue=text(b?.reason,500,3);if(!reasonValue)return reply({error:'invalid_request'},400);
    const current=await env.DB.prepare('SELECT id,status FROM partner_commissions WHERE id=?').bind(id).first<{id:string;status:string}>();
    if(!current)return reply({error:'not_found'},404);
    // A paid commission is a settled financial fact and can never be voided directly.
    if(current.status==='paid')return reply({error:'commission_paid_requires_adjustment'},409);
    if(current.status==='void')return reply({error:'already_void'},409);
    const result=await env.DB.prepare("UPDATE partner_commissions SET status='void',voided_at=CURRENT_TIMESTAMP,voided_by=?,void_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','approved')").bind(auth.userId,reasonValue,id).run();
    if(!result.meta.changes)return reply({error:'invalid_transition'},409);
    await audit(env,auth.userId,'admin.commission_voided','partner_commission',id);
    return reply({ok:true});
  }
  const target=action==='approve'?'approved':'paid';
  const allowedFrom=action==='approve'?'pending':'approved';
  const columns=action==='approve'?'approved_at=CURRENT_TIMESTAMP,approved_by=?':'paid_at=CURRENT_TIMESTAMP,paid_by=?';
  const commission=await env.DB.prepare('SELECT partner_id,amount_cents,currency FROM partner_commissions WHERE id=? AND status=?').bind(id,allowedFrom).first<Row>();
  if(!commission)return reply({error:'invalid_transition'},409);
  await env.DB.prepare(`UPDATE partner_commissions SET status=?,${columns},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(target,auth.userId,id).run();
  await audit(env,auth.userId,`admin.commission_${target}`,'partner_commission',id);
  if(action==='pay'){
    await env.DB.prepare(`INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload) VALUES (?,?,'commission_paid',?,?) ON CONFLICT(idempotency_key) DO NOTHING`)
      .bind(crypto.randomUUID(),`commission_paid:${id}`,commission.partner_id,JSON.stringify({commissionId:id,amountCents:commission.amount_cents,currency:commission.currency})).run();
  }
  return reply({ok:true});
}

// --- Notifications: in-repo outbox processor (capture mode by default) -------------------

const OUTBOX_LEASE_SECONDS=120;

function escapeHtmlText(value:string){return value.replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}as Record<string,string>)[c]!);}
function formatCentsAmount(cents:unknown,currency:unknown){const amount=typeof cents==='number'?cents:Number(cents??0);const code=typeof currency==='string'&&currency.length===3?currency:'EUR';return `${(amount/100).toFixed(2)} ${code}`;}

/** Mirrors src/routes/notifications.ts's renderNotification exactly: same field names (see
 * ../shared/notificationPayloads.ts), same fail-closed payload validation, no customer PII —
 * only the partner's own display name and aggregate/business facts about their own account. */
function renderOutboxNotification(row:{event_type:string;payload:unknown},partnerName:string){
  const safeName=escapeHtmlText(partnerName||'parceiro(a)');
  switch(row.event_type){
    case 'referral_confirmed':
      return {subject:'Nova indicação recebida',html:`<p>Olá, ${safeName}.</p><p>Chegou uma nova indicação pelo seu link de parceiro. Acompanhe os detalhes no seu painel.</p>`};
    case 'proposal_converted':
      return {subject:'Uma indicação sua fechou negócio',html:`<p>Olá, ${safeName}.</p><p>Uma proposta indicada por você foi convertida em venda. A comissão correspondente já está visível no seu painel de parceiros.</p>`};
    case 'commission_paid': {
      // Validated before rendering: a malformed payload throws (caught by the caller, treated as
      // a failed outbox attempt) instead of silently rendering "0.00 EUR".
      const payload=parseCommissionPaidPayload(row.payload);
      const amount=formatCentsAmount(payload.amountCents,payload.currency);
      return {subject:'Comissão paga',html:`<p>Olá, ${safeName}.</p><p>Sua comissão de <strong>${escapeHtmlText(amount)}</strong> foi marcada como paga. Consulte o extrato completo no seu painel.</p>`};
    }
    case 'weekly_summary': {
      const payload=parseWeeklySummaryPayload(row.payload);
      const commission=formatCentsAmount(payload.commissionCents,payload.currency);
      return {subject:'Resumo semanal do seu link',html:`<p>Olá, ${safeName}.</p><p>Resumo da semana: <strong>${payload.clicks}</strong> cliques, <strong>${payload.proposals}</strong> propostas, <strong>${payload.conversions}</strong> conversões e <strong>${escapeHtmlText(commission)}</strong> em novas comissões.</p>`};
    }
    default:
      return {subject:'Atualização do programa de parceiros',html:`<p>Olá, ${safeName}. Você tem uma atualização.</p>`};
  }
}

async function notificationsProcess(req:Request,env:Env){
  const actorUserId=await requireMasterOrCronUserId(req,env);if(actorUserId===undefined)return reply({error:'forbidden'},403);
  const b=await body(req);const limit=Number.isInteger(b?.limit)&&Number(b?.limit)>0&&Number(b?.limit)<=200?Number(b?.limit):50;
  // Claim/lease: each eligible row is claimed with a conditional compare-and-swap UPDATE (flips
  // 'pending' — or 'processing' with an expired lease — to 'processing' with this invocation's
  // own lock_token and a short lease, WHERE the row is still in that claimable state) before
  // anything is sent. D1/SQLite executes each single UPDATE statement atomically, so two
  // concurrent calls racing on the *same row* can never both have their conditional UPDATE match
  // — one succeeds (meta.changes===1), the other's WHERE clause no longer matches (meta.changes
  // ===0) once the winner's UPDATE has applied. This is a real compare-and-swap per row, not the
  // same mechanism as the PostgreSQL `FOR UPDATE SKIP LOCKED` claim in src/routes/notifications.ts
  // (D1 has no equivalent multi-row locking clause) — but it gives the same end result: at most
  // one caller ever holds a given row's lock_token at a time.
  //
  // Holding the lock_token is still not "exactly once" delivery: if the external send takes
  // longer than the lease, another worker can reclaim the row and resend. See the lease renewal
  // below and idempotencyKey passed to sendEmail/the WhatsApp webhook.
  const lockToken=crypto.randomUUID();
  const claimableIds=await env.DB.prepare(
    "SELECT id FROM notification_outbox WHERE next_attempt_at<=CURRENT_TIMESTAMP AND (status='pending' OR (status='processing' AND lease_expires_at<CURRENT_TIMESTAMP)) ORDER BY next_attempt_at ASC LIMIT ?",
  ).bind(limit).all<{id:string}>();
  let sent=0,skipped=0,failed=0,lockLost=0;
  for(const {id:claimId} of claimableIds.results){
    const claim=await env.DB.prepare(
      "UPDATE notification_outbox SET status='processing',lock_token=?,lease_expires_at=datetime(CURRENT_TIMESTAMP,'+'||?||' seconds'),updated_at=CURRENT_TIMESTAMP WHERE id=? AND (status='pending' OR (status='processing' AND lease_expires_at<CURRENT_TIMESTAMP))",
    ).bind(lockToken,String(OUTBOX_LEASE_SECONDS),claimId).run();
    if(!claim.meta.changes)continue; // another concurrent call claimed this row first
    const row=await env.DB.prepare('SELECT id,idempotency_key,event_type,partner_id,channel,payload,attempts FROM notification_outbox WHERE id=? AND lock_token=?').bind(claimId,lockToken).first<Row>();
    if(!row)continue;
    const payload=typeof row.payload==='string'?JSON.parse(row.payload):row.payload;
    try{
      if(row.channel==='whatsapp'&&(env.WHATSAPP_NOTIFICATIONS_ENABLED as 'false'|'true')!=='true'){
        const skip=await env.DB.prepare("UPDATE notification_outbox SET status='skipped',updated_at=CURRENT_TIMESTAMP WHERE id=? AND lock_token=?").bind(row.id,lockToken).run();
        if(skip.meta.changes)skipped++;else lockLost++;
        continue;
      }
      // Renew the lease immediately before the external call — same rationale as
      // src/routes/notifications.ts's processOutboxRow: abort before sending if the lock was
      // already lost, so this invocation never fires a send the new owner will also fire.
      const renew=await env.DB.prepare("UPDATE notification_outbox SET lease_expires_at=datetime(CURRENT_TIMESTAMP,'+'||?||' seconds'),updated_at=CURRENT_TIMESTAMP WHERE id=? AND lock_token=?").bind(String(OUTBOX_LEASE_SECONDS),row.id,lockToken).run();
      if(!renew.meta.changes){lockLost++;continue;}
      if(row.channel==='whatsapp'){
        const notificationSecrets=env as Env & OptionalNotificationSecrets;
        if(!notificationSecrets.WHATSAPP_WEBHOOK_URL||!notificationSecrets.WHATSAPP_WEBHOOK_TOKEN)throw new Error('whatsapp_webhook_not_configured');
        const response=await fetch(notificationSecrets.WHATSAPP_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${notificationSecrets.WHATSAPP_WEBHOOK_TOKEN}`,'idempotency-key':String(row.idempotency_key)},body:JSON.stringify({eventType:row.event_type,partnerId:row.partner_id,payload,idempotencyKey:row.idempotency_key})});
        if(!response.ok)throw new Error(`whatsapp_webhook_http_${response.status}`);
      }else{
        const partner=await env.DB.prepare('SELECT email,display_name FROM partners WHERE id=?').bind(row.partner_id).first<{email:string;display_name:string}>();
        if(!partner?.email)throw new Error('partner_email_missing');
        // Reuses the same sendEmail() helper every other worker email flow uses: EMAIL_MODE=capture
        // (the default, used by every local/test run including the Worker/D1 smoke test) never
        // touches the network; EMAIL_MODE=resend is required for a real send. Real, partner-facing
        // content instead of a manual, content-less email_events row, with the outbox row's own
        // idempotency_key passed through for provider-level deduplication.
        const {subject,html:htmlBody}=renderOutboxNotification({event_type:row.event_type as string,payload},partner.display_name);
        await sendEmail(env,null,partner.email,`partner_${row.event_type}`,subject,htmlBody,undefined,String(row.idempotency_key));
      }
      const done=await env.DB.prepare("UPDATE notification_outbox SET status='sent',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND lock_token=?").bind(row.id,lockToken).run();
      if(done.meta.changes)sent++;else lockLost++;
    }catch(error){
      const attempts=Number(row.attempts)+1;const message=(error instanceof Error?error.message:'unknown_error').slice(0,200);
      const result=attempts>=5
        ?await env.DB.prepare("UPDATE notification_outbox SET status='failed',attempts=?,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND lock_token=?").bind(attempts,message,row.id,lockToken).run()
        :await env.DB.prepare("UPDATE notification_outbox SET attempts=?,last_error=?,next_attempt_at=datetime(CURRENT_TIMESTAMP,'+'||?||' minutes'),status='pending',lock_token=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND lock_token=?").bind(attempts,message,String(2**attempts),row.id,lockToken).run();
      if(result.meta.changes)failed++;else lockLost++;
    }
  }
  await audit(env,actorUserId,'admin.notifications_processed','notification_outbox','');
  return reply({processed:sent+skipped+failed,sent,skipped,failed,lockLost});
}

/**
 * Timezone-safe (DST-correct) start of the current Europe/Lisbon week (Monday 00:00 local).
 * Mirrors src/security.ts's lisbonWeekStartUtc exactly: reads Lisbon's real UTC offset for the
 * target calendar date (via Intl's shortOffset, which already accounts for DST) instead of
 * parsing a local-looking string in the host process's own timezone.
 */
function lisbonWeekStartIso(reference:Date){
  const dateFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Lisbon',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'});
  const parts=Object.fromEntries(dateFormatter.formatToParts(reference).map(p=>[p.type,p.value]));
  const weekdayIndex=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(parts.weekday);
  const referenceDateUtcMs=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day));
  const mondayDateUtcMs=referenceDateUtcMs-weekdayIndex*86_400_000;
  const monday=new Date(mondayDateUtcMs);
  const guessInstant=Date.UTC(monday.getUTCFullYear(),monday.getUTCMonth(),monday.getUTCDate());
  const offsetParts=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Lisbon',timeZoneName:'shortOffset'}).formatToParts(new Date(guessInstant));
  const tzName=offsetParts.find(p=>p.type==='timeZoneName')?.value??'GMT';
  const match=/GMT([+-]\d{1,2})?/.exec(tzName);
  const offsetMinutes=(match?.[1]?Number.parseInt(match[1],10):0)*60;
  return new Date(guessInstant-offsetMinutes*60_000);
}

async function notificationsWeeklySummary(req:Request,env:Env){
  const actorUserId=await requireMasterOrCronUserId(req,env);if(actorUserId===undefined)return reply({error:'forbidden'},403);
  const weekStart=lisbonWeekStartIso(new Date());const weekStartIso=weekStart.toISOString();
  // `currency` selected alongside the partner so the payload always carries the partner's own
  // configured currency — see src/routes/notifications.ts's mirrored fix and
  // ../shared/notificationPayloads.ts's WeeklySummaryPayload contract both backends share.
  const partners=await env.DB.prepare('SELECT id,code,display_name,currency FROM partners WHERE active=1').all<Row>();
  let created=0;
  for(const partner of partners.results){
    const clicks=await env.DB.prepare('SELECT count(*) n FROM referral_clicks WHERE partner_id=? AND clicked_at>=?').bind(partner.id,weekStartIso).first<{n:number}>();
    const proposals=await env.DB.prepare('SELECT count(*) n FROM lead_requests WHERE partner_id=? AND created_at>=?').bind(partner.id,weekStartIso).first<{n:number}>();
    const conversions=await env.DB.prepare("SELECT count(*) n FROM lead_requests WHERE partner_id=? AND status='converted' AND converted_at>=?").bind(partner.id,weekStartIso).first<{n:number}>();
    const commission=await env.DB.prepare("SELECT COALESCE(sum(amount_cents),0) n FROM partner_commissions WHERE partner_id=? AND status<>'void' AND created_at>=?").bind(partner.id,weekStartIso).first<{n:number}>();
    const idempotencyKey=`weekly_summary:${partner.id}:${weekStartIso.slice(0,10)}`;
    const result=await env.DB.prepare(`INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload) VALUES (?,?,'weekly_summary',?,?) ON CONFLICT(idempotency_key) DO NOTHING`)
      .bind(crypto.randomUUID(),idempotencyKey,partner.id,JSON.stringify({weekStart:weekStartIso,clicks:clicks?.n||0,proposals:proposals?.n||0,conversions:conversions?.n||0,commissionCents:commission?.n||0,currency:partner.currency})).run();
    if(result.meta.changes)created++;
  }
  return reply({partnersConsidered:partners.results.length,summariesCreated:created});
}
