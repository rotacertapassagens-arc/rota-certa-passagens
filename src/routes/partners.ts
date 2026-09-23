import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import type { EmailSender } from '../email.js';
import { audit, enforceRateLimit, requireAuth, requireMutationAuth } from '../auth.js';
import {
  ALLOWED_CURRENCIES,
  hashPassword,
  isUniqueViolation,
  isValidPartnerCode,
  normalizeEmail,
  normalizePartnerCode,
  randomEmailCode,
  signReferralToken,
  tokenDigest,
  verifyReferralToken,
} from '../security.js';

const CURRENCY_ENUM = z.enum(ALLOWED_CURRENCIES);

export const REF_COOKIE_NAME = 'rc_ref';

interface PartnerRow {
  id: string;
  code: string;
  display_name: string;
  instagram: string | null;
  whatsapp: string | null;
  email: string;
  commission_type: 'fixed' | 'percentage';
  commission_fixed_cents: number | null;
  commission_percentage_bps: number | null;
  currency: string;
  attribution_window_days: number;
  active: boolean;
  user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Attribution {
  partnerId: string;
  code: string;
  source: 'link' | 'manual';
  capturedAt: Date;
  expiresAt: Date;
}

const partnerCreateSchema = z.object({
  code: z.string().trim().min(3).max(32),
  displayName: z.string().trim().min(2).max(120),
  instagram: z.string().trim().max(120).optional().or(z.literal('')),
  whatsapp: z.string().trim().max(30).optional().or(z.literal('')),
  email: z.string().email().max(254),
  commissionType: z.enum(['fixed', 'percentage']),
  commissionFixedCents: z.number().int().min(0).max(100_000_00).optional(),
  commissionPercentageBps: z.number().int().min(1).max(10_000).optional(),
  currency: CURRENCY_ENUM.default('EUR'),
  attributionWindowDays: z.number().int().min(1).max(365).default(30),
}).superRefine((data, ctx) => {
  if (data.commissionType === 'fixed' && (data.commissionFixedCents === undefined || data.commissionPercentageBps !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['commissionFixedCents'], message: 'fixed_commission_required' });
  }
  if (data.commissionType === 'percentage' && (data.commissionPercentageBps === undefined || data.commissionFixedCents !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['commissionPercentageBps'], message: 'percentage_commission_required' });
  }
});

const partnerUpdateSchema = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  instagram: z.string().trim().max(120).optional().or(z.literal('')),
  whatsapp: z.string().trim().max(30).optional().or(z.literal('')),
  commissionType: z.enum(['fixed', 'percentage']).optional(),
  commissionFixedCents: z.number().int().min(0).max(100_000_00).optional(),
  commissionPercentageBps: z.number().int().min(1).max(10_000).optional(),
  currency: CURRENCY_ENUM.optional(),
  attributionWindowDays: z.number().int().min(1).max(365).optional(),
  active: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.commissionType === 'fixed' && data.commissionFixedCents === undefined) {
    ctx.addIssue({ code: 'custom', path: ['commissionFixedCents'], message: 'fixed_commission_required' });
  }
  if (data.commissionType === 'percentage' && data.commissionPercentageBps === undefined) {
    ctx.addIssue({ code: 'custom', path: ['commissionPercentageBps'], message: 'percentage_commission_required' });
  }
});

const acceptInviteSchema = z.object({ email: z.string().email().max(254), code: z.string().regex(/^\d{6}$/), password: z.string().min(12).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/) });

