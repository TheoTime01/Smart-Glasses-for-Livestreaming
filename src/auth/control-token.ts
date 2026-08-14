import { timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

/**
 * The shared secret guarding /control and everything it can reach.
 *
 * One implementation for both route plugins: `/api/streams*` hands out RTMP
 * credentials and `/api/pair` mints pairing codes, so a check that drifts
 * between the two is a hole in whichever half was forgotten.
 */

/** Constant-time compare. Length is not secret — a mismatch leaks it anyway. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface ControlTokenOptions {
  /**
   * Also accept `?control_token=`. Off by default: query strings end up in
   * access logs, proxy logs and `Referer` headers. Only the QR `<img>` needs
   * it, because an image request cannot carry a header.
   */
  allowQueryParam?: boolean;
}

export const UNAUTHORIZED = {
  error: 'unauthorized',
  message: 'Missing or invalid control token.',
} as const;

export function hasControlToken(
  request: FastifyRequest,
  expected: string | undefined,
  { allowQueryParam = false }: ControlTokenOptions = {},
): boolean {
  // Unset means the guard is off — startup warns about it loudly.
  if (!expected) return true;

  const header = request.headers['x-control-token'];
  if (typeof header === 'string') return safeEqual(header, expected);

  if (!allowQueryParam) return false;
  const fromQuery = (request.query as Record<string, unknown> | undefined)?.control_token;
  return typeof fromQuery === 'string' && safeEqual(fromQuery, expected);
}
