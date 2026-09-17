import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { audit, requireMutationAuth } from '../auth.js';
import { safeEqualText, sha256 } from '../security.js';

export function registerPaymentRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  app.post('/api/payments/checkout', async (request, reply) => {
    const auth = await requireMutationAuth(db, config, request, reply);
    if (!auth) return;
    const parsed = z.object({ planCode: z.literal('planner-30d') }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_plan' });
    if (config.PAYMENTS_MODE !== 'stripe_sandbox' || !config.STRIPE_SECRET_KEY) return reply.code(503).send({ error: 'sandbox_not_configured' });
    if (!config.STRIPE_SECRET_KEY.startsWith('sk_test_')) return reply.code(503).send({ error: 'sandbox_not_configured' });
    const plans = await db.query<{ id: string; name: string; price_cents: number; currency: string; duration_days: number }>(
      'SELECT id,name,price_cents,currency,duration_days FROM plans WHERE code=$1 AND active=true AND checkout_enabled=true',
      [parsed.data.planCode],
    );
    const plan = plans.rows[0];
    if (!plan) return reply.code(400).send({ error: 'invalid_plan' });
    const paymentId = randomUUID();
    await db.query(
      `INSERT INTO payments (id,user_id,plan_id,amount_cents,currency,status,provider)
       VALUES ($1,$2,$3,$4,$5,'pending','stripe_sandbox')`,
      [paymentId, auth.userId, plan.id, plan.price_cents, plan.currency],
    );
    const params = new URLSearchParams({
      mode: 'payment',
      success_url: `${config.APP_ORIGIN}/#/pagamento-sucesso?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.APP_ORIGIN}/#/cliente?plan=plus&canceled=1`,
      customer_email: auth.email,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': plan.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(plan.price_cents),
      'line_items[0][price_data][product_data][name]': plan.name,
      'metadata[payment_id]': paymentId,
      'metadata[user_id]': auth.userId,
      'metadata[plan_id]': plan.id,
    });
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const session = (await response.json().catch(() => ({}))) as { id?: string; url?: string };
    if (!response.ok || !session.id || !session.url) {
      await db.query("UPDATE payments SET status='failed',updated_at=now() WHERE id=$1", [paymentId]);
      return reply.code(502).send({ error: 'sandbox_checkout_failed' });
    }
    await db.query("UPDATE payments SET status='processing',provider_reference=$1,updated_at=now() WHERE id=$2", [session.id, paymentId]);
    await audit(db, config, request, 'payment.sandbox_checkout_created', auth.userId, 'payment', paymentId);
    return reply.send({ url: session.url });
  });

  app.post('/api/payments/stripe-webhook', async (request, reply) => {
    const raw = request.rawBody;
    const signature = request.headers['stripe-signature'];
    if (!raw || typeof signature !== 'string' || !config.STRIPE_WEBHOOK_SECRET) return reply.code(400).send({ error: 'invalid_signature' });
    if (!verifyStripeSignature(raw, signature, config.STRIPE_WEBHOOK_SECRET)) return reply.code(400).send({ error: 'invalid_signature' });
    const event = z.object({ id: z.string(), type: z.string(), data: z.object({ object: z.record(z.string(), z.unknown()) }) }).safeParse(request.body);
    if (!event.success) return reply.code(400).send({ error: 'invalid_payload' });
    const inserted = await db.query(
      `INSERT INTO webhook_events (id,provider,provider_event_id,event_type,payload_sha256,status)
       VALUES ($1,'stripe_sandbox',$2,$3,$4,'received') ON CONFLICT (provider,provider_event_id) DO NOTHING`,
      [randomUUID(), event.data.id, event.data.type, sha256(raw)],
    );
    if (!inserted.rowCount) return reply.send({ ok: true });
    if (event.data.type !== 'checkout.session.completed') {
      await db.query("UPDATE webhook_events SET status='ignored',processed_at=now() WHERE provider='stripe_sandbox' AND provider_event_id=$1", [event.data.id]);
      return reply.send({ ok: true });
    }
    const session = event.data.data.object;
    const metadata = (session.metadata ?? {}) as Record<string, unknown>;
    const paymentId = typeof metadata.payment_id === 'string' ? metadata.payment_id : '';
    const paymentStatus = session.payment_status;
    if (!paymentId || paymentStatus !== 'paid') {
      await db.query("UPDATE webhook_events SET status='ignored',processed_at=now() WHERE provider='stripe_sandbox' AND provider_event_id=$1", [event.data.id]);
      return reply.send({ ok: true });
    }
    await db.transaction(async (tx) => {
      const payments = await tx.query<{ user_id: string; plan_id: string; duration_days: number }>(
        `SELECT p.user_id,p.plan_id,pl.duration_days FROM payments p JOIN plans pl ON pl.id=p.plan_id
          WHERE p.id=$1 AND p.provider='stripe_sandbox' FOR UPDATE`,
        [paymentId],
      );
      const payment = payments.rows[0];
      if (!payment) throw new Error('Webhook referenced unknown payment');
      await tx.query("UPDATE payments SET status='paid',updated_at=now() WHERE id=$1", [paymentId]);
      const already = await tx.query('SELECT 1 FROM subscriptions WHERE provider_reference=$1 LIMIT 1', [paymentId]);
      if (!already.rowCount) {
        const endsAt = new Date(Date.now() + payment.duration_days * 24 * 60 * 60 * 1000);
        await tx.query(
          `INSERT INTO subscriptions (id,user_id,plan_id,status,starts_at,ends_at,provider,provider_reference)
           VALUES ($1,$2,$3,'active',now(),$4,'stripe_sandbox',$5)`,
          [randomUUID(), payment.user_id, payment.plan_id, endsAt, paymentId],
        );
      }
      await tx.query("UPDATE webhook_events SET status='processed',processed_at=now() WHERE provider='stripe_sandbox' AND provider_event_id=$1", [event.data.id]);
    });
    return reply.send({ ok: true });
  });
}

function verifyStripeSignature(payload: string, header: string, secret: string) {
  const values = header.split(',').map((part) => part.split('=', 2));
  const timestamp = values.find(([key]) => key === 't')?.[1];
  const signatures = values.filter(([key]) => key === 'v1').map(([, value]) => value ?? '');
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = sha256Hmac(`${timestamp}.${payload}`, secret);
  return signatures.some((signature) => safeEqualText(signature, expected));
}

function sha256Hmac(value: string, secret: string) {
  return requireHmac(secret, value);
}

function requireHmac(secret: string, value: string) {
  return createHmac('sha256', secret).update(value).digest('hex');
}
