import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  TOKEN_PEPPER: z.string().min(32),
  RATE_LIMIT_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(720),
  COOKIE_SECURE: booleanString.default(false),
  EMAIL_MODE: z.enum(['capture', 'resend']).default('capture'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Rota Certa Passagens <no-reply@example.invalid>'),
  PAYMENTS_MODE: z.enum(['disabled', 'stripe_sandbox']).default('disabled'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  MASTER_BOOTSTRAP_TOKEN: z.string().min(24).optional(),
  WHATSAPP_NOTIFICATIONS_ENABLED: booleanString.default(false),
  WHATSAPP_WEBHOOK_URL: z.string().url().optional(),
  WHATSAPP_WEBHOOK_TOKEN: z.string().min(16).optional(),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = schema.parse(env);
  if (config.NODE_ENV === 'production' && !config.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be true in production');
  }
  if (config.PAYMENTS_MODE === 'stripe_sandbox' && config.STRIPE_SECRET_KEY && !config.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    throw new Error('Only Stripe sandbox keys are accepted');
  }
  return config;
}
