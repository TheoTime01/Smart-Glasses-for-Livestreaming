import { Readable } from 'node:stream';

import type { FastifyPluginAsync } from 'fastify';

import type { AppConfig } from '../config.js';
import { renderReportText, type ProbeStore } from '../probe/store.js';
import { parseProbeReport, ValidationError } from '../probe/validate.js';

export const PROBE_BINARY_FRAME_SIZE = 1024;

/** Deterministic byte pattern so the client can verify the payload survived intact. */
export function probeBinaryFrame(): Buffer {
  const frame = Buffer.allocUnsafe(PROBE_BINARY_FRAME_SIZE);
  for (let i = 0; i < frame.length; i += 1) frame[i] = i % 256;
  return frame;
}

interface ProbeRoutesOptions {
  config: AppConfig;
  store: ProbeStore;
  /** Same-origin MP4 path, when `npm run fetch:samples` has provided one. */
  localMp4Path: string | null;
}

export const probeRoutes: FastifyPluginAsync<ProbeRoutesOptions> = async (fastify, options) => {
  const { config, store, localMp4Path } = options;

  // Tells the client which media to test against, so sample URLs are never
  // baked into the page and can be swapped per environment.
  fastify.get('/api/probe/config', async () => ({
    serverTime: new Date().toISOString(),
    samples: {
      hls: config.sampleHlsUrl,
      mp4: localMp4Path ?? config.sampleMp4Url,
      mp4Origin: localMp4Path ? 'same-origin' : 'cross-origin',
    },
  }));

  // Emits three chunks with gaps between them. A runtime with real streaming
  // bodies sees 3 reads; one that buffers the whole response sees 1.
  fastify.get('/api/probe/stream-test', async (_request, reply) => {
    const stream = Readable.from(
      (async function* chunks() {
        for (let i = 1; i <= 3; i += 1) {
          yield `chunk-${i}\n`;
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      })(),
    );

    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('cache-control', 'no-store')
      // Compression would coalesce the chunks and defeat the point of the check.
      .header('x-no-compression', '1')
      .send(stream);
  });

  fastify.post('/api/probe', async (request, reply) => {
    let input;
    try {
      input = parseProbeReport(request.body);
    } catch (error) {
      if (error instanceof ValidationError) {
        return reply.code(400).send({ error: 'invalid_report', message: error.message });
      }
      throw error;
    }

    const report = await store.add(input, request.ip);
    const failed = report.checks.filter((check) => check.ok === false).length;
    request.log.info(
      { probeId: report.id, checks: report.checks.length, failed, tag: report.tag },
      'probe report received',
    );

    return reply.code(201).send({ id: report.id, receivedAt: report.receivedAt });
  });

  fastify.get('/api/probe', async (request) => {
    const limit = clampLimit((request.query as Record<string, unknown>).limit);
    return { reports: store.list(limit) };
  });

  fastify.get('/api/probe/latest.txt', async (_request, reply) => {
    const report = store.latest();
    reply.header('content-type', 'text/plain; charset=utf-8');
    if (!report) return reply.code(404).send('no probe reports yet\n');
    return reply.send(renderReportText(report));
  });

  fastify.get<{ Params: { id: string } }>('/api/probe/:id', async (request, reply) => {
    const report = store.get(request.params.id);
    if (!report) return reply.code(404).send({ error: 'not_found' });
    return report;
  });

  // Round trip for the WebSocket check: text in, text + binary back.
  fastify.get('/ws/probe', { websocket: true }, (socket) => {
    socket.on('message', (raw: Buffer) => {
      const text = raw.toString('utf8');
      if (text === 'ping') {
        socket.send('pong');
        socket.send(probeBinaryFrame(), { binary: true });
      }
    });
  });
};

function clampLimit(raw: unknown): number {
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(Math.max(parsed, 1), 50);
}
