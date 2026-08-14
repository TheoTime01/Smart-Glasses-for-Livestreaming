import { timingSafeEqual } from 'node:crypto';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';

import { ApiVideoError } from '../apivideo/types.js';
import type { AppConfig } from '../config.js';
import {
  INGEST_PROTOCOLS,
  ingestUrlFor,
  type IngestProtocol,
  type StreamService,
} from '../streams/service.js';

interface StreamRoutesOptions {
  config: AppConfig;
  /** null when API_VIDEO_KEY is unset — every route then answers 503. */
  service: StreamService | null;
}

export const streamRoutes: FastifyPluginAsync<StreamRoutesOptions> = async (fastify, options) => {
  const { config, service } = options;

  /**
   * The control API hands out RTMP credentials and can create billable api.video
   * resources, and it is typically reachable through a public tunnel. If
   * CONTROL_TOKEN is set every route below requires it. Pairing-based auth for
   * the glasses arrives in M2; this is the interim guard for /control.
   */
  fastify.addHook('preHandler', async (request, reply) => {
    if (!config.controlToken) return;
    const provided =
      (request.headers['x-control-token'] as string | undefined) ??
      (request.query as Record<string, string | undefined>).control_token;

    if (!provided || !safeEqual(provided, config.controlToken)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid control token.' });
    }
  });

  fastify.addHook('preHandler', async (_request, reply) => {
    if (service) return;
    return reply.code(503).send({
      error: 'not_configured',
      message: 'API_VIDEO_KEY is not set. Copy .env.example to .env and add your api.video key.',
    });
  });

  fastify.post<{ Body: { name?: unknown; public?: unknown } }>('/api/streams', async (request, reply) => {
    const body = request.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return reply.code(400).send({ error: 'invalid_request', message: 'name is required' });
    }
    if (name.length > 120) {
      return reply.code(400).send({ error: 'invalid_request', message: 'name must be at most 120 characters' });
    }
    if (body.public !== undefined && typeof body.public !== 'boolean') {
      return reply.code(400).send({ error: 'invalid_request', message: 'public must be a boolean' });
    }

    const stream = await service!.create(name, body.public !== false);
    request.log.info({ liveStreamId: stream.id, public: stream.public }, 'live stream created');
    return reply.code(201).send(stream);
  });

  fastify.get('/api/streams', async () => ({ streams: await service!.list() }));

  fastify.get<{ Params: { id: string } }>('/api/streams/:id', async (request) =>
    service!.get(request.params.id),
  );

  fastify.delete<{ Params: { id: string } }>('/api/streams/:id', async (request, reply) => {
    await service!.remove(request.params.id);
    request.log.info({ liveStreamId: request.params.id }, 'live stream deleted');
    return reply.code(204).send();
  });

  fastify.get<{ Params: { id: string } }>('/api/streams/:id/status', async (request, reply) => {
    const status = await service!.status(request.params.id);
    // Let intermediaries cache for the same window the service does.
    reply.header('cache-control', `public, max-age=${Math.floor(config.statusCacheTtlMs / 1000)}`);
    return status;
  });

  fastify.get<{ Params: { id: string } }>('/api/streams/:id/playback', async (request, reply) => {
    reply.header('cache-control', 'no-store'); // may carry a private-stream token
    return service!.playback(request.params.id);
  });

  /**
   * QR of the full ingest URL, for pointing a phone encoder (Larix) at the
   * stream without typing a key. Defaults to RTMP because every encoder speaks
   * it; `?protocol=rtmps|srt` selects the others.
   */
  fastify.get<{ Params: { id: string }; Querystring: { protocol?: string } }>(
    '/api/streams/:id/qr.png',
    async (request, reply) => {
      const requested = request.query.protocol ?? 'rtmp';
      if (!(INGEST_PROTOCOLS as readonly string[]).includes(requested)) {
        return reply.code(400).send({
          error: 'invalid_request',
          message: `protocol must be one of ${INGEST_PROTOCOLS.join(', ')}`,
        });
      }

      const stream = await service!.get(request.params.id);
      if (!stream.ingest.streamKey) {
        return reply.code(404).send({ error: 'no_stream_key', message: 'This stream has no stream key.' });
      }

      const png = await QRCode.toBuffer(ingestUrlFor(stream, requested as IngestProtocol), {
        type: 'png',
        width: 320,
        margin: 2,
        errorCorrectionLevel: 'M',
      });

      return reply.header('content-type', 'image/png').header('cache-control', 'no-store').send(png);
    },
  );

  // api.video failures become honest HTTP statuses instead of opaque 500s.
  fastify.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ApiVideoError) {
      request.log.error({ err: error, status: error.status, detail: error.detail }, 'api.video call failed');
      const status = error.status === 404 ? 404 : error.status === 400 ? 400 : 502;
      return reply.code(status).send({
        error: 'api_video_error',
        message: error.message,
        detail: error.detail || undefined,
      });
    }
    request.log.error({ err: error }, 'unhandled error in stream routes');
    return reply.code(500).send({ error: 'internal_error', message: 'Unexpected server error.' });
  });
};

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