export function registerPartnerRoutes(app: FastifyInstance, db: Database, config: AppConfig, emailSender: EmailSender) {
  // --- Public attribution surface -------------------------------------------------------

  app.get('/i/:code', async (request, reply) => {
    const params = z.object({ code: z.string().min(1).max(64) }).safeParse(request.params);
    const fallback = () => reply.code(302).header('cache-control', 'no-store').redirect('/');
    if (!params.success) return fallback();
    const code = normalizePartnerCode(params.data.code);
    if (!isValidPartnerCode(code)) return fallback();

    const partner = await db.query<{ id: string; attribution_window_days: number }>(
      'SELECT id,attribution_window_days FROM partners WHERE code=$1 AND active=true',
      [code],
    );
    const row = partner.rows[0];
    if (!row) return fallback();

    // Anonymous burst-click protection: a repeated click from the same (IP, user-agent) pair for
    // the same partner code within a short window is deduplicated so it cannot inflate click
    // metrics — this reuses the same generic rate_limit_buckets table/helper as every other
    // rate-limited endpoint (window: 60s, one counted click per window; retention follows that
    // table's normal lifecycle, there is no separate long-term store). Only a raw client IP is
    // never stored: `tokenDigest` (HMAC-SHA256) is applied before anything touches the database,
    // same as the existing ip_hash/visitor_hash columns already did. The visitor still always
    // gets their cookie and redirect regardless of whether this click was counted.
    const visitorKey = tokenDigest(`${request.ip}|${request.headers['user-agent'] ?? ''}`, config.RATE_LIMIT_SECRET);
    const firstClickInWindow = await enforceRateLimit(db, config, request, 'referral_click', `${code}:${visitorKey}`, 1, 60);
    if (firstClickInWindow) {
      // Telemetry is best-effort: a failure here must never block the redirect the partner relies on.
      try {
        await db.query(
          `INSERT INTO referral_clicks (id,partner_id,landing_path,visitor_hash,ip_hash,user_agent)
           VALUES ($1,$2,'/proposta-voo.html',$3,$4,$5)`,
          [
            randomUUID(),
            row.id,
            visitorKey,
            tokenDigest(request.ip, config.RATE_LIMIT_SECRET),
            (request.headers['user-agent'] ?? '').toString().slice(0, 300),
          ],
        );
      } catch (error) {
        request.log.warn({ err: error }, 'referral_click_capture_failed');
      }
    }

    const capturedAtMs = Date.now();
    const token = signReferralToken(code, capturedAtMs, config.TOKEN_PEPPER);
    reply.setCookie(REF_COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: 'lax',
      maxAge: row.attribution_window_days * 24 * 60 * 60,
    });
    reply.header('cache-control', 'no-store');
    return reply.code(302).redirect(`/proposta-voo.html?ref=${encodeURIComponent(code)}`);
  });

  // Server-validated banner data for the proposal form. Never exposes the internal partner id.
  app.get('/api/partners/attribution', async (request, reply) => {
    const attribution = await resolveAttribution(db, config, request, undefined);
    reply.header('cache-control', 'no-store');
    if (!attribution) return reply.send({ active: false });
    const partner = await db.query<{ display_name: string }>('SELECT display_name FROM partners WHERE id=$1', [attribution.partnerId]);
    if (!partner.rows[0]) return reply.send({ active: false });
    return reply.send({ active: true, code: attribution.code, displayName: partner.rows[0].display_name });
  });

  app.get('/parceiros.html/terms', async (_request, reply) => reply.redirect('/parceiros.html'));

  // --- Master: partner management --------------------------------------------------------

  app.get('/api/admin/partners', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply);
    if (!auth) return;
    const query = z.object({ active: z.enum(['true', 'false']).optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_filter' });
    const rows = await db.query<PartnerRow & Record<string, unknown>>(
      // Pre-aggregated derived tables (one row per partner_id) joined 1:1, rather than either
      // "p.*, (correlated subquery on p) ..." or a single multi-table LEFT JOIN with SUM/COUNT —
      // the former errors on pg-mem (used only by this repo's Node test/E2E harness: it cannot
      // resolve an outer FROM-alias referenced from inside a SELECT-list subquery at all, a
      // genuine engine limitation, not a bug in the SQL itself) and the latter would silently
      // inflate every aggregate via a fan-out cartesian product across the three joined 1-to-many
      // relations (clicks × leads × commissions). This form is correct and portable on both.
      `SELECT p.id,p.code,p.display_name,p.instagram,p.whatsapp,p.email,p.commission_type,
        p.commission_fixed_cents,p.commission_percentage_bps,p.currency,p.attribution_window_days,
        p.active,p.user_id,(activated.user_id IS NOT NULL) AS account_activated,p.created_at,p.updated_at,
        COALESCE(clicks.n,0)::int AS clicks,
        COALESCE(leads.proposals,0)::int AS proposals,
        COALESCE(leads.conversions,0)::int AS conversions,
        COALESCE(commissions.pending,0)::int AS commission_pending_cents,
        COALESCE(commissions.approved,0)::int AS commission_approved_cents,
        COALESCE(commissions.paid,0)::int AS commission_paid_cents
       FROM partners p
       LEFT JOIN (SELECT partner_id, count(*) AS n FROM referral_clicks GROUP BY partner_id) clicks ON clicks.partner_id=p.id
       LEFT JOIN (
         SELECT partner_id, count(*) AS proposals, SUM(CASE WHEN status='converted' THEN 1 ELSE 0 END) AS conversions
           FROM lead_requests GROUP BY partner_id
       ) leads ON leads.partner_id=p.id
       LEFT JOIN (
         SELECT partner_id,
           SUM(CASE WHEN status='pending' THEN amount_cents ELSE 0 END) AS pending,
           SUM(CASE WHEN status='approved' THEN amount_cents ELSE 0 END) AS approved,
           SUM(CASE WHEN status='paid' THEN amount_cents ELSE 0 END) AS paid
           FROM partner_commissions GROUP BY partner_id
       ) commissions ON commissions.partner_id=p.id
       LEFT JOIN (SELECT DISTINCT user_id FROM user_roles WHERE role='partner') activated ON activated.user_id=p.user_id
       WHERE ($1::boolean IS NULL OR p.active=$1)
       ORDER BY p.created_at DESC LIMIT 200`,
      [query.data.active === undefined ? null : query.data.active === 'true'],
    );
    return reply.send({ partners: rows.rows.map(serializePartner) });
  });

  app.post('/api/admin/partners', async (request, reply) => {
    const auth = await requireMutationMaster(db, config, request, reply);
    if (!auth) return;
    const parsed = partnerCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_partner' });
    const code = normalizePartnerCode(parsed.data.code);
    if (!isValidPartnerCode(code)) return reply.code(400).send({ error: 'invalid_code' });
    const existing = await db.query('SELECT 1 FROM partners WHERE code=$1', [code]);
    if (existing.rowCount) return reply.code(409).send({ error: 'code_already_used' });
    const email = normalizeEmail(parsed.data.email);
    const existingEmail = await db.query('SELECT 1 FROM partners WHERE lower(email)=lower($1)', [email]);
    if (existingEmail.rowCount) return reply.code(409).send({ error: 'email_already_used_by_partner' });
    const id = randomUUID();
    try {
      await db.query(
        `INSERT INTO partners
          (id,code,display_name,instagram,whatsapp,email,commission_type,commission_fixed_cents,commission_percentage_bps,currency,attribution_window_days,active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)`,
        [
          id, code, parsed.data.displayName, parsed.data.instagram || null, parsed.data.whatsapp || null,
          email, parsed.data.commissionType, parsed.data.commissionFixedCents ?? null,
          parsed.data.commissionPercentageBps ?? null, parsed.data.currency.toUpperCase(), parsed.data.attributionWindowDays,
        ],
      );
    } catch (error) {
      // Defense in depth beneath the pre-check above (a concurrent request could race it): the
      // unique index on code and on lower(email) (migration 0006) never surfaces as a raw SQL
      // error to the client.
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'code_or_email_already_used' });
      throw error;
    }
    await audit(db, config, request, 'admin.partner_created', auth.userId, 'partner', id);
    return reply.code(201).send({ id, code });
  });

  app.patch('/api/admin/partners/:id', async (request, reply) => {
    const auth = await requireMutationMaster(db, config, request, reply);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = partnerUpdateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const current = await db.query<PartnerRow>('SELECT * FROM partners WHERE id=$1', [params.data.id]);
    const partner = current.rows[0];
    if (!partner) return reply.code(404).send({ error: 'not_found' });
    const next = {
      displayName: parsed.data.displayName ?? partner.display_name,
      instagram: parsed.data.instagram !== undefined ? (parsed.data.instagram || null) : partner.instagram,
      whatsapp: parsed.data.whatsapp !== undefined ? (parsed.data.whatsapp || null) : partner.whatsapp,
      commissionType: parsed.data.commissionType ?? partner.commission_type,
      commissionFixedCents: parsed.data.commissionType
        ? (parsed.data.commissionType === 'fixed' ? parsed.data.commissionFixedCents ?? null : null)
        : (parsed.data.commissionFixedCents ?? partner.commission_fixed_cents),
      commissionPercentageBps: parsed.data.commissionType
        ? (parsed.data.commissionType === 'percentage' ? parsed.data.commissionPercentageBps ?? null : null)
        : (parsed.data.commissionPercentageBps ?? partner.commission_percentage_bps),
      currency: (parsed.data.currency ?? partner.currency).toUpperCase(),
      attributionWindowDays: parsed.data.attributionWindowDays ?? partner.attribution_window_days,
      active: parsed.data.active ?? partner.active,
    };
    if (next.currency !== partner.currency) {
      // Changing a partner's operating currency after they already have non-voided commissions
      // would make aggregate totals mix currencies (or silently reinterpret historical amounts
      // as if they had always been in the new currency). Each commission row keeps its own
      // currency snapshot regardless, but new totals must never be built by just relabeling old
      // ones, so the currency itself is locked once real commission history exists.
      const hasCommissions = await db.query('SELECT 1 FROM partner_commissions WHERE partner_id=$1 AND status<>\'void\' LIMIT 1', [params.data.id]);
      if (hasCommissions.rowCount) return reply.code(409).send({ error: 'currency_locked_existing_commissions' });
    }
    await db.query(
      `UPDATE partners SET display_name=$1,instagram=$2,whatsapp=$3,commission_type=$4,commission_fixed_cents=$5,
              commission_percentage_bps=$6,currency=$7,attribution_window_days=$8,active=$9,updated_at=now()
        WHERE id=$10`,
      [next.displayName, next.instagram, next.whatsapp, next.commissionType, next.commissionFixedCents,
       next.commissionPercentageBps, next.currency, next.attributionWindowDays, next.active, params.data.id],
    );
    await audit(db, config, request, 'admin.partner_updated', auth.userId, 'partner', params.data.id, { active: next.active });
    return reply.send({ ok: true });
  });

  app.get('/api/admin/partners/:id', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const partner = await db.query<PartnerRow & Record<string, unknown>>(
      `SELECT p.*,(activated.user_id IS NOT NULL) AS account_activated
         FROM partners p
         LEFT JOIN (SELECT DISTINCT user_id FROM user_roles WHERE role='partner') activated ON activated.user_id=p.user_id
        WHERE p.id=$1`,
      [params.data.id],
    );
    if (!partner.rows[0]) return reply.code(404).send({ error: 'not_found' });
    const commissions = await db.query(
      `SELECT pc.id,pc.amount_cents,pc.currency,pc.status,pc.created_at,pc.approved_at,pc.paid_at,pc.voided_at,pc.void_reason,
              l.protocol,l.status AS lead_status,l.origin,l.destination
         FROM partner_commissions pc JOIN lead_requests l ON l.id=pc.lead_request_id
        WHERE pc.partner_id=$1 ORDER BY pc.created_at DESC LIMIT 200`,
      [params.data.id],
    );
    return reply.send({ partner: serializePartner(partner.rows[0] as PartnerRow & Record<string, unknown>), commissions: commissions.rows });
  });

  app.post('/api/admin/partners/:id/invite', async (request, reply) => {
    const auth = await requireMutationMaster(db, config, request, reply);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const partner = await db.query<PartnerRow>('SELECT * FROM partners WHERE id=$1', [params.data.id]);
    const row = partner.rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!row.active) return reply.code(409).send({ error: 'partner_inactive' });

    // Another partner already owns this email/account: `partners.user_id` is unique, and (since
    // migration 0006) so is lower(partners.email). Detected up front with a clear, safe error
    // instead of letting a raw unique-violation surface from the transaction below.
    const conflictingLink = await db.query<{ id: string }>(
      `SELECT p.id FROM partners p JOIN users u ON u.id=p.user_id WHERE u.email=$1 AND p.id<>$2`,
      [row.email, row.id],
    );
    if (conflictingLink.rowCount) return reply.code(409).send({ error: 'email_linked_to_other_partner' });

    const code = randomEmailCode();
    let userId: string;
    await db.transaction(async (tx) => {
      const users = await tx.query<{ id: string }>('SELECT id FROM users WHERE email=$1', [row.email]);
      userId = users.rows[0]?.id ?? randomUUID();
      if (!users.rowCount) {
        await tx.query("INSERT INTO users (id,email,status) VALUES ($1,$2,'pending')", [userId, row.email]);
        await tx.query('INSERT INTO profiles (user_id,display_name) VALUES ($1,$2)', [userId, row.display_name]);
      }
      // Linking the account and preparing the invite token happens here, but the 'partner' role
      // itself is granted only after the invite code is actually accepted (see
      // /api/partner-invites/accept below) — never at invite-creation time. Otherwise an account
      // that already exists and is already active (e.g. an existing customer with this email)
      // would gain partner-panel access immediately, before completing any activation step.
      await tx.query('UPDATE partners SET user_id=$1,updated_at=now() WHERE id=$2', [userId, row.id]);
      // Resending an invite invalidates every previous unused token for this purpose, so an
      // older code from a prior invite email can never be redeemed after a newer one is sent.
      await tx.query("UPDATE account_tokens SET used_at=now() WHERE user_id=$1 AND purpose='partner_invite' AND used_at IS NULL", [userId]);
      await tx.query(
        `INSERT INTO account_tokens (id,user_id,purpose,token_hash,expires_at)
         VALUES ($1,$2,'partner_invite',$3,now()+interval '15 minutes')`,
        [randomUUID(), userId, tokenDigest(code, config.TOKEN_PEPPER)],
      );
    });
    await emailSender.send({
      userId: userId!, to: row.email, template: 'partner_invite',
      subject: 'Convite para o painel de parceiros - Rota Certa Passagens',
      html: `<p>Você foi convidado(a) para acompanhar suas indicações no painel de parceiros da Rota Certa Passagens.</p><p>Seu código de ativação é: <strong>${code}</strong></p><p><a href="${config.APP_ORIGIN}/parceiro-convite.html">Finalizar cadastro do parceiro</a></p><p>Use o mesmo e-mail que recebeu este convite. O código expira em 15 minutos e só pode ser usado uma vez.</p>`,
      text: `Você foi convidado(a) para o painel de parceiros da Rota Certa Passagens. Código de ativação: ${code}. Finalize em ${config.APP_ORIGIN}/parceiro-convite.html. O código expira em 15 minutos e só pode ser usado uma vez.`,
    });
    await audit(db, config, request, 'admin.partner_invite_created', auth.userId, 'partner', row.id);
    return reply.code(201).send({ ok: true });
  });

  app.post('/api/partner-invites/accept', async (request, reply) => {
    const parsed = acceptInviteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_or_expired_invite' });
    const email = normalizeEmail(parsed.data.email);
    if (!(await enforceRateLimit(db, config, request, 'partner_invite_accept', email, 8, 15 * 60))) return reply.code(429).send({ error: 'too_many_attempts' });
    const tokens = await db.query<{ id: string; user_id: string }>(
      `SELECT t.id,t.user_id FROM account_tokens t JOIN users u ON u.id=t.user_id
        WHERE u.email=$1 AND t.token_hash=$2 AND t.purpose='partner_invite'
          AND t.used_at IS NULL AND t.expires_at > now() AND t.failed_attempts < 5 LIMIT 1`,
      [email, tokenDigest(parsed.data.code, config.TOKEN_PEPPER)],
    );
    const token = tokens.rows[0];
    if (!token) {
      await db.query(
        `UPDATE account_tokens SET failed_attempts=failed_attempts+1 WHERE id=(
          SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id
           WHERE u.email=$1 AND t.purpose='partner_invite' AND t.used_at IS NULL AND t.expires_at>now()
           ORDER BY t.created_at DESC LIMIT 1)`,
        [email],
      );
      return reply.code(400).send({ error: 'invalid_or_expired_invite' });
    }
    const passwordHash = await hashPassword(parsed.data.password);
    try {
      await db.transaction(async (tx) => {
        await tx.query("UPDATE users SET password_hash=$1,status='active',email_verified_at=now(),updated_at=now() WHERE id=$2", [passwordHash, token.user_id]);
        // The 'partner' role — and therefore all partner-panel access — is granted only here,
        // transactionally, after the single-use code has just been validated above. An invite
        // that is expired, wrong, or never accepted never reaches this line, so it never grants
        // access. This also covers an already-active customer account with the same email: they
        // only gain partner access once they actually complete this acceptance step, not the
        // moment a master sends the invite.
        await tx.query("INSERT INTO user_roles (user_id,role) VALUES ($1,'partner') ON CONFLICT DO NOTHING", [token.user_id]);
        await tx.query('UPDATE account_tokens SET used_at=now() WHERE id=$1', [token.id]);
      });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'email_linked_to_other_partner' });
      throw error;
    }
    await audit(db, config, request, 'partner.invite_accepted', token.user_id, 'user', token.user_id);
    return reply.send({ ok: true });
  });

  // --- Partner dashboard (self-service, strictly scoped) ----------------------------------

  app.get('/api/partner/summary', async (request, reply) => {
    const partner = await requirePartnerSelf(db, config, request, reply);
    if (!partner) return;
    const [clicks, proposals, conversions] = await Promise.all([
      db.query<{ count: number }>('SELECT count(*)::int AS count FROM referral_clicks WHERE partner_id=$1', [partner.id]),
      db.query<{ count: number }>('SELECT count(*)::int AS count FROM lead_requests WHERE partner_id=$1', [partner.id]),
      db.query<{ count: number }>("SELECT count(*)::int AS count FROM lead_requests WHERE partner_id=$1 AND status='converted'", [partner.id]),
    ]);
    const stats = { rows: [{ clicks: clicks.rows[0]?.count ?? 0, proposals: proposals.rows[0]?.count ?? 0, conversions: conversions.rows[0]?.count ?? 0 }] };
    const commissions = await db.query<{ status: string; total: number }>(
      `SELECT status,COALESCE(sum(amount_cents),0)::int AS total FROM partner_commissions WHERE partner_id=$1 GROUP BY status`,
      [partner.id],
    );
    const totals = { pending: 0, approved: 0, paid: 0, void: 0 };
    for (const row of commissions.rows) totals[row.status as keyof typeof totals] = row.total;
    return reply.send({
      partner: { code: partner.code, displayName: partner.display_name, active: partner.active, commissionType: partner.commission_type, commissionFixedCents: partner.commission_fixed_cents, commissionPercentageBps: partner.commission_percentage_bps, currency: partner.currency, attributionWindowDays: partner.attribution_window_days, link: `${config.APP_ORIGIN.replace(/\/$/, '')}/i/${partner.code}` },
      stats: stats.rows[0],
      commissionTotalsCents: totals,
    });
  });

  app.get('/api/partner/ledger', async (request, reply) => {
    const partner = await requirePartnerSelf(db, config, request, reply);
    if (!partner) return;
    // Scoped exclusively to this partner's own id — never accepts a partner id from the client.
    const leads = await db.query<{ id: string; protocol: string; status: string; origin: string | null; destination: string | null; created_at: Date; converted_at: Date | null; referral_source: string }>(
      `SELECT id,protocol,status,origin,destination,created_at,converted_at,referral_source
         FROM lead_requests WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 200`,
      [partner.id],
    );
    // Documented, deterministic "current commission per lead" rule: a lead can have more than
    // one historical commission row (converted -> voided -> reconverted). The SQL ORDER BY
    // guarantees the first row seen per lead_request_id is the active (non-void) commission if
    // one exists, otherwise the most recently voided one — so the Map built from it below is
    // safe, unlike the previous version which depended on the database's unspecified row order.
    const leadIds = leads.rows.map((row) => row.id);
    const commissionByLead = new Map<string, { amount_cents: number; currency: string; status: string }>();
    if (leadIds.length) {
      // Filtered by partner_id alone (every commission row for this partner is, by definition,
      // for one of this partner's own leads) rather than `lead_request_id = ANY($n)` — kept
      // simple and portable, since not every SQL engine this repo tests against infers a text[]
      // bind parameter's element type the same way real Postgres does.
      const commissionRows = await db.query<{ lead_request_id: string; amount_cents: number; currency: string; status: string }>(
        `SELECT lead_request_id,amount_cents,currency,status FROM partner_commissions
          WHERE partner_id=$1 ORDER BY (status='void') ASC, created_at DESC`,
        [partner.id],
      );
      for (const row of commissionRows.rows) {
        if (!commissionByLead.has(row.lead_request_id)) commissionByLead.set(row.lead_request_id, row);
      }
    }
    return reply.send({
      entries: leads.rows.map((lead) => ({
        protocolMasked: maskProtocol(lead.protocol),
        route: safeRoute(lead.origin, lead.destination),
        status: lead.status,
        referralSource: lead.referral_source,
        requestedAt: lead.created_at,
        convertedAt: lead.converted_at,
        commission: commissionByLead.get(lead.id) ? {
          amountCents: commissionByLead.get(lead.id)!.amount_cents,
          currency: commissionByLead.get(lead.id)!.currency,
          status: commissionByLead.get(lead.id)!.status,
        } : null,
      })),
    });
  });

  // --- Master: commission lifecycle --------------------------------------------------------

  app.post('/api/admin/commissions/:id/approve', async (request, reply) => commissionTransition(app, db, config, request, reply, 'approved'));
  app.post('/api/admin/commissions/:id/pay', async (request, reply) => commissionTransition(app, db, config, request, reply, 'paid'));
  app.post('/api/admin/commissions/:id/void', async (request, reply) => {
    const auth = await requireMutationMaster(db, config, request, reply);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const current = await db.query<{ id: string; status: string }>('SELECT id,status FROM partner_commissions WHERE id=$1', [params.data.id]);
    const commission = current.rows[0];
    if (!commission) return reply.code(404).send({ error: 'not_found' });
    if (commission.status === 'paid') {
      // A paid commission is a settled financial fact and can never be voided directly — that
      // would destroy the record of money that already went out. A dedicated adjustment/refund
      // flow (not built in this pass) is required first.
      return reply.code(409).send({ error: 'commission_paid_requires_adjustment' });
    }
    if (commission.status === 'void') return reply.code(409).send({ error: 'already_void' });
    const updated = await db.query(
      `UPDATE partner_commissions SET status='void',voided_at=now(),voided_by=$1,void_reason=$2,updated_at=now()
        WHERE id=$3 AND status IN ('pending','approved') RETURNING id,partner_id`,
      [auth.userId, body.data.reason, params.data.id],
    );
    if (!updated.rowCount) return reply.code(409).send({ error: 'invalid_transition' });
    await audit(db, config, request, 'admin.commission_voided', auth.userId, 'partner_commission', params.data.id, { reason: body.data.reason });
    return reply.send({ ok: true });
  });
}

