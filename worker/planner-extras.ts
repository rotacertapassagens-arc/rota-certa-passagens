// Planner, recursos extras:
// - câmbio para mostrar custos em € e R$ (GET /api/planner/rates, taxas do Banco Central Europeu);
// - configurações da viagem: datas, viajantes para dividir custos (PATCH /api/planner/trips/<id>);
// - link de leitura da viagem (POST/DELETE /api/planner/trips/<id>/share e a página /viagem/<token>);
// - voo emitido pela Rota Certa entrando sozinho no roteiro (POST /api/admin/leads/<id>/planner-flight);
// - lembrete de check-in por e-mail, pela tarefa agendada (checkinReminders).
type Row = Record<string, unknown>;
export interface ExtrasAuth { userId: string; email: string; name: string; roles: string[] }
export interface ExtrasDeps {
  reply(body: unknown, status?: number): Response;
  getAuth(req: Request, env: Env): Promise<ExtrasAuth | null>;
  mutationAuth(req: Request, env: Env): Promise<ExtrasAuth | null>;
  requirePlannerAccess(auth: ExtrasAuth, env: Env): Promise<unknown>;
  sendEmail(env: Env, userId: string | null, to: string, template: string, subject: string, htmlBody: string, textBody?: string, idempotencyKey?: string): Promise<unknown>;
  audit(env: Env, actor: string | null, action: string, targetType: string, targetId: string | null): Promise<void>;
}

export const CURRENCIES = ['EUR', 'BRL', 'USD', 'GBP'] as const;
const FIXED_RATES = { EUR: 1, BRL: 6.2, USD: 1.08, GBP: 0.85 };

const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]!);
const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const dateOk = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null);
const timeOk = (value: unknown) => (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null);
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const fmtDate = (iso: string) => new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
function shareToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function readJson(req: Request): Promise<Row | null> { try { return await req.json() as Row; } catch { return null; } }

/** Rotas da API tratadas aqui; devolve null para o roteador seguir adiante. */
export async function plannerExtras(req: Request, env: Env, url: URL, deps: ExtrasDeps): Promise<Response | null> {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/planner/rates') return rates(env, deps);
  const trip = p.match(/^\/api\/planner\/trips\/([0-9a-f-]+)$/i);
  if (trip && req.method === 'PATCH') return tripSettings(req, env, trip[1]!, deps);
  const share = p.match(/^\/api\/planner\/trips\/([0-9a-f-]+)\/share$/i);
  if (share && (req.method === 'POST' || req.method === 'DELETE')) return tripShare(req, env, share[1]!, deps);
  if (p === '/api/admin/subscriptions/grant' && req.method === 'POST') return grantPremium(req, env, deps);
  const flight = p.match(/^\/api\/admin\/leads\/([0-9a-f-]+)\/planner-flight$/i);
  if (flight && req.method === 'POST') return leadFlightToPlanner(req, env, flight[1]!, deps);
  return null;
}

// --- câmbio ----------------------------------------------------------------------------------
async function rates(env: Env, deps: ExtrasDeps) {
  if ((env as unknown as { RATES_MODE?: string }).RATES_MODE === 'fixed') return deps.reply({ base: 'EUR', date: 'fixo', rates: FIXED_RATES });
  const key = new Request('https://cache.rotacertapassagens.com/rates/eur');
  const cache = (caches as unknown as { default: Cache }).default;
  const cached = await cache.match(key);
  if (cached) return deps.reply(await cached.json());
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=BRL,USD,GBP', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json() as { date?: string; rates?: Record<string, number> };
    const r = j.rates || {};
    if (!(r.BRL > 0 && r.USD > 0 && r.GBP > 0)) throw new Error('rates_invalid');
    const body = { base: 'EUR', date: j.date || null, rates: { EUR: 1, BRL: r.BRL, USD: r.USD, GBP: r.GBP } };
    await cache.put(key, new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=21600' } }));
    return deps.reply(body);
  } catch {
    return deps.reply({ error: 'rates_unavailable' }, 503);
  }
}

