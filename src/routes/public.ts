import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { enforceRateLimit } from '../auth.js';
import { tokenDigest } from '../security.js';

const leadSchema = z.object({
  type: z.enum(['quote', 'planning']).default('quote'),
  origem: z.string().trim().max(160).optional(),
  destino: z.string().trim().max(160).optional(),
  ida: z.string().date().optional().or(z.literal('')),
  volta: z.string().date().optional().or(z.literal('')),
  passageiros: z.string().trim().max(80).optional(),
  tipo: z.string().trim().max(80).optional(),
  observacoes: z.string().trim().max(3000).optional(),
  observacoesCurtas: z.string().trim().max(500).optional(),
});

export function registerPublicRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/geo', async (request) => {
    const raw = request.headers['cf-ipcountry'] ?? request.headers['x-country-code'] ?? '';
    const country = typeof raw === 'string' && /^[A-Z]{2}$/.test(raw) ? raw : '';
    return { country };
  });

  app.post('/api/lead', async (request, reply) => {
    const parsed = leadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!(await enforceRateLimit(db, config, request, 'lead', parsed.data.destino ?? '', 6, 30 * 60))) {
      return reply.code(429).send({ error: 'try_again_later' });
    }
    await db.query(
      `INSERT INTO lead_requests
        (id,kind,origin,destination,outbound_on,return_on,passengers,trip_type,notes,ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        randomUUID(),
        parsed.data.type === 'planning' ? 'planning' : 'flight_quote',
        parsed.data.origem || null,
        parsed.data.destino || null,
        parsed.data.ida || null,
        parsed.data.volta || null,
        parsed.data.passageiros || null,
        parsed.data.tipo || null,
        [parsed.data.observacoesCurtas, parsed.data.observacoes].filter(Boolean).join('\n') || null,
        tokenDigest(request.ip, config.RATE_LIMIT_SECRET),
      ],
    );
    return reply.code(201).send({ ok: true });
  });
}
