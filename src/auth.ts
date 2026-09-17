import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import type { Database } from './db.js';
import { randomToken, sanitizeUserAgent, tokenDigest } from './security.js';

export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  roles: string[];
  csrfToken: string;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  email: string;
  display_name: string;
  csrf_token_hash: string;
}

export function sessionCookieName(config: AppConfig) {
  return config.COOKIE_SECURE ? '__Host-rc_session' : 'rc_session';
}

export async function createSession(
  db: Database,
  config: AppConfig,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
) {
  const sessionToken = randomToken();
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000);
  await db.query(
    `INSERT INTO sessions
      (id,user_id,token_hash,csrf_token_hash,expires_at,ip_hash,user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      randomUUID(),
      userId,
      tokenDigest(sessionToken, config.TOKEN_PEPPER),
      tokenDigest(csrfToken, config.TOKEN_PEPPER),
      expiresAt,
      tokenDigest(request.ip, config.RATE_LIMIT_SECRET),
      sanitizeUserAgent(request.headers['user-agent']),
    ],
  );
  reply.setCookie(sessionCookieName(config), sessionToken, {
    path: '/',
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    expires: expiresAt,
  });
  reply.setCookie('rc_csrf', csrfToken, {
    path: '/',
    httpOnly: false,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    expires: expiresAt,
  });
  return csrfToken;
}

export async function getAuth(
  db: Database,
  config: AppConfig,
  request: FastifyRequest,
): Promise<AuthContext | null> {
  const token = request.cookies[sessionCookieName(config)];
  if (!token) return null;
  const result = await db.query<SessionRow>(
    `SELECT s.id AS session_id, u.id AS user_id, u.email, p.display_name,
            s.csrf_token_hash
       FROM sessions s
       JOIN users u ON u.id=s.user_id
       JOIN profiles p ON p.user_id=u.id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.status='active'`,
    [tokenDigest(token, config.TOKEN_PEPPER)],
  );
  const row = result.rows[0];
  if (!row) return null;
  const roleResult = await db.query<{ role: string }>('SELECT role FROM user_roles WHERE user_id=$1 ORDER BY role', [row.user_id]);
  const csrfToken = request.headers['x-csrf-token'];
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    roles: roleResult.rows.map(({ role }) => role),
    csrfToken: typeof csrfToken === 'string' ? csrfToken : '',
  };
}

export async function requireAuth(
  db: Database,
  config: AppConfig,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const auth = await getAuth(db, config, request);
  if (!auth) {
    await reply.code(401).send({ error: 'authentication_required' });
    return null;
  }
  return auth;
}

export async function requireMutationAuth(
  db: Database,
  config: AppConfig,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const auth = await requireAuth(db, config, request, reply);
  if (!auth) return null;
  const origin = request.headers.origin;
  if (origin && origin !== config.APP_ORIGIN) {
    await reply.code(403).send({ error: 'origin_rejected' });
    return null;
  }
  if (!auth.csrfToken || tokenDigest(auth.csrfToken, config.TOKEN_PEPPER) !== (await csrfHash(db, auth.sessionId))) {
    await reply.code(403).send({ error: 'csrf_rejected' });
    return null;
  }
  return auth;
}

async function csrfHash(db: Database, sessionId: string) {
  const result = await db.query<{ csrf_token_hash: string }>('SELECT csrf_token_hash FROM sessions WHERE id=$1', [sessionId]);
  return result.rows[0]?.csrf_token_hash ?? '';
}

export async function enforceRateLimit(
  db: Database,
  config: AppConfig,
  request: FastifyRequest,
  scope: string,
  subject: string,
  limit: number,
  windowSeconds: number,
) {
  const keyHash = tokenDigest(`${scope}|${request.ip}|${subject}`, config.RATE_LIMIT_SECRET);
  return db.transaction(async (tx) => {
    const selected = await tx.query<{ window_started_at: Date; attempts: number; blocked_until: Date | null }>(
      'SELECT window_started_at,attempts,blocked_until FROM rate_limit_buckets WHERE key_hash=$1 FOR UPDATE',
      [keyHash],
    );
    const row = selected.rows[0];
    const now = Date.now();
    if (row?.blocked_until && new Date(row.blocked_until).getTime() > now) return false;
    const windowExpired = !row || now - new Date(row.window_started_at).getTime() >= windowSeconds * 1000;
    const attempts = windowExpired ? 1 : row.attempts + 1;
    const blockedUntil = attempts > limit ? new Date(now + windowSeconds * 1000) : null;
    await tx.query(
      `INSERT INTO rate_limit_buckets (key_hash,window_started_at,attempts,blocked_until)
       VALUES ($1,now(),$2,$3)
       ON CONFLICT (key_hash) DO UPDATE SET
         window_started_at=CASE WHEN $4 THEN now() ELSE rate_limit_buckets.window_started_at END,
         attempts=$2,
         blocked_until=$3`,
      [keyHash, attempts, blockedUntil, windowExpired],
    );
    return attempts <= limit;
  });
}

export async function audit(
  db: Database,
  config: AppConfig,
  request: FastifyRequest,
  action: string,
  actorUserId: string | null,
  targetType: string | null = null,
  targetId: string | null = null,
  metadata: Record<string, string | number | boolean> = {},
) {
  await db.query(
    `INSERT INTO audit_events (id,actor_user_id,action,target_type,target_id,ip_hash,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [randomUUID(), actorUserId, action, targetType, targetId, tokenDigest(request.ip, config.RATE_LIMIT_SECRET), JSON.stringify(metadata)],
  );
}