async function commissionTransition(app: FastifyInstance, db: Database, config: AppConfig, request: FastifyRequest, reply: FastifyReply, target: 'approved' | 'paid') {
  const auth = await requireMutationMaster(db, config, request, reply);
  if (!auth) return;
  const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
  const allowedFrom = target === 'approved' ? ['pending'] : ['approved'];
  const columns = target === 'approved' ? "approved_at=now(),approved_by=$1" : "paid_at=now(),paid_by=$1";
  const updated = await db.query(
    `UPDATE partner_commissions SET status=$2,${columns},updated_at=now()
      WHERE id=$3 AND status = ANY($4) RETURNING id,partner_id,amount_cents,currency`,
    [auth.userId, target, params.data.id, allowedFrom],
  );
  if (!updated.rowCount) return reply.code(409).send({ error: 'invalid_transition' });
  await audit(db, config, request, `admin.commission_${target}`, auth.userId, 'partner_commission', params.data.id);
  if (target === 'paid') {
    const commission = updated.rows[0] as { id: string; partner_id: string; amount_cents: number; currency: string };
    await db.query(
      `INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload)
       VALUES ($1,$2,'commission_paid',$3,$4::jsonb) ON CONFLICT (idempotency_key) DO NOTHING`,
      [randomUUID(), `commission_paid:${commission.id}`, commission.partner_id, JSON.stringify({ commissionId: commission.id, amountCents: commission.amount_cents, currency: commission.currency })],
    );
  }
  return reply.send({ ok: true });
}

