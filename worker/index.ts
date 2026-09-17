import { timingSafeEqual } from 'node:crypto';

type Row = Record<string, unknown>;
type Auth = { userId: string; sessionId: string; email: string; name: string; roles: string[] };
type Entitlement = { tier: 'free'|'premium'|'master'; unlimited: boolean; activeTripLimit: number|null; archivedTripLimit: number|null; premiumFeatures: boolean };

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
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
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
  if (req.method === 'GET' && p === '/api/health') return reply({ ok: true, runtime: 'cloudflare-workers' });
  if (req.method === 'GET' && p === '/api/geo') return reply({ country: req.headers.get('cf-ipcountry') || 'PT' });
  if (req.method === 'POST' && p === '/api/lead') return lead(req, env);
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
  const tier = auth.roles.includes('master') ? 'master' : await env.DB.prepare("SELECT 1 FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=? AND s.status IN ('trialing','active') AND s.ends_at>CURRENT_TIMESTAMP AND p.code IN ('trial-10d','planner-30d') LIMIT 1").bind(auth.userId).first() ? 'premium' : 'free';
  const unlimited=tier!=='free';
  return {tier,unlimited,activeTripLimit:unlimited?null:1,archivedTripLimit:unlimited?null:2,premiumFeatures:unlimited};
}
async function canCreateActiveTrip(auth:Auth,env:Env,access?:Entitlement){const e=access||await entitlement(auth,env);if(e.unlimited)return true;const row=await env.DB.prepare('SELECT count(*) n FROM trips WHERE owner_user_id=? AND archived_at IS NULL').bind(auth.userId).first<{n:number}>();return Number(row?.n||0)<1;
}

async function sendEmail(env: Env, userId: string | null, to: string, template: string, subject: string, htmlBody: string) {
  const recipientHash = await digest(to, env); const id = crypto.randomUUID();
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html: htmlBody }) });
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
  const tripId=crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('UPDATE account_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=?').bind(token.id),
    env.DB.prepare("UPDATE users SET email_verified_at=CURRENT_TIMESTAMP,status='active',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(user.id),
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
async function adminOverview(req:Request,env:Env){if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);const u=await env.DB.prepare("SELECT count(*) n FROM users WHERE status<>'deleted'").first<{n:number}>();const a=await env.DB.prepare("SELECT count(*) n FROM users WHERE status='active'").first<{n:number}>();const p=await env.DB.prepare("SELECT count(*) n FROM payments WHERE status IN ('pending','processing')").first<{n:number}>();const paid=await env.DB.prepare("SELECT count(*) n FROM payments WHERE status='paid'").first<{n:number}>();return reply({users:u?.n||0,active_access:a?.n||0,pending_payments:p?.n||0,paid_payments:paid?.n||0});}
async function adminUsers(req:Request,env:Env){if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);const users=await env.DB.prepare('SELECT u.id,u.email,p.display_name,u.status,u.email_verified_at,u.created_at,u.last_login_at FROM users u JOIN profiles p ON p.user_id=u.id ORDER BY u.created_at DESC LIMIT 200').all<Row>();const roles=await env.DB.prepare('SELECT user_id,role FROM user_roles').all<Row>();return reply({users:users.results.map(u=>({...u,roles:roles.results.filter(r=>r.user_id===u.id).map(r=>r.role)}))});}
async function adminPlans(req:Request,env:Env){if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);return reply({plans:(await env.DB.prepare('SELECT * FROM plans ORDER BY price_cents').all()).results});}
async function adminPayments(req:Request,env:Env){if(!(await requireMaster(req,env)))return reply({error:'forbidden'},403);return reply({payments:(await env.DB.prepare('SELECT p.*,u.email,pl.code plan_code FROM payments p JOIN users u ON u.id=p.user_id LEFT JOIN plans pl ON pl.id=p.plan_id ORDER BY p.created_at DESC LIMIT 200').all()).results});}