// --- configurações e compartilhamento da viagem ---------------------------------------------------
async function ownTrip(env: Env, userId: string, tripId: string) {
  return env.DB.prepare('SELECT id,archived_at,share_token FROM trips WHERE id=? AND owner_user_id=?').bind(tripId, userId).first<Row>();
}
async function tripSettings(req: Request, env: Env, tripId: string, deps: ExtrasDeps) {
  const a = await deps.mutationAuth(req, env); if (!a) return deps.reply({ error: 'unauthorized' }, 401);
  if (!(await deps.requirePlannerAccess(a, env))) return deps.reply({ error: 'free_trial_expired', upgrade_required: true }, 402);
  const trip = await ownTrip(env, a.userId, tripId); if (!trip) return deps.reply({ error: 'trip_not_found' }, 404);
  if (trip.archived_at) return deps.reply({ error: 'trip_archived' }, 409);
  const b = await readJson(req); if (!b) return deps.reply({ error: 'invalid_trip' }, 400);
  const sets: string[] = []; const vals: unknown[] = [];
  if (b.name !== undefined) { const name = clean(b.name, 120); if (!name) return deps.reply({ error: 'invalid_trip' }, 400); sets.push('name=?'); vals.push(name); }
  for (const [key, column] of [['startsOn', 'starts_on'], ['endsOn', 'ends_on']] as const) {
    if (b[key] === undefined) continue;
    if (b[key] === null || b[key] === '') { sets.push(`${column}=NULL`); continue; }
    const d = dateOk(b[key]); if (!d) return deps.reply({ error: 'invalid_trip_date' }, 400);
    sets.push(`${column}=?`); vals.push(d);
  }
  if (b.companions !== undefined) {
    if (!Array.isArray(b.companions) || b.companions.length > 12) return deps.reply({ error: 'invalid_companions' }, 400);
    const names = [...new Set(b.companions.map((n) => clean(n, 40)).filter((n) => n && n.toLowerCase() !== 'você'))];
    sets.push('companions=?', 'travelers=?'); vals.push(names.length ? JSON.stringify(names) : null, names.length + 1);
  }
  if (!sets.length) return deps.reply({ error: 'invalid_trip' }, 400);
  await env.DB.prepare(`UPDATE trips SET ${sets.join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_user_id=?`).bind(...vals, tripId, a.userId).run();
  return deps.reply({ ok: true });
}
async function tripShare(req: Request, env: Env, tripId: string, deps: ExtrasDeps) {
  const a = await deps.mutationAuth(req, env); if (!a) return deps.reply({ error: 'unauthorized' }, 401);
  const trip = await ownTrip(env, a.userId, tripId); if (!trip) return deps.reply({ error: 'trip_not_found' }, 404);
  if (req.method === 'DELETE') {
    await env.DB.prepare('UPDATE trips SET share_token=NULL WHERE id=? AND owner_user_id=?').bind(tripId, a.userId).run();
    await deps.audit(env, a.userId, 'planner.trip_share_revoked', 'trip', tripId);
    return deps.reply({ ok: true });
  }
  if (!(await deps.requirePlannerAccess(a, env))) return deps.reply({ error: 'free_trial_expired', upgrade_required: true }, 402);
  const token = trip.share_token ? String(trip.share_token) : shareToken();
  if (!trip.share_token) await env.DB.prepare('UPDATE trips SET share_token=? WHERE id=? AND owner_user_id=?').bind(token, tripId, a.userId).run();
  await deps.audit(env, a.userId, 'planner.trip_shared', 'trip', tripId);
  return deps.reply({ ok: true, token, url: `${env.APP_ORIGIN}/viagem/${token}` });
}

