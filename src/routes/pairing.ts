import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { hasControlToken, UNAUTHORIZED } from '../auth/control-token.js';
import { PairingError, type PairingService } from '../auth/pairing.js';
import type { AppConfig } from '../config.js';
import type { StreamService } from '../streams/service.js';

interface PairingRoutesOptions {
  config: AppConfig;
  /** null when JWT_SECRET is unset — pairing then answers 503. */
  pairing: PairingService | null;
  service: StreamService | null;
}

/**
 * A 6-digit code is only 10^6 wide, so claiming is rate limited per client
 * (PAIR_CLAIM_LIMIT per minute). In-memory is fine: this process is the only
 * thing that mints codes.
 */
const CLAIM_WINDOW_MS = 60_000;

/**
 * Ceiling on tracked clients. Without one, an IP that ever tried to claim stays
 * in the map for the life of the process — a slow leak any open internet host
 * will find.
 */
const MAX_TRACKED_CLIENTS = 5_000;

export const pairingRoutes: FastifyPluginAsync<PairingRoutesOptions> = async (fastify, options) => {
  const { config, pairing, service } = options;
  const claimAttempts = new Map<string, number[]>();

  function requireControlToken(request: FastifyRequest): boolean {
    return hasControlToken(request, config.controlToken);
  }

  fastify.addHook('preHandler', async (_request, reply) => {
    if (pairing) return;
    return reply.code(503).send({
      error: 'not_configured',
      message: 'JWT_SECRET is not set. Add it to .env and restart to enable pairing.',
    });
  });

  // The hook above answers before any handler runs when pairing is
  // unconfigured, so this is the single place that null is discharged.
  const pairingService = pairing as PairingService;

  /** Attempts inside the current window, after dropping everything stale. */
  function recentAttempts(ip: string, now: number): number[] {
    for (const [client, attempts] of claimAttempts) {
      const newest = attempts[attempts.length - 1] ?? 0;
      if (now - newest >= CLAIM_WINDOW_MS) claimAttempts.delete(client);
    }
    // Still full of live entries: evict the least recently inserted rather than
    // locking everyone out.
    while (claimAttempts.size >= MAX_TRACKED_CLIENTS) {
      const oldest = claimAttempts.keys().next();
      if (oldest.done || oldest.value === ip) break;
      claimAttempts.delete(oldest.value);
    }
    return (claimAttempts.get(ip) ?? []).filter((at) => now - at < CLAIM_WINDOW_MS);
  }

  /** Control page mints a code for the wearer to type. */
  fastify.post('/api/pair', async (request, reply) => {
    if (!requireControlToken(request)) return reply.code(401).send(UNAUTHORIZED);
    const created = pairingService.createCode();
    request.log.info({ expiresAt: created.expiresAt }, 'pairing code issued');
    return reply.code(201).send(created);
  });

  /** The glasses exchange the code for a device token. No control token here. */
  fastify.post<{ Body: { code?: unknown; deviceName?: unknown } }>(
    '/api/pair/claim',
    async (request, reply) => {
      const now = Date.now();
      const recent = recentAttempts(request.ip, now);
      if (recent.length >= config.pairClaimLimit) {
        return reply
          .code(429)
          .send({ error: 'too_many_attempts', message: 'Too many attempts. Wait a minute and try again.' });
      }
      recent.push(now);
      claimAttempts.set(request.ip, recent);

      const body = request.body ?? {};
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!/^\d{6}$/.test(code)) {
        return reply.code(400).send({ error: 'invalid_request', message: 'code must be 6 digits' });
      }
      const deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim() : 'Glasses';

      try {
        const { token, device } = await pairingService.claim(code, deviceName);
        request.log.info({ deviceId: device.id, name: device.name }, 'device paired');
        return reply.code(201).send({ token, device });
      } catch (error) {
        if (error instanceof PairingError) {
          return reply.code(400).send({ error: error.reason, message: error.message });
        }
        throw error;
      }
    },
  );

  fastify.get('/api/devices', async (request, reply) => {
    if (!requireControlToken(request)) return reply.code(401).send(UNAUTHORIZED);
    return { devices: pairingService.listDevices(), pendingCodes: pairingService.pendingCount() };
  });

  fastify.delete<{ Params: { id: string } }>('/api/devices/:id', async (request, reply) => {
    if (!requireControlToken(request)) return reply.code(401).send(UNAUTHORIZED);
    const removed = await pairingService.revoke(request.params.id);
    if (!removed) return reply.code(404).send({ error: 'not_found', message: 'No such device.' });
    request.log.info({ deviceId: request.params.id }, 'device revoked');
    return reply.code(204).send();
  });

  /* ------------------------------------------------- glasses-scoped surface */

  /**
   * Everything below authenticates with a device token instead of the control
   * token, and deliberately omits ingest credentials: the glasses never need a
   * stream key and must not be able to leak one.
   */
  async function authenticate(request: FastifyRequest): Promise<{ ok: true } | { ok: false; body: object }> {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      return { ok: false, body: { error: 'unauthorized', message: 'Pair this device first.' } };
    }
    try {
      await pairingService.authenticate(token);
      return { ok: true };
    } catch (error) {
      if (error instanceof PairingError) {
        return { ok: false, body: { error: error.reason, message: error.message } };
      }
      throw error;
    }
  }

  fastify.get('/api/glasses/streams', async (request, reply) => {
    const auth = await authenticate(request);
    if (!auth.ok) return reply.code(401).send(auth.body);
    if (!service) {
      return reply.code(503).send({ error: 'not_configured', message: 'API_VIDEO_KEY is not set.' });
    }

    const streams = await service.list();
    return {
      streams: streams.map((stream) => ({
        id: stream.id,
        name: stream.name,
        broadcasting: stream.broadcasting,
        public: stream.public,
      })),
    };
  });

  fastify.get<{ Params: { id: string } }>('/api/glasses/streams/:id/playback', async (request, reply) => {
    const auth = await authenticate(request);
    if (!auth.ok) return reply.code(401).send(auth.body);
    if (!service) {
      return reply.code(503).send({ error: 'not_configured', message: 'API_VIDEO_KEY is not set.' });
    }

    reply.header('cache-control', 'no-store');
    return service.playback(request.params.id);
  });
};