/** Resolves referral attribution for the current request without ever trusting a client-supplied partner id. */
export async function resolveAttribution(
  db: Database,
  config: AppConfig,
  request: FastifyRequest,
  manualCode: string | undefined,
): Promise<Attribution | null> {
  const cookieToken = request.cookies?.[REF_COOKIE_NAME];
  if (cookieToken) {
    const verified = verifyReferralToken(cookieToken, config.TOKEN_PEPPER);
    if (verified) {
      const partner = await db.query<{ id: string; attribution_window_days: number }>(
        'SELECT id,attribution_window_days FROM partners WHERE code=$1 AND active=true',
        [verified.code],
      );
      const row = partner.rows[0];
      if (row) {
        const capturedAt = new Date(verified.capturedAtMs);
        const expiresAt = new Date(verified.capturedAtMs + row.attribution_window_days * 24 * 60 * 60 * 1000);
        if (expiresAt.getTime() > Date.now()) {
          return { partnerId: row.id, code: verified.code, source: 'link', capturedAt, expiresAt };
        }
      }
    }
  }
  if (manualCode) {
    const code = normalizePartnerCode(manualCode);
    if (isValidPartnerCode(code)) {
      const partner = await db.query<{ id: string; attribution_window_days: number }>(
        'SELECT id,attribution_window_days FROM partners WHERE code=$1 AND active=true',
        [code],
      );
      const row = partner.rows[0];
      if (row) {
        const capturedAt = new Date();
        const expiresAt = new Date(capturedAt.getTime() + row.attribution_window_days * 24 * 60 * 60 * 1000);
        return { partnerId: row.id, code, source: 'manual', capturedAt, expiresAt };
      }
    }
  }
  return null;
}

