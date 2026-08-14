import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { PROBE_BINARY_FRAME_SIZE } from '../src/routes/probe.js';

let app: FastifyInstance;
let config: AppConfig;
let logDir: string;

const validReport = {
  clientTime: '2026-08-14T12:00:00.000Z',
  environment: {
    userAgent: 'Mozilla/5.0 (MRBD probe test)',
    devicePixelRatio: 2,
    screenWidth: 600,
    screenHeight: 600,
    innerWidth: 600,
    innerHeight: 600,
  },
  checks: [
    { id: 'mse.available', label: 'MediaSource available', ok: true, detail: 'present' },
    { id: 'video.hls.playing', label: 'HLS playing', ok: false, detail: 'MEDIA_ERR_SRC_NOT_SUPPORTED', ms: 812 },
  ],
  samples: { hls: 'https://example.com/master.m3u8' },
  tag: 'device-1',
};

beforeEach(async () => {
  logDir = await mkdtemp(join(tmpdir(), 'probe-test-'));
  config = { ...loadConfig(), probeLogDir: logDir };
  app = await buildApp({ config, logger: false });
});

afterEach(async () => {
  await app.close();
  await rm(logDir, { recursive: true, force: true });
});

describe('probe API', () => {
  it('stores a report and returns it', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/probe', payload: validReport });
    expect(post.statusCode).toBe(201);
    const { id } = post.json<{ id: string }>();
    expect(id).toBeTruthy();

    const list = await app.inject({ method: 'GET', url: '/api/probe' });
    expect(list.statusCode).toBe(200);
    const { reports } = list.json<{ reports: Array<{ id: string; tag?: string }> }>();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.id).toBe(id);
    expect(reports[0]?.tag).toBe('device-1');

    const single = await app.inject({ method: 'GET', url: `/api/probe/${id}` });
    expect(single.statusCode).toBe(200);
    expect(single.json<{ checks: unknown[] }>().checks).toHaveLength(2);
  });

  it('renders the latest report as plain text', async () => {
    await app.inject({ method: 'POST', url: '/api/probe', payload: validReport });
    const response = await app.inject({ method: 'GET', url: '/api/probe/latest.txt' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('[PASS] mse.available');
    expect(response.body).toContain('[FAIL] video.hls.playing');
    expect(response.body).toContain('MRBD probe test');
  });

  it('404s when no report has been received', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/probe/latest.txt' });
    expect(response.statusCode).toBe(404);
  });

  it('rejects malformed reports', async () => {
    const cases: unknown[] = [
      {},
      { ...validReport, checks: [] },
      { ...validReport, checks: [{ id: 'x', label: 'y', ok: 'yes', detail: '' }] },
      { ...validReport, checks: [{ label: 'missing id', ok: true, detail: '' }] },
    ];

    for (const payload of cases) {
      const response = await app.inject({ method: 'POST', url: '/api/probe', payload: payload as object });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<{ error: string }>().error).toBe('invalid_report');
    }
  });

  it('persists reports across a restart', async () => {
    await app.inject({ method: 'POST', url: '/api/probe', payload: validReport });
    await app.close();

    app = await buildApp({ config, logger: false });
    const list = await app.inject({ method: 'GET', url: '/api/probe' });
    expect(list.json<{ reports: unknown[] }>().reports).toHaveLength(1);
  });

  it('exposes the sample URLs the client should test', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/probe/config' });
    const body = response.json<{ samples: { hls: string; mp4: string } }>();
    expect(body.samples.hls).toMatch(/^https:\/\//);
    expect(body.samples.mp4).toBeTruthy();
  });

  it('streams the fetch test body in more than one chunk', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/probe/stream-test`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    let chunks = 0;
    let text = '';
    const decoder = new TextDecoder();
    for (;;) {
      const result = await reader!.read();
      if (result.done) break;
      chunks += 1;
      text += decoder.decode(result.value);
    }

    expect(chunks).toBeGreaterThan(1);
    expect(text).toBe('chunk-1\nchunk-2\nchunk-3\n');
  });
});

describe('probe WebSocket', () => {
  it('answers ping with pong and an intact binary frame', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/probe`);
    const messages = await new Promise<Array<string | Buffer>>((resolve, reject) => {
      const received: Array<string | Buffer> = [];
      const timer = setTimeout(() => reject(new Error('timed out')), 5000);
      socket.on('open', () => socket.send('ping'));
      socket.on('error', reject);
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        received.push(isBinary ? data : data.toString('utf8'));
        if (received.length === 2) {
          clearTimeout(timer);
          socket.close();
          resolve(received);
        }
      });
    });

    expect(messages[0]).toBe('pong');
    const frame = messages[1] as Buffer;
    expect(frame).toHaveLength(PROBE_BINARY_FRAME_SIZE);
    expect(frame[0]).toBe(0);
    expect(frame[255]).toBe(255);
    expect(frame[256]).toBe(0);
  });
});

describe('probe page', () => {
  it('serves the required MRBD metadata and a non-scrolling 600x600 layout', async () => {
    const page = await app.inject({ method: 'GET', url: '/probe/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<meta name="mrbd-web-app-capable" content="yes" />');
    expect(page.body).toContain('width=600, height=600, initial-scale=1.0, user-scalable=no');
    expect(page.body).toMatch(/<meta name="description" content=".{10,}"/);

    const css = await app.inject({ method: 'GET', url: '/probe/probe.css' });
    expect(css.body).toContain('overflow: hidden');
    expect(css.body).toContain('width: 600px');

    const icon = await app.inject({ method: 'GET', url: '/favicon.png' });
    expect(icon.statusCode).toBe(200);
    expect(icon.rawPayload.subarray(1, 4).toString('ascii')).toBe('PNG');
  });
});
