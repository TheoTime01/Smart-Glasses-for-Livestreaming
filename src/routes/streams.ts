import type { FastifyPluginAsync } from 'fastify';
import QRCode from 'qrcode';

import { hasControlToken, UNAUTHORIZED } from '../auth/control-token.js';
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

/**
 * Routes that may take the control token from the query string. Only the QR
 * image qualifies: it is loaded through an `<img src>`, which cannot send a
 * header. Everywhere else the token would be written to access and proxy logs
 * for no reason.
 */
const QUERY_TOKEN_ROUTES = new Set(['/api/streams/:id/qr.png']);

export const streamRoutes: FastifyPluginAsync<StreamRoutesOptions> = async (fastify, options) => {
  const { config, service } = options;

  /**
   * The control API hands out RTMP credentials and can create billable api.video
   * resources, and it is typically reachable through a public tunnel. If
   * CONTROL_TOKEN is set every route below requires it. The glasses use device
   * tokens instead — see `routes/pairing.ts`.
   */
  fastify.addHook('preHandler', async (request, reply) => {
    const allowQueryParam = QUERY_TOKEN_ROUTES.has(request.routeOptions.url ?? '');
    if (hasControlToken(request, config.controlToken, { allowQueryParam })) return;
    return reply.code(401).send(UNAUTHORIZED);
  });

  fastify.addHook('preHandler', async (_request, reply) => {
    if (service) return;
    return reply.code(503).send({
      error: 'not_configured',
      message: 'API_VIDEO_KEY is not set. Copy .env.example to .env and add your api.video key.',
    });
  });

  // The hook above answers before any handler runs when api.video is
  // unconfigured, so this is the single place that null is discharged.
  const streams = service as StreamService;

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

    const stream = await streams.create(name, body.public !== false);
    request.log.info({ liveStreamId: stream.id, public: stream.public }, 'live stream created');
    return reply.code(201).send(stream);
  });

  fastify.get('/api/streams', async () => ({ streams: await streams.list() }));

  fastify.get<{ Params: { id: string } }>('/api/streams/:id', async (request) =>
    streams.get(request.params.id),
  );

  fastify.delete<{ Params: { id: string } }>('/api/streams/:id', async (request, reply) => {
    await streams.remove(request.params.id);
    request.log.info({ liveStreamId: request.params.id }, 'live stream deleted');
    return reply.code(204).send();
  });

  fastify.get<{ Params: { id: string } }>('/api/streams/:id/status', async (request, reply) => {
    const status = await streams.status(request.params.id);
    // Let intermediaries cache for the same window the service does.
    reply.header('cache-control', `public, max-age=${Math.floor(config.statusCacheTtlMs / 1000)}`);
    return status;
  });

  fastify.get<{ Params: { id: string } }>('/api/streams/:id/playback', async (request, reply) => {
    reply.header('cache-control', 'no-store'); // may carry a private-stream token
    return streams.playback(request.params.id);
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

      const stream = await streams.get(request.params.id);
      if (!stream.ingest.streamKey) {
        return reply.code(404).send({ error: 'no_stream_key', message: 'This stream has no stream key.' });
      }

      const png = await QRCode.toBuffer(ingestUrlFor(stream, requested as IngestProtocol), {
        type: 'png',
        width: 320,
        margin: 2,
        errorCorrectionLevel: 'M',
      });

      // The QR encodes the stream key. Never cache it, anywhere.
      return reply.header('content-type', 'image/png').header('cache-control', 'no-store').send(png);
    },
  );
};
