import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit capability token, URL-safe. */
export const newToken = () => randomBytes(32).toString('base64url');
/** Opaque identifier (96 bits). */
export const newId = () => randomBytes(12).toString('hex');

export const hashToken = (token: string) => createHash('sha256').update(`common-ground:v1:${token}`).digest('hex');

export function tokenMatches(token: string | undefined, hash: string | undefined): boolean {
  if (!token || !hash || token.length > 200) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Stable JSON (sorted keys) for digests. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 32);
