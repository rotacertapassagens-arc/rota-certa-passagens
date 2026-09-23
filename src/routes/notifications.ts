import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import type { EmailSender } from '../email.js';
import { audit, requireMutationAuth } from '../auth.js';
import { lisbonWeekStartUtc, safeEqualText } from '../security.js';
import { parseCommissionPaidPayload, parseWeeklySummaryPayload } from '../../shared/notificationPayloads.js';

interface OutboxRow {
  id: string;
  idempotency_key: string;
  event_type: 'referral_confirmed' | 'proposal_converted' | 'commission_paid' | 'weekly_summary';
  partner_id: string;
  channel: 'email' | 'whatsapp';
  payload: Record<string, unknown>;
  attempts: number;
}

const LEASE_SECONDS = 120;

/**
 * Notification delivery lives entirely inside this repository: an outbox table plus a small,
 * provider-agnostic processor. It never talks to the VPS/n8n/WhatsApp Business stack directly.
 * A WhatsApp send only happens through an authenticated webhook adapter that is off by default
 * (WHATSAPP_NOTIFICATIONS_ENABLED=false) so this task never activates real delivery.
 */
/**
 * Either an authenticated master (session + CSRF, for the admin UI) or the dedicated
 * NOTIFICATIONS_CRON_TOKEN bearer secret (for an unattended scheduler, e.g. a Cloudflare
 * Scheduled Event or an external cron caller with no session cookie) may trigger these two
 * routes. This mirrors the project's existing bootstrap-token pattern used for the very first
 * master invite. Returns the acting user id for the audit trail, or null for a cron call.
 */
