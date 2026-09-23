import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import type { EmailSender } from '../email.js';
import { enforceRateLimit } from '../auth.js';
import { normalizeEmail, tokenDigest } from '../security.js';
import { resolveAttribution } from './partners.js';

const quoteSchema = z.object({
  type: z.literal('quote'),
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(254),
  phone: z.string().trim().min(8).max(30).regex(/^\+?[0-9 ()-]+$/),
  origem: z.string().trim().min(2).max(160),
  destino: z.string().trim().min(2).max(160),
  ida: z.string().date(),
  volta: z.string().date().optional().or(z.literal('')),
  adults: z.coerce.number().int().min(1).max(20),
  children: z.coerce.number().int().min(0).max(20),
  infants: z.coerce.number().int().min(0).max(20),
  tipo: z.enum(['Ida e volta', 'Somente ida']),
  cabinClass: z.enum(['Econômica', 'Premium Economy', 'Executiva', 'Primeira classe']),
  baggage: z.enum(['Somente item pessoal', 'Bagagem de mão', 'Bagagem despachada', 'Ainda não sei']),
  flexibility: z.enum(['Datas fixas', 'Até 3 dias', 'Até 7 dias', 'Datas flexíveis']),
  paymentPreference: z.enum(['Dinheiro', 'Milhas', 'Dinheiro ou milhas']),
  observacoes: z.string().trim().max(3000).optional(),
  contactConsent: z.literal(true),
  howHeard: z.enum(['Instagram', 'Indicação de um amigo', 'Indicação de um parceiro/influenciador', 'Google', 'Outro']).optional(),
  referralCode: z.string().trim().max(64).optional(),
}).superRefine((data, ctx) => {
  if (data.tipo === 'Ida e volta' && !data.volta) ctx.addIssue({ code: 'custom', path: ['volta'], message: 'return_required' });
  if (data.volta && data.volta < data.ida) ctx.addIssue({ code: 'custom', path: ['volta'], message: 'return_before_outbound' });
});

export function registerPublicRoutes(app: FastifyInstance, db: Database, config: AppConfig, emailSender: EmailSender) {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/geo', async (request) => {
    const raw = request.headers['cf-ipcountry'] ?? request.headers['x-country-code'] ?? '';
    const country = typeof raw === 'string' && /^[A-Z]{2}$/.test(raw) ? raw : '';
    return { country };
  });

  app.post('/api/lead', async (request, reply) => {
    const parsed = quoteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const data = parsed.data;
    const email = normalizeEmail(data.email);
    if (!(await enforceRateLimit(db, config, request, 'flight_quote', email, 4, 30 * 60))) {
      return reply.code(429).send({ error: 'try_again_later' });
    }

    const id = randomUUID();
    const protocol = makeProtocol(id);
    const phone = normalizePhone(data.phone);
    const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000);

    // URL/cookie attribution always outranks a manually typed code (fraud resistance + trust
    // in the partner's own tracked link). The client never gets to pick the internal partner id.
    const manualCode = data.howHeard === 'Indicação de um parceiro/influenciador' ? data.referralCode : undefined;
    const attribution = await resolveAttribution(db, config, request, manualCode);

    await db.query(
      `INSERT INTO lead_requests
        (id,kind,protocol,customer_name,customer_email,customer_phone,origin,destination,outbound_on,return_on,
         passengers,adults,children,infants,trip_type,cabin_class,baggage,date_flexibility,payment_preference,
         notes,contact_consent,status,deadline_at,ip_hash,updated_at,
         partner_id,referral_code_snapshot,referral_source,referral_captured_at,attribution_expires_at)
       VALUES ($1,'flight_quote',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,true,'new',$20,$21,now(),
               $22,$23,$24,$25,$26)`,
      [id, protocol, data.name, email, phone, data.origem, data.destino, data.ida, data.volta || null,
       `${data.adults} adulto(s), ${data.children} criança(s), ${data.infants} bebê(s)`, data.adults, data.children,
       data.infants, data.tipo, data.cabinClass, data.baggage, data.flexibility, data.paymentPreference,
       data.observacoes || null, deadline, tokenDigest(request.ip, config.RATE_LIMIT_SECRET),
       attribution?.partnerId ?? null, attribution?.code ?? null, attribution?.source ?? 'none',
       attribution?.capturedAt ?? null, attribution?.expiresAt ?? null],
    );

    if (attribution) {
      await db.query(
        `INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload)
         VALUES ($1,$2,'referral_confirmed',$3,$4::jsonb) ON CONFLICT (idempotency_key) DO NOTHING`,
        [randomUUID(), `referral_confirmed:${id}`, attribution.partnerId, JSON.stringify({ leadId: id, protocol, destination: data.destino })],
      );
    }

    const masterRows = await db.query<{ id: string; email: string }>(
      `SELECT u.id,u.email FROM users u JOIN user_roles r ON r.user_id=u.id
        WHERE r.role='master' AND u.status='active' AND u.email_verified_at IS NOT NULL`,
    );
    const route = `${data.origem} → ${data.destino}`;
    const customerHtml = `<p>Olá, ${escapeHtml(data.name)}.</p><p>Recebemos sua solicitação de proposta para <strong>${escapeHtml(route)}</strong>.</p><p>Protocolo: <strong>${protocol}</strong></p><p>Nossa equipe analisará as melhores opções e responderá por e-mail em até 48 horas.</p><p>Rota Certa Passagens</p>`;
    const customerText = `Olá, ${data.name}. Recebemos sua solicitação para ${route}. Protocolo: ${protocol}. Nossa equipe responderá por e-mail em até 48 horas.`;
    const adminUrl = `${config.APP_ORIGIN.replace(/\/$/, '')}/admin.html`;
    const masterHtml = `<p>Nova proposta de voo recebida.</p><p><strong>${protocol}</strong> — ${escapeHtml(route)}</p><p>Cliente: ${escapeHtml(data.name)} (${escapeHtml(email)})</p><p>Prazo de atendimento: ${deadline.toLocaleString('pt-BR', { timeZone: 'Europe/Lisbon' })}</p><p><a href="${escapeHtml(adminUrl)}">Abrir Central de Propostas</a></p>`;
    const masterText = `Nova proposta ${protocol}: ${route}. Cliente: ${data.name} (${email}). Prazo: ${deadline.toISOString()}. Painel: ${adminUrl}`;

    const customerResult = await Promise.allSettled([
      emailSender.send({ userId: null, to: email, template: 'flight_quote_customer', subject: `Recebemos sua solicitação ${protocol}`, html: customerHtml, text: customerText }),
    ]);
    const masterResults = await Promise.allSettled(masterRows.rows.map((master) => emailSender.send({
      userId: master.id, to: master.email, template: 'flight_quote_master', subject: `Nova proposta de voo ${protocol}`,
      html: masterHtml, text: masterText,
    })));

    return reply.code(201).send({
      ok: true,
      protocol,
      responseDeadlineHours: 48,
      confirmationEmailSent: customerResult[0]?.status === 'fulfilled',
      mastersNotified: masterResults.filter((result) => result.status === 'fulfilled').length,
    });
  });
}

function makeProtocol(id: string) {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `RC-${date}-${id.replaceAll('-', '').slice(0, 6).toUpperCase()}`;
}

function normalizePhone(value: string) {
  const trimmed = value.trim();
  return `${trimmed.startsWith('+') ? '+' : ''}${trimmed.replace(/\D/g, '')}`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}