function serializePartner(row: PartnerRow & Record<string, unknown>) {
  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    instagram: row.instagram,
    whatsapp: row.whatsapp,
    email: row.email,
    commissionType: row.commission_type,
    commissionFixedCents: row.commission_fixed_cents,
    commissionPercentageBps: row.commission_percentage_bps,
    currency: row.currency,
    attributionWindowDays: row.attribution_window_days,
    active: row.active,
    hasAccount: Boolean(row.user_id),
    accountActivated: Boolean(row.account_activated),
    createdAt: row.created_at,
    clicks: row.clicks ?? undefined,
    proposals: row.proposals ?? undefined,
    conversions: row.conversions ?? undefined,
    commissionPendingCents: row.commission_pending_cents ?? undefined,
    commissionApprovedCents: row.commission_approved_cents ?? undefined,
    commissionPaidCents: row.commission_paid_cents ?? undefined,
  };
}

function maskProtocol(protocol: string) {
  const parts = protocol.split('-');
  const suffix = parts[2] ?? '';
  const visible = suffix.slice(0, 2);
  return `${parts[0]}-${parts[1]}-${visible}${'•'.repeat(Math.max(0, suffix.length - 2))}`;
}

function safeRoute(origin: string | null, destination: string | null) {
  if (!origin || !destination) return null;
  return `${origin} → ${destination}`;
}