async function requireMasterOrCron(db: Database, config: AppConfig, request: FastifyRequest, reply: FastifyReply): Promise<{ userId: string | null } | null> {
  const provided = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (config.NOTIFICATIONS_CRON_TOKEN && provided && safeEqualText(provided, config.NOTIFICATIONS_CRON_TOKEN)) {
    return { userId: null };
  }
  const auth = await requireMutationAuth(db, config, request, reply);
  if (!auth) return null;
  if (!auth.roles.includes('master')) {
    await reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return { userId: auth.userId };
}

export function registerNotificationRoutes(app: FastifyInstance, db: Database, config: AppConfig, emailSender: EmailSender) {
  app.post('/api/admin/notifications/process', async (request, reply) => {
    const auth = await requireMasterOrCron(db, config, request, reply);
    if (!auth) return;
    const limit = Math.min(z.coerce.number().int().min(1).max(200).default(50).parse((request.body as { limit?: number } | undefined)?.limit ?? 50));

    // Claim/lease: an unattended cron can fire this endpoint concurrently from more than one
    // caller (or a single caller can be retried while the first attempt is still running). Each
    // eligible row is atomically claimed by this specific invocation — 'pending' flips to
    // 'processing' with this invocation's own lock_token and a short lease — before anything is
    // sent. A row whose lease has already expired (the previous claimant crashed mid-send) is
    // just as claimable as a plain 'pending' row, so nothing gets stuck forever.
    //
    // On real PostgreSQL, the claim itself uses `SELECT ... FOR UPDATE SKIP LOCKED` inside an
    // explicit transaction: the SELECT takes real row locks on the candidate rows, a concurrent
    // claimer skips whatever is already locked (rather than blocking or re-reading a stale
    // snapshot), and the following UPDATE is scoped to exactly the ids that were actually locked.
    // This is the standard, well-documented PostgreSQL pattern for a multi-worker queue claim and
    // is what actually prevents two concurrent transactions from claiming the same row — a plain
    // `UPDATE ... WHERE id IN (SELECT ...)` (the previous implementation here) does NOT have that
    // guarantee: nothing stops a second transaction's subquery from also reading a row before the
    // first transaction's UPDATE commits and releases its lock.
    //
    // pg-mem (this repo's default test-suite driver; see tests/partners.test.ts) parses SKIP
    // LOCKED but does not implement it in its query planner, so `db.capabilities.supportsSkipLocked`
    // is false there and the code falls back to the old single-UPDATE pattern. That fallback is
    // NOT claimed to be safe under real concurrent PostgreSQL transactions — it only supports the
    // pg-mem-backed suite, which has no real MVCC/locking to race against regardless of the SQL
    // used. The real concurrent-claim guarantee is proven only by the separate, explicitly-gated
    // integration test tests/outbox-claim.pg-real.test.ts (see its header for how to run it
    // against a real PostgreSQL instance).
    //
    // Holding a valid lock_token is also not "exactly once" delivery: if the external send (email
    // provider / WhatsApp webhook) takes longer than the lease, another worker can reclaim the
    // row and resend. See the lease renewal and idempotency-key handling in processOutboxRow.
    const lockToken = randomUUID();
    let claimed: { rows: (OutboxRow & { payload: string | Record<string, unknown> })[] };
    if (db.capabilities.supportsSkipLocked) {
      claimed = await db.transaction(async (tx) => {
        const candidates = await tx.query<{ id: string }>(
          `SELECT id FROM notification_outbox
            WHERE next_attempt_at<=now()
              AND (status='pending' OR (status='processing' AND lease_expires_at < now()))
            ORDER BY next_attempt_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED`,
          [limit],
        );
        if (!candidates.rows.length) return { rows: [] };
        const ids = candidates.rows.map((row) => row.id);
        return tx.query<OutboxRow & { payload: string | Record<string, unknown> }>(
          `UPDATE notification_outbox
              SET status='processing', lock_token=$1, lease_expires_at=now() + ($2 || ' seconds')::interval, updated_at=now()
            WHERE id = ANY($3::uuid[])
            RETURNING id,idempotency_key,event_type,partner_id,channel,payload,attempts`,
          [lockToken, String(LEASE_SECONDS), ids],
        );
      });
    } else {
      claimed = await db.query<OutboxRow & { payload: string | Record<string, unknown> }>(
        `UPDATE notification_outbox
            SET status='processing', lock_token=$1, lease_expires_at=now() + ($2 || ' seconds')::interval, updated_at=now()
          WHERE id IN (
            SELECT id FROM notification_outbox
             WHERE next_attempt_at<=now()
               AND (status='pending' OR (status='processing' AND lease_expires_at < now()))
             ORDER BY next_attempt_at ASC LIMIT $3
          )
          RETURNING id,idempotency_key,event_type,partner_id,channel,payload,attempts`,
        [lockToken, String(LEASE_SECONDS), limit],
      );
    }

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let lockLost = 0;
    for (const row of claimed.rows) {
      const outcome = await processOutboxRow(db, config, emailSender, lockToken, {
        ...row,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      });
      if (outcome === 'sent') sent += 1;
      else if (outcome === 'skipped') skipped += 1;
      else if (outcome === 'lock_lost') lockLost += 1;
      else failed += 1;
    }
    await audit(db, config, request, 'admin.notifications_processed', auth.userId, null, null, { sent, skipped, failed, lockLost });
    // `sent`/`skipped`/`failed` only ever count rows this invocation itself held the lock for at
    // the moment it wrote the final status; `lockLost` is reported separately for visibility and
    // deliberately excluded from `processed` since this invocation made no authoritative decision
    // about that row's outcome.
    return reply.send({ processed: sent + skipped + failed, sent, skipped, failed, lockLost });
  });

  app.post('/api/admin/notifications/weekly-summary', async (request, reply) => {
    const auth = await requireMasterOrCron(db, config, request, reply);
    if (!auth) return;
    const weekStart = lisbonWeekStartUtc(new Date());
    const weekStartIso = weekStart.toISOString();
    // `currency` is fetched alongside the partner's identity: the weekly_summary payload must
    // always carry the partner's own configured currency (never a hardcoded default) so the
    // rendered notification shows the correct amount, in the correct currency, for that partner.
    const partners = await db.query<{ id: string; code: string; display_name: string; currency: string }>('SELECT id,code,display_name,currency FROM partners WHERE active=true');
    let created = 0;
    for (const partner of partners.rows) {
      // Kept as separate single-purpose queries (rather than one SELECT with four sibling
      // scalar subqueries) so the aggregate values are always returned as plain scalars.
      const [clicks, proposals, conversions, commission] = await Promise.all([
        db.query<{ count: number }>('SELECT count(*)::int AS count FROM referral_clicks WHERE partner_id=$1 AND clicked_at>=$2', [partner.id, weekStartIso]),
        db.query<{ count: number }>('SELECT count(*)::int AS count FROM lead_requests WHERE partner_id=$1 AND created_at>=$2', [partner.id, weekStartIso]),
        db.query<{ count: number }>("SELECT count(*)::int AS count FROM lead_requests WHERE partner_id=$1 AND status='converted' AND converted_at>=$2", [partner.id, weekStartIso]),
        db.query<{ total: number }>("SELECT COALESCE(sum(amount_cents),0)::int AS total FROM partner_commissions WHERE partner_id=$1 AND status<>'void' AND created_at>=$2", [partner.id, weekStartIso]),
      ]);
      // Field names (camelCase) and the presence of `currency` here are the documented contract
      // shared with the Worker backend — see shared/notificationPayloads.ts's WeeklySummaryPayload
      // and parseWeeklySummaryPayload, which both backends' renderers validate against before
      // rendering anything to a partner.
      const payload = {
        weekStart: weekStartIso,
        clicks: clicks.rows[0]?.count ?? 0,
        proposals: proposals.rows[0]?.count ?? 0,
        conversions: conversions.rows[0]?.count ?? 0,
        commissionCents: commission.rows[0]?.total ?? 0,
        currency: partner.currency,
      };
      const idempotencyKey = `weekly_summary:${partner.id}:${weekStartIso.slice(0, 10)}`;
      // A plain existence check (rather than relying on ON CONFLICT ... RETURNING, whose "no
      // row affected" signal is not consistent across every local SQL driver this repo tests
      // against) keeps idempotency both correct and easy to verify: repeat calls just see the
      // row already there and skip it.
      const already = await db.query('SELECT 1 FROM notification_outbox WHERE idempotency_key=$1', [idempotencyKey]);
      if (already.rowCount) continue;
      await db.query(
        `INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload)
         VALUES ($1,$2,'weekly_summary',$3,$4::jsonb) ON CONFLICT (idempotency_key) DO NOTHING`,
        [randomUUID(), idempotencyKey, partner.id, JSON.stringify(payload)],
      );
      created += 1;
    }
    return reply.send({ partnersConsidered: partners.rows.length, summariesCreated: created });
  });
}

type OutboxOutcome = 'sent' | 'skipped' | 'failed' | 'lock_lost';

async function processOutboxRow(db: Database, config: AppConfig, emailSender: EmailSender, lockToken: string, row: OutboxRow): Promise<OutboxOutcome> {
  try {
    if (row.channel === 'whatsapp' && config.WHATSAPP_NOTIFICATIONS_ENABLED !== true) {
      const result = await claimedUpdate(db, row.id, lockToken, "status='skipped',updated_at=now()");
      return result.rowCount ? 'skipped' : 'lock_lost';
    }
    // Renew the lease immediately before the external call (email provider / WhatsApp webhook).
    // LEASE_SECONDS is sized for the normal claim+send round trip, but a slow provider can
    // occasionally exceed it; renewing here — still gated on holding the *current* lock_token —
    // extends the window without ever handing a second claimant a "free" takeover mid-send. If
    // the renewal itself affects zero rows, the lock was already lost (another worker reclaimed
    // this row after its lease expired): abort before making the external call at all, so this
    // invocation never fires a send that the new owner will also independently fire.
    const renewed = await claimedUpdate(db, row.id, lockToken, "lease_expires_at=now() + ($2 || ' seconds')::interval, updated_at=now()", [String(LEASE_SECONDS)]);
    if (!renewed.rowCount) return 'lock_lost';

    if (row.channel === 'whatsapp') {
      await sendWhatsAppWebhook(config, row);
    } else {
      await deliverViaEmail(db, config, emailSender, row);
    }
    const result = await claimedUpdate(db, row.id, lockToken, "status='sent',attempts=attempts+1,updated_at=now()");
    // The external send may have genuinely succeeded, but if the lock was lost in the brief
    // window between the send and this write, this invocation must not claim credit for it (and
    // must not overwrite whatever the new owner has since done to the row) — the delivery is
    // reported as `lock_lost`, not `sent`. This is also why delivery here is documented as
    // "at least once, deduplicated by idempotency_key / the provider", never "exactly once": the
    // same row's payload can legitimately be sent by two different owners in this narrow window.
    return result.rowCount ? 'sent' : 'lock_lost';
  } catch (error) {
    const attempts = row.attempts + 1;
    const message = error instanceof Error ? error.message.slice(0, 200) : 'unknown_error';
    const result = attempts >= 5
      ? await claimedUpdate(db, row.id, lockToken, 'status=\'failed\',attempts=$2,last_error=$3,updated_at=now()', [attempts, message])
      : await claimedUpdate(
        db, row.id, lockToken,
        "attempts=$2,last_error=$3,next_attempt_at=now()+ ($4 || ' minutes')::interval,status='pending',lock_token=NULL,lease_expires_at=NULL,updated_at=now()",
        [attempts, message, String(2 ** attempts)],
      );
    return result.rowCount ? 'failed' : 'lock_lost';
  }
}

/**
 * Only the caller holding the still-current lock_token for this row may update it. This is what
 * makes the claim meaningful: even if a lease is (incorrectly) believed to still be held, a
 * conditional WHERE on both id and lock_token means a stale/duplicate writer's update simply
 * affects zero rows instead of corrupting a row another worker has since re-claimed. Every call
 * site MUST check the returned rowCount rather than assume the write landed.
 */
async function claimedUpdate(db: Database, id: string, lockToken: string, setClause: string, extraParams: unknown[] = []) {
  return db.query(`UPDATE notification_outbox SET ${setClause} WHERE id=$1 AND lock_token=${extraParams.length ? `$${extraParams.length + 2}` : '$2'}`, [id, ...extraParams, lockToken]);
}

async function deliverViaEmail(db: Database, config: AppConfig, emailSender: EmailSender, row: OutboxRow) {
  const partner = await db.query<{ email: string; display_name: string }>('SELECT email,display_name FROM partners WHERE id=$1', [row.partner_id]);
  const to = partner.rows[0]?.email;
  if (!to) throw new Error('partner_email_missing');
  const { template, subject, html, text } = renderNotification(row, partner.rows[0]?.display_name ?? '');
  // Reuses the same EmailSender abstraction as every other transactional email in the app
  // (capture mode in local/test — no network I/O — or the Resend-backed provider once
  // EMAIL_MODE=resend is actually configured for production, which this task never does).
  // idempotencyKey is the outbox row's own idempotency_key, passed through to the provider (see
  // RuntimeEmailSender) so a genuine double-send (the lock-loss race described above, or a
  // caller-level retry) is deduplicated by Resend's own idempotency-key support rather than
  // relying solely on this outbox's own claim/lease. This is "at least once with provider-level
  // deduplication", not "exactly once" — see LEASE_SECONDS/renewal comments in processOutboxRow.
  await emailSender.send({ userId: null, to, template, subject, html, text, idempotencyKey: row.idempotency_key });
  void config;
}

async function sendWhatsAppWebhook(config: AppConfig, row: OutboxRow) {
  if (!config.WHATSAPP_WEBHOOK_URL || !config.WHATSAPP_WEBHOOK_TOKEN) throw new Error('whatsapp_webhook_not_configured');
  const response = await fetch(config.WHATSAPP_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.WHATSAPP_WEBHOOK_TOKEN}`,
      // Passed through so the receiving webhook/provider can itself deduplicate a retried send,
      // independent of this outbox's own claim/lease protection against a *concurrent* double-send.
      'idempotency-key': row.idempotency_key,
    },
    body: JSON.stringify({ eventType: row.event_type, partnerId: row.partner_id, payload: row.payload, idempotencyKey: row.idempotency_key }),
  });
  if (!response.ok) throw new Error(`whatsapp_webhook_http_${response.status}`);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}

function formatCents(cents: unknown, currency: unknown) {
  const amount = typeof cents === 'number' ? cents : Number(cents ?? 0);
  const code = typeof currency === 'string' && currency.length === 3 ? currency : 'EUR';
  return `${(amount / 100).toFixed(2)} ${code}`;
}

/**
 * Every template here deliberately carries no customer PII (no customer name, email, phone, or
 * route/destination beyond what the partner already knows from their own dashboard) — only the
 * partner's own display name and aggregate/business facts about their own account, matching the
 * same no-PII-to-partner rule the partner dashboard endpoints already enforce.
 */
function renderNotification(row: OutboxRow, partnerName: string) {
  const safeName = escapeHtml(partnerName || 'parceiro(a)');
  switch (row.event_type) {
    case 'referral_confirmed':
      return {
        template: 'partner_referral_confirmed' as const,
        subject: 'Nova indicação recebida',
        html: `<p>Olá, ${safeName}.</p><p>Chegou uma nova indicação pelo seu link de parceiro. Acompanhe os detalhes no seu painel.</p>`,
        text: `Olá, ${partnerName}. Chegou uma nova indicação pelo seu link de parceiro. Acompanhe no seu painel.`,
      };
    case 'proposal_converted':
      return {
        template: 'partner_proposal_converted' as const,
        subject: 'Uma indicação sua fechou negócio',
        html: `<p>Olá, ${safeName}.</p><p>Uma proposta indicada por você foi convertida em venda. A comissão correspondente já está visível no seu painel de parceiros.</p>`,
        text: `Olá, ${partnerName}. Uma proposta indicada por você foi convertida em venda. Veja a comissão no seu painel.`,
      };
    case 'commission_paid': {
      // Validated against the shared contract before rendering: a malformed/incomplete payload
      // throws here (caught by processOutboxRow, retried like any other failure) instead of
      // silently rendering "0.00 EUR" to the partner.
      const payload = parseCommissionPaidPayload(row.payload);
      const amount = formatCents(payload.amountCents, payload.currency);
      return {
        template: 'partner_commission_paid' as const,
        subject: 'Comissão paga',
        html: `<p>Olá, ${safeName}.</p><p>Sua comissão de <strong>${escapeHtml(amount)}</strong> foi marcada como paga. Consulte o extrato completo no seu painel.</p>`,
        text: `Olá, ${partnerName}. Sua comissão de ${amount} foi marcada como paga. Consulte o extrato no seu painel.`,
      };
    }
    case 'weekly_summary': {
      // Same fail-closed validation as commission_paid above; see shared/notificationPayloads.ts.
      const payload = parseWeeklySummaryPayload(row.payload);
      const commission = formatCents(payload.commissionCents, payload.currency);
      return {
        template: 'partner_weekly_summary' as const,
        subject: 'Resumo semanal do seu link',
        html: `<p>Olá, ${safeName}.</p><p>Resumo da semana: <strong>${payload.clicks}</strong> cliques, <strong>${payload.proposals}</strong> propostas, <strong>${payload.conversions}</strong> conversões e <strong>${escapeHtml(commission)}</strong> em novas comissões.</p>`,
        text: `Olá, ${partnerName}. Resumo da semana: ${payload.clicks} cliques, ${payload.proposals} propostas, ${payload.conversions} conversões, ${commission} em novas comissões.`,
      };
    }
    default:
      return { template: 'partner_referral_confirmed' as const, subject: 'Atualização do programa de parceiros', html: `<p>Olá, ${safeName}. Você tem uma atualização.</p>`, text: `Olá, ${partnerName}. Você tem uma atualização.` };
  }
}
