import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT sign/verify.
 *
 * Device tokens are long-lived and only ever carry a device id, so the whole
 * surface is two functions — not worth a dependency. Revocation is handled by
 * the device store, not by token expiry.
 */

export interface DeviceTokenClaims {
  /** Device id, matching a record in the device store. */
  sub: string;
  /** Issued at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. Absent on tokens issued before expiry existed. */
  exp?: number;
  /** Token type, so a device token can never be mistaken for another kind. */
  typ: 'device';
}

/**
 * Revocation is the primary control (delete the device record), but a token
 * that leaks off a lost pair of glasses should not stay valid forever if nobody
 * notices. Long enough that a working device is never surprised by it.
 */
export const DEVICE_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

export class JwtError extends Error {}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signDeviceToken(
  deviceId: string,
  secret: string,
  ttlSeconds = DEVICE_TOKEN_TTL_SECONDS,
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims: DeviceTokenClaims = {
    sub: deviceId,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    typ: 'device',
  };
  const body = base64url(JSON.stringify(claims));
  return `${header}.${body}.${sign(`${header}.${body}`, secret)}`;
}

export function verifyDeviceToken(token: string, secret: string): DeviceTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('Malformed token');

  const [header, body, signature] = parts as [string, string, string];
  const expected = sign(`${header}.${body}`, secret);

  // Signature first: nothing below this line parses attacker-chosen JSON that
  // has not already been proven to come from us.
  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    throw new JwtError('Bad signature');
  }

  let claims: DeviceTokenClaims;
  try {
    // We only ever mint HS256, and only HS256 is verified above. Reject
    // anything else outright rather than leaving the header unread.
    const algorithm = (JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: unknown }).alg;
    if (algorithm !== 'HS256') throw new JwtError('Unsupported token algorithm');
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DeviceTokenClaims;
  } catch (error) {
    if (error instanceof JwtError) throw error;
    throw new JwtError('Malformed claims');
  }

  if (claims.typ !== 'device' || typeof claims.sub !== 'string' || !claims.sub) {
    throw new JwtError('Not a device token');
  }
  // Tokens minted before `exp` existed stay valid; revoking still kills them.
  if (claims.exp !== undefined) {
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
      throw new JwtError('Malformed claims');
    }
    if (Date.now() / 1000 >= claims.exp) throw new JwtError('This pairing has expired. Pair again.');
  }
  return claims;
}
