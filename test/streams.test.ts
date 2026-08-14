import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';

/**
 * A stand-in for api.video. Records every call so the tests can assert on the
 * exact paths, payloads and auth headers we send — no network, no billing.
 */
class FakeApiVideo {
  calls: Array<{ method: string; url: string; body: unknown; authorization: string | undefined }> = [];
  authCount = 0;
  streams = new Map<string, Record<string, unknown>>();
  /** Force the next N API calls to answer 401 (expired token). */
  unauthorizedOnce = false;
  nextId = 1;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.calls.push({ method, url, body, authorization: headers.authorization });

    const path = new URL(url).pathname;

    if (path === '/auth/api-key' || path === '/auth/refresh') {
      this.authCount += 1;
      return json({
        token_type: 'Bearer',
        expires_in: 3600,
        access_token: `token-${this.authCount}`,
        refresh_token: `refresh-${this.authCount}`,
      });
    }

    if (this.unauthorizedOnce) {
      this.unauthorizedOnce = false;
      return json({ title: 'expired' }, 401);
    }

    if (path === '/live-streams' && method === 'POST') {
      const payload = body as { name: string; public?: boolean };
      const id = `li${this.nextId++}`;
      const stream = {
        liveStreamId: id,
        name: payload.name,
        public: payload.public !== false,
        broadcasting: false,
        streamKey: `key-${id}`,
        createdAt: '2026-08-14T12:00:00.000Z',
        restreams: [],
        assets: {
          hls: `https://live.api.video/${id}.m3u8`,
          thumbnail: `https://cdn.api.video/live/${id}/thumbnail.jpg`,
        },
      };
      this.streams.set(id, stream);
      return json(stream);
    }

    if (path === '/live-streams' && method === 'GET') {
      return json({ data: [...this.streams.values()], pagination: { itemsTotal: this.streams.size } });
    }

