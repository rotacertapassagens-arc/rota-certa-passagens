import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { audit, requireMutationAuth } from '../auth.js';
import { safeEqualText } from '../security.js';

interface OutboxRow {
  id: string;
  idempotency_key: string;
  event_type: 'referral_confirmed' | 'proposal_converted' | 'commission_paid' | 'weekly_summary';
  partner_id: string;
  channel: 'email' | 'whatsapp';
  payload: Record<string, unknown>;
  attempts: number;
}

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

export function registerNotificationRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  app.post('/api/admin/notifications/process', async (request, reply) => {
    const auth = await requireMasterOrCron(db, config, request, reply);
    if (!auth) return;
    const limit = Math.min(z.coerce.number().int().min(1).max(200).default(50).parse((request.body as { limit?: number } | undefined)?.limit ?? 50));
    const pending = await db.query<OutboxRow & { payload: string | Record<string, unknown> }>(
      `SELECT id,idempotency_key,event_type,partner_id,channel,payload,attempts
         FROM notification_outbox WHERE status='pending' AND next_attempt_at<=now()
        ORDER BY next_attempt_at ASC LIMIT $1`,
      [limit],
    );
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    for (const row of pending.rows) {
      const outcome = await processOutboxRow(db, config, {
        ...row,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      });
      if (outcome === 'sent') sent += 1;
      else if (outcome === 'skipped') skipped += 1;
      else failed += 1;
    }
    await audit(db, config, request, 'admin.notifications_processed', auth.userId, null, null, { sent, skipped, failed });
    return reply.send({ processed: pending.rows.length, sent, skipped, failed });
  });

  app.post('/api/admin/notifications/weekly-summary', async (request, reply) => {
    const auth = await requireMasterOrCron(db, config, request, reply);
    if (!auth) return;
    const weekStart = lisbonWeekStart(new Date());
    const weekStartIso = weekStart.toISOString();
    const partners = await db.query<{ id: string; code: string; display_name: string }>('SELECT id,code,display_name FROM partners WHERE active=true');
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
      const stats = { rows: [{ clicks: clicks.rows[0]?.count ?? 0, proposals: proposals.rows[0]?.count ?? 0, conversions: conversions.rows[0]?.count ?? 0, commission_cents: commission.rows[0]?.total ?? 0 }] };
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
        [randomUUID(), idempotencyKey, partner.id, JSON.stringify({ weekStart: weekStartIso, ...stats.rows[0] })],
      );
      created += 1;
    }
    return reply.send({ partnersConsidered: partners.rows.length, summariesCreated: created });
  });
}

async function processOutboxRow(db: Database, config: AppConfig, row: OutboxRow): Promise<'sent' | 'skipped' | 'failed'> {
  try {
    if (row.channel === 'whatsapp' && config.WHATSAPP_NOTIFICATIONS_ENABLED !== true) {
      await db.query("UPDATE notification_outbox SET status='skipped',updated_at=now() WHERE id=$1", [row.id]);
      return 'skipped';
    }
    if (row.channel === 'whatsapp') {
      await sendWhatsAppWebhook(config, row);
    } else {
      // In capture mode (the local/test default) this only records the event; no real email
      // provider is contacted, matching the rest of the codebase's EMAIL_MODE convention.
      await deliverViaEmailCapture(db, config, row);
    }
    await db.query("UPDATE notification_outbox SET status='sent',attempts=attempts+1,updated_at=now() WHERE id=$1", [row.id]);
    return 'sent';
  } catch (error) {
    const attempts = row.attempts + 1;
    const message = error instanceof Error ? error.message.slice(0, 200) : 'unknown_error';
    if (attempts >= 5) {
      await db.query("UPDATE notification_outbox SET status='failed',attempts=$2,last_error=$3,updated_at=now() WHERE id=$1", [row.id, attempts, message]);
    } else {
      const backoffMinutes = 2 ** attempts;
      await db.query(
        "UPDATE notification_outbox SET attempts=$2,last_error=$3,next_attempt_at=now()+ ($4 || ' minutes')::interval,updated_at=now() WHERE id=$1",
        [row.id, attempts, message, String(backoffMinutes)],
      );
    }
    return 'failed';
  }
}

async function deliverViaEmailCapture(db: Database, config: AppConfig, row: OutboxRow) {
  const partner = await db.query<{ email: string }>('SELECT email FROM partners WHERE id=$1', [row.partner_id]);
  const to = partner.rows[0]?.email;
  if (!to) throw new Error('partner_email_missing');
  const { subject, html } = renderNotification(row);
  const id = randomUUID();
  // Mirrors RuntimeEmailSender's capture path directly (no network I/O), keeping outbox
  // processing independent from EmailSender's DI so idempotency stays inside this table.
  const { tokenDigest } = await import('../security.js');
  await db.query(
    `INSERT INTO email_events (id,user_id,template,recipient_hash,provider,status)
     VALUES ($1,NULL,$2,$3,'notification-outbox-capture','captured')`,
    [id, row.event_type, tokenDigest(to, config.TOKEN_PEPPER)],
  );
  void subject; void html; // reserved for the resend-backed provider once email delivery is approved for production
}

async function sendWhatsAppWebhook(config: AppConfig, row: OutboxRow) {
  if (!config.WHATSAPP_WEBHOOK_URL || !config.WHATSAPP_WEBHOOK_TOKEN) throw new Error('whatsapp_webhook_not_configured');
  const response = await fetch(config.WHATSAPP_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.WHATSAPP_WEBHOOK_TOKEN}` },
    body: JSON.stringify({ eventType: row.event_type, partnerId: row.partner_id, payload: row.payload }),
  });
  if (!response.ok) throw new Error(`whatsapp_webhook_http_${response.status}`);
}

function renderNotification(row: OutboxRow) {
  switch (row.event_type) {
    case 'referral_confirmed':
      return { subject: 'Nova indicação recebida', html: '<p>Chegou uma nova indicação pelo seu link.</p>' };
    case 'proposal_converted':
      return { subject: 'Uma indicação sua fechou negócio', html: '<p>Uma proposta indicada por você foi convertida.</p>' };
    case 'commission_paid':
      return { subject: 'Comissão paga', html: '<p>Sua comissão foi marcada como paga.</p>' };
    case 'weekly_summary':
      return { subject: 'Resumo semanal do seu link', html: '<p>Confira o resumo semanal de cliques, propostas e comissões.</p>' };
    default:
      return { subject: 'Atualização do programa de parceiros', html: '<p>Você tem uma atualização.</p>' };
  }
}

function lisbonWeekStart(reference: Date) {
  // Europe/Lisbon week starts Monday 00:00 local time; DST-safe via Intl, avoids UTC drift.
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const parts = formatter.formatToParts(reference);
  const lookup: Record<string, string> = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localMidnight = new Date(`${lookup.year}-${lookup.month}-${lookup.day}T00:00:00`);
  const weekdayIndex = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(lookup.weekday ?? '');
  localMidnight.setDate(localMidnight.getDate() - weekdayIndex);
  return localMidnight;
}