async function requireMaster(db: Database, config: AppConfig, request: FastifyRequest, reply: FastifyReply) {
  const auth = await requireAuth(db, config, request, reply);
  if (!auth) return null;
  if (!auth.roles.includes('master')) {
    await reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return auth;
}

async function requireMutationMaster(db: Database, config: AppConfig, request: FastifyRequest, reply: FastifyReply) {
  const auth = await requireMutationAuth(db, config, request, reply);
  if (!auth) return null;
  if (!auth.roles.includes('master')) {
    await reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return auth;
}

async function requirePartnerSelf(db: Database, config: AppConfig, request: FastifyRequest, reply: FastifyReply): Promise<PartnerRow | null> {
  const auth = await requireAuth(db, config, request, reply);
  if (!auth) return null;
  if (!auth.roles.includes('partner')) {
    await reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  // A deactivated partner keeps whatever other roles their account has (e.g. they can still be
  // a 'customer'), but partner-scoped access is revoked immediately: the query only ever
  // returns an active row, so a deactivated partner gets the same 403 as someone with no
  // partner record at all, with no separate "reactivate to restore access" step needed beyond
  // flipping `active` back to true.
  const partner = await db.query<PartnerRow>('SELECT * FROM partners WHERE user_id=$1 AND active=true', [auth.userId]);
  const row = partner.rows[0];
  if (!row) {
    await reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  reply.header('cache-control', 'no-store');
  return row;
}
