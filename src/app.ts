import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { ApiVideoClient } from './apivideo/client.js';
import { ApiVideoError } from './apivideo/types.js';
import { devicesStorePath, PairingService } from './auth/pairing.js';
import type { AppConfig } from './config.js';
import { ProbeStore } from './probe/store.js';
import { pairingRoutes } from './routes/pairing.js';
import { probeRoutes } from './routes/probe.js';
import { streamRoutes } from './routes/streams.js';
import { StreamService } from './streams/service.js';

/** Repo root, whether we run from `src` (tsx) or `dist` (node). */
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const publicDir = join(rootDir, 'public');

export interface BuildAppOptions {
  config: AppConfig;
  logger?: boolean;
  /** Injectable for tests so no real api.video call is ever made. */
  fetchImpl?: typeof fetch;
}

export async function buildApp({ config, logger = true, fetchImpl }: BuildAppOptions): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger,
    // The device sits behind whatever tunnel/proxy is in front of us, so trust
    // the forwarding headers for `request.ip` in probe reports.
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  /**
   * Registered on the root instance, not inside the stream plugin: the glasses
   * routes call api.video too, and an ApiVideoError escaping to Fastify's
   * default handler would reach the HUD as an opaque 500.
   */
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiVideoError) {
      request.log.error({ err: error, status: error.status, detail: error.detail }, 'api.video call failed');
      const status = error.status === 404 ? 404 : error.status === 400 ? 400 : 502;
      return reply.code(status).send({
        error: 'api_video_error',
        message: error.message,
        detail: error.detail || undefined,
      });
    }
    // Fastify's own errors (bad JSON, payload too large) carry a usable status.
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(status).send({
      error: status === 500 ? 'internal_error' : (error.code ?? 'request_error'),
      message: status === 500 ? 'Unexpected server error.' : error.message,
    });
  });

  const store = new ProbeStore(config.probeLogDir, config.probeMemoryLimit);
  await store.load();

  await fastify.register(fastifyWebsocket);

  await fastify.register(fastifyStatic, {
    root: publicDir,
    // The probe is iterated on a device with an opaque cache. Never serve a
    // stale build while we are still finding out what the runtime supports.
    // @fastify/static v10 hands this callback a FastifyReply (v8 passed a raw
    // ServerResponse, which had setHeader instead).
    setHeaders(reply) {
      reply.header('cache-control', 'no-store');
    },
  });

  const localMp4 = join(publicDir, 'samples', 'sample.mp4');
  const localMp4Path = existsSync(localMp4) ? '/samples/sample.mp4' : null;

  await fastify.register(probeRoutes, { config, store, localMp4Path });

  // The probe (M0) must stay usable on a box with no api.video credentials, so
  // a missing key disables the stream API rather than blocking startup. A key
  // that is present but wrong still fails loudly — see server.ts.
  let service: StreamService | null = null;
  if (config.apiVideoKey) {
    const client = new ApiVideoClient({
      apiKey: config.apiVideoKey,
      environment: config.apiVideoEnv,
      ...(config.apiVideoBaseUrl ? { baseUrl: config.apiVideoBaseUrl } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    if (config.apiVideoBaseUrl) {
      fastify.log.warn({ baseUrl: config.apiVideoBaseUrl }, 'API_VIDEO_BASE_URL override in use — not talking to api.video');
    }
    service = new StreamService(client, config.statusCacheTtlMs);
  } else {
    fastify.log.warn('API_VIDEO_KEY is not set — /api/streams and /control are disabled (M0 probe still works)');
  }
  if (!config.controlToken) {
    fastify.log.warn('CONTROL_TOKEN is not set — /api/streams is unauthenticated; do not expose it publicly');
  }

  await fastify.register(streamRoutes, { config, service });

  // Same trade-off as the api.video key: a missing JWT_SECRET disables pairing
  // rather than blocking a probe-only deployment.
  let pairing: PairingService | null = null;
  if (config.jwtSecret) {
    pairing = new PairingService(config.jwtSecret, config.pairingCodeTtl, devicesStorePath(config.dataDir));
    await pairing.load();
  } else {
    fastify.log.warn('JWT_SECRET is not set — pairing and the glasses app are disabled');
  }

  await fastify.register(pairingRoutes, { config, pairing, service });

  // Reports what is actually wired up. A hardcoded milestone string would start
  // lying the moment the next one lands.
  fastify.get('/api/health', async () => ({
    status: 'ok',
    apiVideo: service ? { configured: true, environment: config.apiVideoEnv } : { configured: false },
    pairing: { configured: Boolean(pairing) },
    controlTokenRequired: Boolean(config.controlToken),
    sampleMp4Origin: localMp4Path ? 'same-origin' : 'cross-origin',
  }));

  return fastify;
}