/** Página pública (só leitura) da viagem compartilhada. Não mostra reservas, anexos nem custos. */
export async function sharedTripPage(req: Request, env: Env, url: URL): Promise<Response | null> {
  const m = url.pathname.match(/^\/viagem\/([A-Za-z0-9_-]{20,64})\/?$/);
  if (!m || req.method !== 'GET') return null;
  const trip = await env.DB.prepare('SELECT t.id,t.name,t.starts_on,t.ends_on,t.owner_user_id,pr.display_name owner_name FROM trips t LEFT JOIN profiles pr ON pr.user_id=t.owner_user_id WHERE t.share_token=?').bind(m[1]).first<Row>();
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
  if (!trip) return new Response(page('Link indisponível', '<section class="empty"><h2>Este link não está mais disponível</h2><p>Quem compartilhou a viagem pode ter desligado o link.</p></section>'), { status: 404, headers });
  const [items, places] = await Promise.all([
    env.DB.prepare('SELECT day_number,starts_at,title,kind FROM itinerary_items WHERE trip_id=? AND owner_user_id=? ORDER BY day_number,sort_order,starts_at').bind(trip.id, trip.owner_user_id).all<Row>(),
    env.DB.prepare('SELECT name,category,address FROM places WHERE trip_id=? AND owner_user_id=? ORDER BY created_at').bind(trip.id, trip.owner_user_id).all<Row>(),
  ]);
  const start = trip.starts_on ? String(trip.starts_on) : null;
  const days = [...new Set(items.results.map((i) => Number(i.day_number) || 1))].sort((x, y) => x - y);
  const firstName = String(trip.owner_name || '').trim().split(/\s+/)[0] || 'Um viajante';
  const roteiro = days.map((d) => `<section class="day"><div class="day-head"><b>Dia ${d}</b>${start ? `<span>${esc(fmtDate(addDays(start, d - 1)))}</span>` : ''}</div><ol>${items.results.filter((i) => (Number(i.day_number) || 1) === d).map((i) => `<li><time>${esc(i.starts_at || '')}</time><div><strong>${esc(i.title)}</strong><small>${esc(i.kind)}</small></div></li>`).join('')}</ol></section>`).join('') || '<p class="muted">O roteiro ainda está vazio.</p>';
  const lugares = places.results.length ? `<h2>Lugares</h2><ul class="places">${places.results.map((pl) => `<li><div><strong>${esc(pl.name)}</strong><small>${esc(pl.category)}${pl.address ? ` · ${esc(pl.address)}` : ''}</small></div><a href="https://www.google.com/maps/dir/?api=1&amp;destination=${encodeURIComponent([pl.name, pl.address].filter(Boolean).join(', '))}" target="_blank" rel="noopener">Como chegar</a></li>`).join('')}</ul>` : '';
  const datas = start ? `${esc(fmtDate(start))}${trip.ends_on ? ` a ${esc(fmtDate(String(trip.ends_on)))}` : ''}` : '';
  const body = `<header class="band"><div class="wrap"><a class="brand" href="/"><img src="/assets/logo-simbolo-claro.png" alt="" width="36" height="36">Rota Certa <span>Passagens</span></a><p class="eyebrow">Viagem compartilhada por ${esc(firstName)}</p><h1>${esc(trip.name)}</h1>${datas ? `<p class="dates">${datas}</p>` : ''}</div></header>
<main class="wrap"><h2>Roteiro</h2>${roteiro}${lugares}<aside class="cta"><strong>Planeje a sua viagem assim também</strong><p>Roteiro, reservas, bilhetes e orçamento no celular, até sem internet.</p><a href="/app">Conhecer o app Rota Certa</a></aside></main>`;
  return new Response(page(`${String(trip.name)} | Rota Certa`, body), { headers });
}
function page(title: string, body: string) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><link rel="icon" href="/assets/favicon.png"><link rel="preload" href="/assets/fonts/montserrat-300-700-latin.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/assets/fonts/fontes.css"><style>
*{box-sizing:border-box;margin:0}body{font-family:Montserrat,Arial,sans-serif;color:#0d1b2a;background:#e8ecf1;line-height:1.5}a{color:inherit}.wrap{width:min(860px,calc(100% - 32px));margin:0 auto}
.band{position:relative;isolation:isolate;background:#0d1b2a url(/assets/planner/itinerario.jpg) center/cover;color:#fff;padding:22px 0 40px;border-bottom:3px solid #d4af37}.band::before{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(90deg,rgba(13,27,42,.95),rgba(13,27,42,.6))}
.brand{display:flex;align-items:center;gap:10px;font:700 1.2rem "Playfair Display",Georgia,serif;text-decoration:none;margin-bottom:28px}.brand span{color:#d4af37}.eyebrow{color:#d4af37;font-size:.78rem;font-weight:700;letter-spacing:.18em;text-transform:uppercase}
h1{font:700 clamp(2rem,5vw,3rem)/1.1 "Playfair Display",Georgia,serif;margin:8px 0}.dates{color:rgba(244,244,244,.85)}main{padding:34px 0 60px}h2{font:700 1.5rem "Playfair Display",Georgia,serif;margin:10px 0 14px}
.day{background:#fff;border:1px solid rgba(13,27,42,.1);border-radius:14px;overflow:hidden;margin-bottom:14px}.day-head{display:flex;justify-content:space-between;background:#0d1b2a;color:#fff;padding:10px 18px}.day-head b{color:#d4af37;font-family:"Playfair Display",Georgia,serif}.day-head span{font-size:.85rem;color:rgba(244,244,244,.8)}
.day ol{list-style:none;padding:6px 18px}.day li{display:grid;grid-template-columns:56px 1fr;gap:12px;padding:10px 0;border-top:1px solid #eef1f4}.day li:first-child{border-top:0}time{font-weight:700}small{display:block;color:#5d6978;font-size:.8rem}
.places{list-style:none;padding:0;display:grid;gap:10px}.places li{display:flex;justify-content:space-between;gap:12px;align-items:center;background:#fff;border:1px solid rgba(13,27,42,.1);border-radius:12px;padding:12px 16px}.places a{color:#1b4965;font-weight:700;font-size:.85rem;white-space:nowrap}
.cta{margin-top:30px;background:#0d1b2a;color:#fff;border-radius:14px;padding:22px}.cta p{color:rgba(244,244,244,.8);margin:6px 0 14px}.cta a{display:inline-block;background:#d4af37;color:#0d1b2a;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:8px}
.muted{color:#5d6978}.empty{padding:80px 16px;text-align:center}</style></head><body>${body}</body></html>`;
}

// --- voo emitido pela Rota Certa -> roteiro do cliente ------------------------------------------------
interface FlightPayload { origin: string; destination: string; outboundDate: string; outboundTime: string | null; flightOut: string; returnDate: string | null; returnTime: string | null; flightBack: string; bookingCode: string; notes: string }
function parseFlight(b: Row | null, lead: Row): FlightPayload | null {
  if (!b) return null;
  const outboundDate = dateOk(b.outboundDate); if (!outboundDate) return null;
  const returnDate = b.returnDate ? dateOk(b.returnDate) : null;
  if (b.returnDate && (!returnDate || returnDate < outboundDate)) return null;
  if ((b.outboundTime && !timeOk(b.outboundTime)) || (b.returnTime && !timeOk(b.returnTime))) return null;
  return {
    origin: clean(lead.origin, 80), destination: clean(lead.destination, 80), outboundDate, outboundTime: timeOk(b.outboundTime), flightOut: clean(b.flightOut, 40),
    returnDate, returnTime: timeOk(b.returnTime), flightBack: clean(b.flightBack, 40), bookingCode: clean(b.bookingCode, 80), notes: clean(b.notes, 500),
  };
}
async function applyFlight(env: Env, userId: string, f: FlightPayload) {
  const tripId = crypto.randomUUID();
  const name = `Viagem para ${f.destination}`.slice(0, 120);
  const stmts = [
    env.DB.prepare("INSERT INTO trips(id,owner_user_id,name,destination,starts_on,ends_on,source) VALUES(?,?,?,?,?,?,'rota_certa')").bind(tripId, userId, name, f.destination, f.outboundDate, f.returnDate),
    env.DB.prepare("INSERT INTO budgets(trip_id,owner_user_id,amount_cents,currency) VALUES(?,?,0,'EUR')").bind(tripId, userId),
    env.DB.prepare("INSERT INTO itinerary_items(id,trip_id,owner_user_id,day_number,starts_at,title,kind,notes,booking_code,source) VALUES(?,?,?,?,?,?,'Voo',?,?,'rota_certa')")
      .bind(crypto.randomUUID(), tripId, userId, 1, f.outboundTime, `Voo ${f.origin} para ${f.destination}${f.flightOut ? ` · ${f.flightOut}` : ''}`.slice(0, 240), f.notes || null, f.bookingCode || null),
  ];
  if (f.returnDate) stmts.push(env.DB.prepare("INSERT INTO itinerary_items(id,trip_id,owner_user_id,day_number,starts_at,title,kind,notes,booking_code,source) VALUES(?,?,?,?,?,?,'Voo',?,?,'rota_certa')")
    .bind(crypto.randomUUID(), tripId, userId, daysBetween(f.outboundDate, f.returnDate) + 1, f.returnTime, `Voo ${f.destination} para ${f.origin}${f.flightBack ? ` · ${f.flightBack}` : ''}`.slice(0, 240), f.notes || null, f.bookingCode || null));
  const until = addDays(f.returnDate || f.outboundDate, 7);
  stmts.push(env.DB.prepare("INSERT INTO subscriptions(id,user_id,plan_id,status,starts_at,ends_at,provider,provider_reference) SELECT ?,?,id,'active',CURRENT_TIMESTAMP,?,'rota_certa','voo emitido' FROM plans WHERE code='cliente-rota-certa'")
    .bind(crypto.randomUUID(), userId, `${until} 23:59:59`));
  await env.DB.batch(stmts);
  return tripId;
}
async function leadFlightToPlanner(req: Request, env: Env, leadId: string, deps: ExtrasDeps) {
  const a = await deps.mutationAuth(req, env); if (!a) return deps.reply({ error: 'unauthorized' }, 401);
  if (!a.roles.includes('master')) return deps.reply({ error: 'forbidden' }, 403);
  const lead = await env.DB.prepare('SELECT id,customer_email,customer_name,origin,destination FROM lead_requests WHERE id=?').bind(leadId).first<Row>();
  if (!lead) return deps.reply({ error: 'lead_not_found' }, 404);
  const f = parseFlight(await readJson(req), lead); if (!f) return deps.reply({ error: 'invalid_flight' }, 400);
  const email = String(lead.customer_email).toLowerCase();
  const user = await env.DB.prepare('SELECT id FROM users WHERE lower(email)=? AND email_verified_at IS NOT NULL').bind(email).first<Row>();
  const first = esc(String(lead.customer_name || '').trim().split(/\s+/)[0] || '');
  const rota = `${esc(f.origin)} para ${esc(f.destination)}`;
  if (user) {
    const tripId = await applyFlight(env, String(user.id), f);
    await deps.audit(env, a.userId, 'planner.flight_sent', 'trip', tripId);
    await deps.sendEmail(env, String(user.id), email, 'planner_flight_added', 'Seu voo já está no seu Planner',
      `<p>Olá${first ? `, ${first}` : ''}.</p><p>O seu voo <strong>${rota}</strong> já está no roteiro do seu Planner, com as datas e o código da reserva.</p><p>Como cliente Rota Certa, o Planner fica liberado para você até a sua volta: é você quem organiza o roteiro, os lugares e os gastos. Se preferir que a nossa equipe monte tudo, conheça o plano Personalizado.</p><p>Anexe o cartão de embarque quando fizer o check-in: ele abre até sem internet.</p><p><a href="${env.APP_ORIGIN}/#/planner/itinerario">Abrir o meu roteiro</a></p><p>Rota Certa Passagens</p>`,
      `O seu voo ${f.origin} para ${f.destination} já está no seu Planner: ${env.APP_ORIGIN}/#/planner/itinerario`, `planner-flight-${tripId}`);
    return deps.reply({ ok: true, applied: true, tripId });
  }
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO planner_flight_imports(id,email,lead_id,payload,created_by) VALUES(?,?,?,?,?)').bind(id, email, leadId, JSON.stringify(f), a.userId).run();
  await deps.audit(env, a.userId, 'planner.flight_pending', 'lead', leadId);
  await deps.sendEmail(env, null, email, 'planner_flight_pending', 'Seu voo está pronto para o Planner da Rota Certa',
    `<p>Olá${first ? `, ${first}` : ''}.</p><p>O seu voo <strong>${rota}</strong> está pronto para entrar no seu roteiro.</p><p>Crie a sua conta grátis com este e-mail e ele aparece sozinho no Planner, com as datas e o código da reserva.</p><p><a href="${env.APP_ORIGIN}/#/cliente?plan=gratis">Criar minha conta</a></p><p>Rota Certa Passagens</p>`,
    `Crie a sua conta grátis com este e-mail e o voo ${f.origin} para ${f.destination} aparece no Planner: ${env.APP_ORIGIN}/#/cliente?plan=gratis`, `planner-flight-pending-${id}`);
  return deps.reply({ ok: true, applied: false });
}
/** Chamado quando a pessoa abre o Planner: aplica voos lançados antes de ela ter conta. */
export async function applyPendingFlights(env: Env, userId: string, email: string) {
  const pending = await env.DB.prepare('SELECT id,payload FROM planner_flight_imports WHERE email=? AND applied_at IS NULL LIMIT 5').bind(email.toLowerCase()).all<Row>();
  for (const row of pending.results) {
    try {
      const tripId = await applyFlight(env, userId, JSON.parse(String(row.payload)) as FlightPayload);
      await env.DB.prepare('UPDATE planner_flight_imports SET applied_at=CURRENT_TIMESTAMP,applied_trip_id=? WHERE id=? AND applied_at IS NULL').bind(tripId, row.id).run();
    } catch { /* um lançamento com defeito não impede o Planner de abrir */ }
  }
}

// --- lembrete de check-in ----------------------------------------------------------------------
/** Tarefa agendada (de hora em hora): avisa por e-mail entre 2 e 28 horas antes de cada voo com data. */
export async function checkinReminders(env: Env, deps: ExtrasDeps, now = Date.now()) {
  const rows = await env.DB.prepare(`SELECT i.id,i.title,i.starts_at,i.day_number,i.booking_code,t.starts_on,u.id user_id,u.email,pr.display_name name
    FROM itinerary_items i JOIN trips t ON t.id=i.trip_id JOIN users u ON u.id=i.owner_user_id LEFT JOIN profiles pr ON pr.user_id=u.id
    WHERE i.kind='Voo' AND i.reminder_sent_at IS NULL AND t.starts_on IS NOT NULL AND t.archived_at IS NULL AND u.email_verified_at IS NOT NULL
      AND date(t.starts_on,'+'||(i.day_number-1)||' days') BETWEEN date(?,'unixepoch') AND date(?,'unixepoch','+2 days') LIMIT 200`)
    .bind(Math.floor(now / 1000), Math.floor(now / 1000)).all<Row>();
  let sent = 0;
  for (const r of rows.results) {
    const day = addDays(String(r.starts_on), (Number(r.day_number) || 1) - 1);
    const time = timeOk(r.starts_at) || '12:00';
    // Horário do voo tratado como UTC: a janela larga (2 a 28 h) absorve a diferença de fuso.
    const hours = (Date.parse(`${day}T${time}:00Z`) - now) / 3600000;
    if (hours < 2 || hours > 28) continue;
    const claim = await env.DB.prepare('UPDATE itinerary_items SET reminder_sent_at=CURRENT_TIMESTAMP WHERE id=? AND reminder_sent_at IS NULL').bind(r.id).run();
    if (!claim.meta.changes) continue;
    const first = esc(String(r.name || '').trim().split(/\s+/)[0] || '');
    await deps.sendEmail(env, String(r.user_id), String(r.email), 'checkin_reminder', 'Seu voo está chegando: faça o check-in online',
      `<p>Olá${first ? `, ${first}` : ''}.</p><p>O seu voo <strong>${esc(r.title)}</strong> está marcado para <strong>${esc(fmtDate(day))} às ${esc(time)}</strong>.</p><p>O check-in online costuma abrir de 24 a 48 horas antes. Faça pelo site ou app da companhia aérea e anexe o cartão de embarque no seu Planner: ele abre até sem internet.</p>${r.booking_code ? `<p>Código da reserva: <strong>${esc(r.booking_code)}</strong></p>` : ''}<p><a href="${env.APP_ORIGIN}/#/planner/itinerario">Abrir o meu roteiro</a></p><p>Boa viagem!<br>Rota Certa Passagens</p>`,
      `O seu voo ${String(r.title)} é ${fmtDate(day)} às ${time}. Faça o check-in online e anexe o cartão de embarque no Planner: ${env.APP_ORIGIN}/#/planner/itinerario`, `checkin-${String(r.id)}`)
      .catch(() => undefined);
    sent += 1;
  }
  return sent;
}

// --- Premium liberado pela equipe (pagamento combinado no WhatsApp, enquanto a Stripe não entra) --------
async function grantPremium(req: Request, env: Env, deps: ExtrasDeps) {
  const a = await deps.mutationAuth(req, env); if (!a) return deps.reply({ error: 'unauthorized' }, 401);
  if (!a.roles.includes('master')) return deps.reply({ error: 'forbidden' }, 403);
  const b = await readJson(req);
  const email = clean(b?.email, 254).toLowerCase();
  const days = Number(b?.days ?? 30);
  if (!email || !Number.isInteger(days) || days < 1 || days > 366) return deps.reply({ error: 'invalid_grant' }, 400);
  const user = await env.DB.prepare('SELECT u.id,pr.display_name name FROM users u LEFT JOIN profiles pr ON pr.user_id=u.id WHERE lower(u.email)=? AND u.email_verified_at IS NOT NULL').bind(email).first<Row>();
  if (!user) return deps.reply({ error: 'user_not_found' }, 404);
  // Soma ao Premium que ainda estiver valendo, para quem renova antes de acabar.
  const current = await env.DB.prepare("SELECT MAX(s.ends_at) ends_at FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=? AND p.code='planner-30d' AND s.status='active' AND s.ends_at>CURRENT_TIMESTAMP").bind(user.id).first<Row>();
  const base = current?.ends_at ? Date.parse(String(current.ends_at).replace(' ', 'T') + 'Z') : Date.now();
  const ends = new Date(base + days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  await env.DB.prepare("INSERT INTO subscriptions(id,user_id,plan_id,status,starts_at,ends_at,provider,provider_reference) SELECT ?,?,id,'active',CURRENT_TIMESTAMP,?,'manual',? FROM plans WHERE code='planner-30d'")
    .bind(crypto.randomUUID(), user.id, ends, `painel:${a.userId}`).run();
  await deps.audit(env, a.userId, 'subscription.premium_granted', 'user', String(user.id));
  const first = esc(String(user.name || '').trim().split(/\s+/)[0] || '');
  const ate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(ends.replace(' ', 'T') + 'Z'));
  await deps.sendEmail(env, String(user.id), email, 'premium_granted', 'Seu Premium do Planner está ativo',
    `<p>Olá${first ? `, ${first}` : ''}.</p><p>O seu <strong>Premium do Planner</strong> está ativo até <strong>${ate}</strong>: viagens ilimitadas, bilhetes anexados, divisão de custos e tudo no celular, até sem internet.</p><p><a href="${env.APP_ORIGIN}/#/planner">Abrir o Planner</a></p><p>Boa viagem!<br>Rota Certa Passagens</p>`,
    `O seu Premium do Planner está ativo até ${ate}: ${env.APP_ORIGIN}/#/planner`).catch(() => undefined);
  return deps.reply({ ok: true, endsAt: ends });
}

// --- reativação: 7 dias antes da viagem, para quem está sem acesso ao Planner --------------------------
export async function reactivationReminders(env: Env, deps: ExtrasDeps, now = Date.now()) {
  const inSeven = new Date(now + 7 * 86400000).toISOString().slice(0, 10);
  const rows = await env.DB.prepare(`SELECT t.id,t.name,t.starts_on,u.id user_id,u.email,pr.display_name name FROM trips t JOIN users u ON u.id=t.owner_user_id LEFT JOIN profiles pr ON pr.user_id=u.id
    WHERE t.starts_on=? AND t.reactivation_sent_at IS NULL AND t.archived_at IS NULL AND u.email_verified_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role='master')
      AND NOT EXISTS (SELECT 1 FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=u.id AND s.status IN ('trialing','active') AND s.ends_at>CURRENT_TIMESTAMP AND p.code IN ('trial-10d','planner-30d','cliente-rota-certa'))
    LIMIT 200`).bind(inSeven).all<Row>();
  let sent = 0;
  for (const r of rows.results) {
    const claim = await env.DB.prepare('UPDATE trips SET reactivation_sent_at=CURRENT_TIMESTAMP WHERE id=? AND reactivation_sent_at IS NULL').bind(r.id).run();
    if (!claim.meta.changes) continue;
    const first = esc(String(r.name || '').trim().split(/\s+/)[0] || '');
    const texto = encodeURIComponent(`Olá! Quero assinar o Premium do Planner (9,99 € por 30 dias). Meu e-mail de cadastro é ${String(r.email)}.`);
    await deps.sendEmail(env, String(r.user_id), String(r.email), 'planner_reactivation', 'Sua viagem começa em 7 dias',
      `<p>Olá${first ? `, ${first}` : ''}.</p><p>A sua viagem <strong>${esc(r.name)}</strong> começa em 7 dias, e tudo o que você organizou continua guardado no Planner.</p><p>Assine o Premium por <strong>9,99 € (30 dias)</strong> e leve roteiro, reservas e cartão de embarque no celular, até sem internet. O pagamento é por Pix ou cartão, pelo WhatsApp.</p><p><a href="https://wa.me/351925307391?text=${texto}">Assinar pelo WhatsApp</a></p><p>Rota Certa Passagens</p>`,
      `A sua viagem ${String(r.name)} começa em 7 dias. Assine o Premium por 9,99 € e leve tudo no celular: https://wa.me/351925307391?text=${texto}`, `reactivation-${String(r.id)}`)
      .catch(() => undefined);
    sent += 1;
  }
  return sent;
}
