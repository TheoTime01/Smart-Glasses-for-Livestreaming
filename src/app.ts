import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { ProbeStore } from './probe/store.js';
import { probeRoutes } from './routes/probe.js';

/** Repo root, whether we run from `src` (tsx) or `dist` (node). */
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const publicDir = join(rootDir, 'public');

export interface BuildAppOptions {
  config: AppConfig;
  logger?: boolean;
}

export async function buildApp({ config, logger = true }: BuildAppOptions): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger,
    // The device sits behind whatever tunnel/proxy is in front of us, so trust
    // the forwarding headers for `request.ip` in probe reports.
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  const store = new ProbeStore(config.probeLogDir, config.probeMemoryLimit);
  await store.load();

  await fastify.register(fastifyWebsocket);

  await fastify.register(fastifyStatic, {
    root: publicDir,
    // The probe is iterated on a device with an opaque cache. Never serve a
    // stale build while we are still finding out what the runtime supports.
    setHeaders(res) {
      res.setHeader('cache-control', 'no-store');
    },
  });

  const localMp4 = join(publicDir, 'samples', 'sample.mp4');
  const localMp4Path = existsSync(localMp4) ? '/samples/sample.mp4' : null;

  await fastify.register(probeRoutes, { config, store, localMp4Path });

  fastify.get('/api/health', async () => ({
    status: 'ok',
    milestone: 'M0',
    sampleMp4Origin: localMp4Path ? 'same-origin' : 'cross-origin',
  }));

  return fastify;
}
