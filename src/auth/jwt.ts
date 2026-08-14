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
  /** Token type, so a device token can never be mistaken for another kind. */
  typ: 'device';
}

export class JwtError extends Error {}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signDeviceToken(deviceId: string, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims: DeviceTokenClaims = {
    sub: deviceId,
    iat: Math.floor(Date.now() / 1000),
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

  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    throw new JwtError('Bad signature');
  }

  let claims: DeviceTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DeviceTokenClaims;
  } catch {
    throw new JwtError('Malformed claims');
  }

  if (claims.typ !== 'device' || typeof claims.sub !== 'string' || !claims.sub) {
    throw new JwtError('Not a device token');
  }
  return claims;
}
