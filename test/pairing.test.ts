import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';
import { loadConfig, type AppConfig } from '../src/config.js';

let app: FastifyInstance;
let dataDir: string;

const SECRET = 'test-secret';

/** Minimal api.video stand-in so the glasses stream list has something to show. */
const fakeFetch: typeof fetch = async (input, init) => {
  const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
  const body = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

  if (path === '/auth/api-key' || path === '/auth/refresh') {
    return body({ token_type: 'Bearer', expires_in: 3600, access_token: 't', refresh_token: 'r' });
  }
  if (path === '/live-streams' && (init?.method ?? 'GET') === 'GET') {
    return body({
      data: [
        {
          liveStreamId: 'li1',
          name: 'Workshop camera',
          public: true,
          broadcasting: true,
          streamKey: 'super-secret-key',
          restreams: [],
          assets: { hls: 'https://live.api.video/li1.m3u8' },
        },
      ],
      pagination: { itemsTotal: 1 },
    });
  }
  if (path === '/live-streams/li1') {
    return body({
      liveStreamId: 'li1',
      name: 'Workshop camera',
      public: true,
      broadcasting: true,
      streamKey: 'super-secret-key',
      restreams: [],
      assets: { hls: 'https://live.api.video/li1.m3u8' },
    });
  }
  return body({ title: 'not found' }, 404);
};

async function build(overrides: Partial<AppConfig> = {}): Promise<void> {
  const config: AppConfig = {
    ...loadConfig(),
    dataDir,
    probeLogDir: join(dataDir, 'probe'),
    apiVideoKey: 'test-key',
    apiVideoEnv: 'sandbox',
    jwtSecret: SECRET,
    controlToken: undefined,
    ...overrides,
  };
  app = await buildApp({ config, logger: false, fetchImpl: fakeFetch });
}

async function pairDevice(): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/pair' });
  const { code } = created.json<{ code: string }>();
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/pair/claim',
    payload: { code, deviceName: 'Ray-Ban Display' },
  });
  return claimed.json<{ token: string }>().token;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'pairing-test-'));
});

afterEach(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('pairing', () => {
  it('issues a 6-digit code and exchanges it for a device token', async () => {
    await build();
    const created = await app.inject({ method: 'POST', url: '/api/pair' });

    expect(created.statusCode).toBe(201);
    const pairing = created.json<{ code: string; ttlSeconds: number }>();
    expect(pairing.code).toMatch(/^\d{6}$/);
    expect(pairing.ttlSeconds).toBe(300);

    const claimed = await app.inject({
      method: 'POST',
      url: '/api/pair/claim',
      payload: { code: pairing.code, deviceName: 'Ray-Ban Display' },
    });
    expect(claimed.statusCode).toBe(201);
    expect(claimed.json<{ token: string }>().token.split('.')).toHaveLength(3);
  });

  it('refuses to reuse a code', async () => {
    await build();
    const { code } = (await app.inject({ method: 'POST', url: '/api/pair' })).json<{ code: string }>();

    const first = await app.inject({ method: 'POST', url: '/api/pair/claim', payload: { code } });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: 'POST', url: '/api/pair/claim', payload: { code } });
    expect(second.statusCode).toBe(400);
    expect(second.json<{ error: string }>().error).toBe('invalid_code');
  });

  it('rejects codes that were never issued, and malformed ones', async () => {
    await build();
    for (const code of ['000000', '12345', 'abcdef', '']) {
      const response = await app.inject({ method: 'POST', url: '/api/pair/claim', payload: { code } });
      expect(response.statusCode, code).toBe(400);
    }
  });

  it('rate limits claim attempts', async () => {
    await build();
    let sawLimit = false;
    for (let i = 0; i < 12; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/pair/claim',
        payload: { code: '111111' },
      });
      if (response.statusCode === 429) sawLimit = true;
    }
    expect(sawLimit).toBe(true);
  });

  it('expires codes', async () => {
    await build({ pairingCodeTtl: 0 });
    const { code } = (await app.inject({ method: 'POST', url: '/api/pair' })).json<{ code: string }>();

    const claimed = await app.inject({ method: 'POST', url: '/api/pair/claim', payload: { code } });
    expect(claimed.statusCode).toBe(400);
  });
});

describe('device-authenticated glasses API', () => {
  it('lists streams without ever exposing the stream key', async () => {
    await build();
    const token = await pairDevice();

    const response = await app.inject({
      method: 'GET',
      url: '/api/glasses/streams',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('super-secret-key');
    const { streams } = response.json<{ streams: Array<Record<string, unknown>> }>();
    expect(streams).toHaveLength(1);
    expect(streams[0]).toEqual({ id: 'li1', name: 'Workshop camera', broadcasting: true, public: true });
  });

  it('refuses missing, malformed and forged tokens', async () => {
    await build();
    const forged = signDeviceToken('some-device-id', 'the-wrong-secret');

    for (const headers of [{}, { authorization: 'Bearer nonsense' }, { authorization: `Bearer ${forged}` }]) {
      const response = await app.inject({ method: 'GET', url: '/api/glasses/streams', headers });
      expect(response.statusCode, JSON.stringify(headers)).toBe(401);
    }
  });

  it('revoking a device immediately invalidates its token', async () => {
    await build();
    const token = await pairDevice();
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: 'GET', url: '/api/glasses/streams', headers })).statusCode).toBe(200);

    const { devices } = (await app.inject({ method: 'GET', url: '/api/devices' })).json<{
      devices: Array<{ id: string }>;
    }>();
    const removed = await app.inject({ method: 'DELETE', url: `/api/devices/${devices[0]?.id}` });
    expect(removed.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/api/glasses/streams', headers });
    expect(after.statusCode).toBe(401);
    expect(after.json<{ error: string }>().error).toBe('revoked');
  });

  it('keeps devices paired across a restart', async () => {
    await build();
    const token = await pairDevice();
    await app.close();

    await build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/glasses/streams',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('answers 503 when JWT_SECRET is unset', async () => {
    await build({ jwtSecret: undefined });
    const response = await app.inject({ method: 'POST', url: '/api/pair' });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: string }>().error).toBe('not_configured');
  });

  it('requires the control token for minting codes and listing devices', async () => {
    await build({ controlToken: 'sekret' });

    expect((await app.inject({ method: 'POST', url: '/api/pair' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/devices' })).statusCode).toBe(401);

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/pair',
      headers: { 'x-control-token': 'sekret' },
    });
    expect(allowed.statusCode).toBe(201);

    // Claiming must NOT need it — the glasses have no way to hold that secret.
    const { code } = allowed.json<{ code: string }>();
    const claimed = await app.inject({ method: 'POST', url: '/api/pair/claim', payload: { code } });
    expect(claimed.statusCode).toBe(201);
  });
});