async function lead(req:Request,env:Env){const b=await body(req);const kind=b?.kind==='planning'?'planning':b?.kind==='flight_quote'?'flight_quote':null;if(!kind)return reply({error:'invalid_lead'},400);if(!(await rateLimit(req,env,'lead',kind,10,3600)))return reply({error:'try_again_later'},429);await env.DB.prepare('INSERT INTO lead_requests(id,kind,origin,destination,outbound_on,return_on,passengers,trip_type,notes,ip_hash) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),kind,text(b?.origin,180),text(b?.destination,180),text(b?.outboundOn,20),text(b?.returnOn,20),text(b?.passengers,50),text(b?.tripType,50),text(b?.notes,2000),await sha(clientKey(req))).run();return reply({ok:true},201);}
async function audit(env:Env,actor:string|null,action:string,targetType:string,targetId:string){await env.DB.prepare('INSERT INTO audit_events(id,actor_user_id,action,target_type,target_id) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),actor,action,targetType,targetId).run();}

async function plannerGet(req:Request,env:Env,url:URL){const a=await getAuth(req,env);if(!a)return reply({error:'unauthorized'},401);const id=url.searchParams.get('tripId');const trip=id?await env.DB.prepare('SELECT id,name,destination,starts_on,ends_on,source,travelers,archived_at FROM trips WHERE id=? AND owner_user_id=?').bind(id,a.userId).first<Row>():await env.DB.prepare('SELECT id,name,destination,starts_on,ends_on,source,travelers,archived_at FROM trips WHERE owner_user_id=? ORDER BY (archived_at IS NOT NULL),updated_at DESC LIMIT 1').bind(a.userId).first<Row>();if(!trip)return reply({error:'trip_not_found'},404);const tripId=String(trip.id);const [it,places,expenses,budget,checklist,trips,access]=await Promise.all([env.DB.prepare('SELECT id,day_number day,starts_at time,title,kind,notes FROM itinerary_items WHERE owner_user_id=? AND trip_id=? ORDER BY day_number,sort_order,starts_at').bind(a.userId,tripId).all(),env.DB.prepare('SELECT id,name,category,address,notes,latitude,longitude FROM places WHERE owner_user_id=? AND trip_id=? ORDER BY created_at').bind(a.userId,tripId).all(),env.DB.prepare('SELECT id,category,description,amount_cents,currency,spent_on FROM expenses WHERE owner_user_id=? AND trip_id=? ORDER BY created_at DESC').bind(a.userId,tripId).all(),env.DB.prepare('SELECT amount_cents,currency FROM budgets WHERE owner_user_id=? AND trip_id=?').bind(a.userId,tripId).first(),env.DB.prepare('SELECT id,text,completed,sort_order FROM checklist_items WHERE owner_user_id=? AND trip_id=? ORDER BY sort_order,created_at').bind(a.userId,tripId).all(),env.DB.prepare('SELECT id,name,destination,starts_on,ends_on,travelers,archived_at,updated_at FROM trips WHERE owner_user_id=? ORDER BY (archived_at IS NOT NULL),updated_at DESC').bind(a.userId).all(),entitlement(a,env)]);return reply({trip,trips:trips.results,entitlement:access,itinerary:it.results,places:places.results,expenses:expenses.results,budget:budget||{amount_cents:0,currency:'EUR'},checklist:checklist.results.map((x:Row)=>({...x,completed:Boolean(x.completed)}))});}
async function plannerTrip(req:Request,env:Env){const a=await mutationAuth(req,env);if(!a)return reply({error:'unauthorized'},401);const access=await entitlement(a,env);if(!(await canCreateActiveTrip(a,env,access)))return reply({error:'free_active_trip_limit',upgrade_required:true},403);const b=await body(req);const name=text(b?.name,120,1);if(!name)return reply({error:'invalid_trip'},400);const id=crypto.randomUUID();const travelers=Number.isInteger(b?.travelers)?Number(b?.travelers):1;await env.DB.batch([env.DB.prepare('INSERT INTO trips(id,owner_user_id,name,destination,starts_on,ends_on,travelers) VALUES(?,?,?,?,?,?,?)').bind(id,a.userId,name,text(b?.destination,180),text(b?.startsOn,10),text(b?.endsOn,10),travelers),env.DB.prepare("INSERT INTO budgets(trip_id,owner_user_id,amount_cents,currency) VALUES(?,?,0,'EUR')").bind(id,a.userId)]);return reply({id},201);}
async function plannerTripAction(req:Request,env:Env,tripId:string,action:string){const a=await mutationAuth(req,env);if(!a)return reply({error:'unauthorized'},401);const trip=await env.DB.prepare('SELECT id,archived_at FROM trips WHERE id=? AND owner_user_id=?').bind(tripId,a.userId).first<Row>();if(!trip)return reply({error:'trip_not_found'},404);const access=await entitlement(a,env);if(action==='archive'){if(trip.archived_at)return reply({ok:true});if(!access.unlimited){const count=await env.DB.prepare('SELECT count(*) n FROM trips WHERE owner_user_id=? AND archived_at IS NOT NULL').bind(a.userId).first<{n:number}>();if(Number(count?.n||0)>=2)return reply({error:'free_archived_trip_limit',upgrade_required:true},403);}await env.DB.prepare('UPDATE trips SET archived_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_user_id=?').bind(tripId,a.userId).run();await audit(env,a.userId,'planner.trip_archived','trip',tripId);return reply({ok:true});}if(action==='restore'){if(!trip.archived_at)return reply({ok:true});if(!(await canCreateActiveTrip(a,env,access)))return reply({error:'free_active_trip_limit',upgrade_required:true},403);await env.DB.prepare('UPDATE trips SET archived_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_user_id=?').bind(tripId,a.userId).run();await audit(env,a.userId,'planner.trip_restored','trip',tripId);return reply({ok:true});}return reply({error:'not_found'},404);}
async function ownedTrip(env:Env,userId:string,tripId:string){return await env.DB.prepare('SELECT archived_at FROM trips WHERE id=? AND owner_user_id=?').bind(tripId,userId).first<Row>();}
async function plannerItem(req:Request,env:Env,tripId:string,kind:string,itemId?:string){const a=await mutationAuth(req,env);if(!a)return reply({error:'unauthorized'},401);const trip=await ownedTrip(env,a.userId,tripId);if(!trip)return reply({error:'trip_not_found'},404);if(trip.archived_at)return reply({error:'trip_archived'},409);const b=await body(req);
  if(req.method==='DELETE'&&itemId){const table=kind==='itinerary'?'itinerary_items':kind==='places'?'places':kind==='expenses'?'expenses':kind==='checklist'?'checklist_items':null;if(!table)return reply({error:'invalid_item'},400);const r=await env.DB.prepare(`DELETE FROM ${table} WHERE id=? AND trip_id=? AND owner_user_id=?`).bind(itemId,tripId,a.userId).run();return r.meta.changes?reply({ok:true}):reply({error:'item_not_found'},404);}
  if(kind==='budget'&&req.method==='PUT'){const amount=Number(b?.amount);if(!Number.isFinite(amount)||amount<0)return reply({error:'invalid_budget'},400);await env.DB.prepare('UPDATE budgets SET amount_cents=?,updated_at=CURRENT_TIMESTAMP WHERE trip_id=? AND owner_user_id=?').bind(Math.round(amount*100),tripId,a.userId).run();return reply({ok:true});}
  if(kind==='checklist'&&req.method==='PATCH'&&itemId){if(typeof b?.completed!=='boolean')return reply({error:'invalid_checklist_item'},400);const r=await env.DB.prepare('UPDATE checklist_items SET completed=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND trip_id=? AND owner_user_id=?').bind(b.completed?1:0,itemId,tripId,a.userId).run();return r.meta.changes?reply({ok:true}):reply({error:'item_not_found'},404);}
  const id=crypto.randomUUID();
  if(kind==='itinerary'&&req.method==='POST'){const day=Number(b?.day),title=text(b?.title,240,1),itemKind=text(b?.kind,60,1);if(!Number.isInteger(day)||day<1||!title||!itemKind)return reply({error:'invalid_itinerary_item'},400);await env.DB.prepare('INSERT INTO itinerary_items(id,trip_id,owner_user_id,day_number,starts_at,title,kind,notes) VALUES(?,?,?,?,?,?,?,?)').bind(id,tripId,a.userId,day,text(b?.time,5),title,itemKind,text(b?.notes,2000)).run();return reply({id},201);}
  if(kind==='places'&&req.method==='POST'){const name=text(b?.name,240,1),category=text(b?.category,60,1);if(!name||!category)return reply({error:'invalid_place'},400);await env.DB.prepare('INSERT INTO places(id,trip_id,owner_user_id,name,category,address,notes) VALUES(?,?,?,?,?,?,?)').bind(id,tripId,a.userId,name,category,text(b?.address,500),text(b?.notes,2000)).run();return reply({id},201);}
  if(kind==='expenses'&&req.method==='POST'){const amount=Number(b?.amount),category=text(b?.category,60,1),description=text(b?.description,500,1);if(!Number.isFinite(amount)||amount<=0||!category||!description)return reply({error:'invalid_expense'},400);await env.DB.prepare("INSERT INTO expenses(id,trip_id,owner_user_id,category,description,amount_cents,currency) VALUES(?,?,?,?,?,?,'EUR')").bind(id,tripId,a.userId,category,description,Math.round(amount*100)).run();return reply({id},201);}
  if(kind==='checklist'&&req.method==='POST'){const itemText=text(b?.text,300,1);if(!itemText)return reply({error:'invalid_checklist_item'},400);await env.DB.prepare('INSERT INTO checklist_items(id,trip_id,owner_user_id,text,sort_order) VALUES(?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM checklist_items WHERE trip_id=? AND owner_user_id=?))').bind(id,tripId,a.userId,itemText,tripId,a.userId).run();return reply({id},201);}return reply({error:'not_found'},404);
}
async function plannerImport(req:Request,env:Env){const a=await mutationAuth(req,env);if(!a)return reply({error:'unauthorized'},401);if(!(await canCreateActiveTrip(a,env)))return reply({error:'free_active_trip_limit',upgrade_required:true},403);const b=await body(req);if(!b||!Array.isArray(b.itinerary)||!Array.isArray(b.places)||!Array.isArray(b.expenses)||!Array.isArray(b.checklist))return reply({error:'invalid_import'},400);const id=crypto.randomUUID();await env.DB.batch([env.DB.prepare("INSERT INTO trips(id,owner_user_id,name,source) VALUES(?,?,'Viagem importada do navegador','local_import')").bind(id,a.userId),env.DB.prepare("INSERT INTO budgets(trip_id,owner_user_id,amount_cents,currency) VALUES(?,?,?,'EUR')").bind(id,a.userId,Math.round(Number(b.budget||0)*100))]);const stmts:D1PreparedStatement[]=[];for(const x of b.itinerary.slice(0,1000) as Row[]){const title=text(x.what,240,1);if(title)stmts.push(env.DB.prepare('INSERT INTO itinerary_items(id,trip_id,owner_user_id,day_number,starts_at,title,kind,notes) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,a.userId,Math.max(1,Number(x.day)||1),text(x.time,5),title,text(x.type,60)||'Atividade',text(x.notes,2000)));}for(const x of b.places.slice(0,1000) as Row[]){const name=text(x.name,240,1);if(name)stmts.push(env.DB.prepare('INSERT INTO places(id,trip_id,owner_user_id,name,category,address,notes) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),id,a.userId,name,text(x.type,60)||'Outro',text(x.address,500),text(x.notes,2000)));}for(const x of b.expenses.slice(0,1000) as Row[]){const amount=Number(x.value),description=text(x.desc,500,1);if(amount>0&&description)stmts.push(env.DB.prepare("INSERT INTO expenses(id,trip_id,owner_user_id,category,description,amount_cents,currency) VALUES(?,?,?,?,?,?,'EUR')").bind(crypto.randomUUID(),id,a.userId,text(x.type,60)||'Outros',description,Math.round(amount*100)));}for(const [i,x] of (b.checklist.slice(0,1000) as Row[]).entries()){const t=text(x.text,300,1);if(t)stmts.push(env.DB.prepare('INSERT INTO checklist_items(id,trip_id,owner_user_id,text,completed,sort_order) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),id,a.userId,t,x.done?1:0,i));}for(let i=0;i<stmts.length;i+=100)await env.DB.batch(stmts.slice(i,i+100));return reply({id},201);}
