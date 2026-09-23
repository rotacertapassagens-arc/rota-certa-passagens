import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, n, r, p, saltText, hashText] = encoded.split('$');
  if (algorithm !== 'scrypt' || !n || !r || !p || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(saltText, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function randomEmailCode() {
  const value = randomBytes(4).readUInt32BE() % 1_000_000;
  return value.toString().padStart(6, '0');
}

export function tokenDigest(token: string, pepper: string) {
  return createHmac('sha256', pepper).update(token).digest('hex');
}

export function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqualText(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sanitizeUserAgent(value: string | undefined) {
  if (!value) return null;
  return value.replace(/[\r\n]/g, '').slice(0, 300);
}

const PARTNER_CODE_PATTERN = /^[a-z0-9-]{3,32}$/;

export function normalizePartnerCode(value: string) {
  return value.trim().toLowerCase();
}

export function isValidPartnerCode(value: string) {
  return PARTNER_CODE_PATTERN.test(value);
}

/**
 * Signs a first-party referral attribution value (partner code + capture timestamp) so the
 * client cannot forge or extend an attribution window by editing the cookie directly. The
 * signature is verified server-side on every read; an invalid signature is treated as no
 * attribution at all rather than trusting the raw value.
 */
export function signReferralToken(code: string, capturedAtMs: number, pepper: string) {
  const payload = `${code}.${capturedAtMs}`;
  return `${payload}.${tokenDigest(payload, pepper)}`;
}

export function verifyReferralToken(token: string, pepper: string): { code: string; capturedAtMs: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [code, capturedAtText, signature] = parts;
  const capturedAtMs = Number(capturedAtText);
  if (!code || !signature || !Number.isFinite(capturedAtMs) || capturedAtMs <= 0) return null;
  const expected = tokenDigest(`${code}.${capturedAtText}`, pepper);
  if (!safeEqualText(signature, expected)) return null;
  return { code, capturedAtMs };
}

function scryptAsync(password: string, salt: Buffer, keyLength: number, options: { N: number; r: number; p: number; maxmem: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}