    const match = /^\/live-streams\/(.+)$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1] ?? '');
      const stream = this.streams.get(id);
      if (!stream) return json({ title: 'not found', status: 404 }, 404);
      if (method === 'DELETE') {
        this.streams.delete(id);
        return new Response(null, { status: 204 });
      }
      return json(stream);
    }

    return json({ title: 'unexpected path' }, 404);
  };

  callsTo(pathSuffix: string): number {
    return this.calls.filter((call) => new URL(call.url).pathname === pathSuffix).length;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let app: FastifyInstance;
let api: FakeApiVideo;
let logDir: string;

async function build(overrides: Partial<AppConfig> = {}): Promise<void> {
  const config: AppConfig = {
    ...loadConfig(),
    probeLogDir: logDir,
    apiVideoKey: 'test-key',
    apiVideoEnv: 'sandbox',
    controlToken: undefined,
    ...overrides,
  };
  app = await buildApp({ config, logger: false, fetchImpl: api.fetch });
}

beforeEach(async () => {
  logDir = await mkdtemp(join(tmpdir(), 'streams-test-'));
  api = new FakeApiVideo();
});

afterEach(async () => {
  await app.close();
  await rm(logDir, { recursive: true, force: true });
});

describe('stream API', () => {
  it('creates a stream and returns RTMP ingest credentials', async () => {
    await build();
    const response = await app.inject({
      method: 'POST',
      url: '/api/streams',
      payload: { name: 'Workshop camera', public: false },
    });

    expect(response.statusCode).toBe(201);
    const stream = response.json<{
      id: string;
      name: string;
      public: boolean;
      hls: string;
      ingest: {
        streamKey: string;
        rtmp: { server: string; url: string };
        rtmps: { server: string; url: string };
        srt: { url: string };
      };
    }>();

    expect(stream.name).toBe('Workshop camera');
    expect(stream.public).toBe(false);
    expect(stream.ingest.rtmp.server).toBe('rtmp://broadcast.api.video:1935/s');
    expect(stream.ingest.rtmp.url).toBe(`rtmp://broadcast.api.video:1935/s/${stream.ingest.streamKey}`);
    expect(stream.ingest.rtmps.url).toBe(`rtmps://broadcast.api.video:1936/s/${stream.ingest.streamKey}`);
    expect(stream.ingest.srt.url).toBe(
      `srt://broadcast.api.video:6200?streamid=${stream.ingest.streamKey}`,
    );
    expect(stream.hls).toBe(`https://live.api.video/${stream.id}.m3u8`);

    // Authenticated once, then called the documented endpoint with a bearer token.
    const create = api.calls.find((call) => call.method === 'POST' && call.url.endsWith('/live-streams'));
    expect(create?.url).toBe('https://sandbox.api.video/live-streams');
    expect(create?.authorization).toBe('Bearer token-1');
    expect(create?.body).toEqual({ name: 'Workshop camera', public: false });
  });

  it('rejects a create without a name', async () => {
    await build();
    for (const payload of [{}, { name: '   ' }, { name: 'ok', public: 'yes' }]) {
      const response = await app.inject({ method: 'POST', url: '/api/streams', payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('lists and deletes streams', async () => {
    await build();
    const created = await app.inject({ method: 'POST', url: '/api/streams', payload: { name: 'One' } });
    const id = created.json<{ id: string }>().id;

    const list = await app.inject({ method: 'GET', url: '/api/streams' });
    expect(list.json<{ streams: unknown[] }>().streams).toHaveLength(1);

    const removed = await app.inject({ method: 'DELETE', url: `/api/streams/${id}` });
    expect(removed.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/api/streams' });
    expect(after.json<{ streams: unknown[] }>().streams).toHaveLength(0);
  });

  it('maps an api.video 404 to a 404', async () => {
    await build();
    const response = await app.inject({ method: 'GET', url: '/api/streams/li-missing' });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe('api_video_error');
  });

  it('re-authenticates once when the bearer token is rejected', async () => {
    await build();
    await app.inject({ method: 'POST', url: '/api/streams', payload: { name: 'One' } });
    expect(api.authCount).toBe(1);

    api.unauthorizedOnce = true;
    const list = await app.inject({ method: 'GET', url: '/api/streams' });

    expect(list.statusCode).toBe(200);
    expect(api.authCount).toBe(2);
  });

  it('caches status so polling does not hammer api.video', async () => {
    await build({ statusCacheTtlMs: 60_000 });
    const created = await app.inject({ method: 'POST', url: '/api/streams', payload: { name: 'One' } });
    const id = created.json<{ id: string }>().id;

    const before = api.callsTo(`/live-streams/${id}`);
    const first = await app.inject({ method: 'GET', url: `/api/streams/${id}/status` });
    const second = await app.inject({ method: 'GET', url: `/api/streams/${id}/status` });
    const third = await app.inject({ method: 'GET', url: `/api/streams/${id}/status` });

    expect(first.json<{ cached: boolean }>().cached).toBe(false);
    expect(second.json<{ cached: boolean }>().cached).toBe(true);
    expect(third.json<{ cached: boolean }>().cached).toBe(true);
    expect(api.callsTo(`/live-streams/${id}`) - before).toBe(1);
  });

  it('always fetches a fresh playback URL, since private tokens live in it', async () => {
    await build({ statusCacheTtlMs: 60_000 });
    const created = await app.inject({ method: 'POST', url: '/api/streams', payload: { name: 'One' } });
    const id = created.json<{ id: string }>().id;

    const before = api.callsTo(`/live-streams/${id}`);
    await app.inject({ method: 'GET', url: `/api/streams/${id}/playback` });
    const second = await app.inject({ method: 'GET', url: `/api/streams/${id}/playback` });

    expect(api.callsTo(`/live-streams/${id}`) - before).toBe(2);
    expect(second.headers['cache-control']).toBe('no-store');
    expect(second.json<{ refreshAfter: number }>().refreshAfter).toBeGreaterThan(0);
  });

  it('serves a PNG QR code for each ingest protocol', async () => {
    await build();
    const created = await app.inject({ method: 'POST', url: '/api/streams', payload: { name: 'One' } });
    const id = created.json<{ id: string }>().id;

    for (const protocol of ['', '?protocol=rtmp', '?protocol=rtmps', '?protocol=srt']) {
      const qr = await app.inject({ method: 'GET', url: `/api/streams/${id}/qr.png${protocol}` });
      expect(qr.statusCode, protocol).toBe(200);
      expect(qr.headers['content-type']).toBe('image/png');
      expect(qr.rawPayload.subarray(1, 4).toString('ascii')).toBe('PNG');
    }

    const bad = await app.inject({ method: 'GET', url: `/api/streams/${id}/qr.png?protocol=telnet` });
    expect(bad.statusCode).toBe(400);
  });
});

describe('stream API guards', () => {
  it('answers 503 when API_VIDEO_KEY is unset, leaving the probe usable', async () => {
    await build({ apiVideoKey: undefined });

    const streams = await app.inject({ method: 'GET', url: '/api/streams' });
    expect(streams.statusCode).toBe(503);
    expect(streams.json<{ error: string }>().error).toBe('not_configured');

    const probe = await app.inject({ method: 'GET', url: '/api/probe/config' });
    expect(probe.statusCode).toBe(200);
  });

  it('requires the control token when one is configured', async () => {
    await build({ controlToken: 'sekret' });

    const denied = await app.inject({ method: 'GET', url: '/api/streams' });
    expect(denied.statusCode).toBe(401);

    const wrong = await app.inject({
      method: 'GET',
      url: '/api/streams',
      headers: { 'x-control-token': 'nope!!' },
    });
    expect(wrong.statusCode).toBe(401);

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/streams',
      headers: { 'x-control-token': 'sekret' },
    });
    expect(allowed.statusCode).toBe(200);

    // A query-string token lands in access and proxy logs, so it is refused
    // everywhere except the one route that cannot send a header.
    const viaQuery = await app.inject({ method: 'GET', url: '/api/streams?control_token=sekret' });
    expect(viaQuery.statusCode).toBe(401);
  });

  it('accepts the control token in the query string for the QR image only', async () => {
    await build({ controlToken: 'sekret' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/streams',
      payload: { name: 'One' },
      headers: { 'x-control-token': 'sekret' },
    });
    const id = created.json<{ id: string }>().id;

    // The QR is loaded through an <img src>, which cannot carry a header.
    const qr = await app.inject({ method: 'GET', url: `/api/streams/${id}/qr.png?control_token=sekret` });
    expect(qr.statusCode).toBe(200);
    expect(qr.headers['content-type']).toBe('image/png');

    const wrong = await app.inject({ method: 'GET', url: `/api/streams/${id}/qr.png?control_token=nope!!` });
    expect(wrong.statusCode).toBe(401);
  });
});
