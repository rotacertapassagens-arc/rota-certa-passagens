import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from './config.js';
import type { Database } from './db.js';
import type { EmailSender } from './email.js';
import { RuntimeEmailSender } from './email.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerPlannerRoutes } from './routes/planner.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerPublicRoutes } from './routes/public.js';

export interface AppDependencies {
  db: Database;
  config: AppConfig;
  emailSender?: EmailSender;
}

export async function buildApp({ db, config, emailSender = new RuntimeEmailSender(db, config) }: AppDependencies) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : {
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.currentPassword', 'req.body.newPassword', 'req.body.token', 'res.headers.set-cookie'],
    },
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  await app.register(cookie);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const rawBody = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = rawBody;
    try {
      done(null, rawBody.length ? JSON.parse(rawBody) : {});
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-src https://www.google.com; connect-src 'self'");
    if (config.NODE_ENV === 'production') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    return payload;
  });

  registerPublicRoutes(app, db, config);
  registerAuthRoutes(app, db, config, emailSender);
  registerPlannerRoutes(app, db, config);
  registerAdminRoutes(app, db, config, emailSender);
  registerPaymentRoutes(app, db, config);

  await app.register(fastifyStatic, { root: join(process.cwd(), 'public'), prefix: '/' });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === 'GET' && request.headers.accept?.includes('text/html')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not_found' });
  });
  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error, requestId: request.id }, 'request failed');
    const statusCode = typeof error === 'object' && error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    const payload: { error: string; detail?: string } = { error: statusCode < 500 ? 'invalid_request' : 'internal_error' };
    if (config.NODE_ENV === 'test') payload.detail = error instanceof Error ? error.message : String(error);
    return reply.code(statusCode < 500 ? statusCode : 500).send(payload);
  });
  app.addHook('onClose', async () => db.close());
  return app;
}
