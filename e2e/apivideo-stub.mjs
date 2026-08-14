/**
 * Stand-in for api.video, used only by the Playwright suite (see
 * playwright.config.ts). Serves just enough of the live stream API for the
 * glasses UI to have something to list and open.
 *
 *   node e2e/apivideo-stub.mjs [port]
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4599);

const streams = [
  { id: 'li-alpha', name: 'Workshop camera', broadcasting: true },
  { id: 'li-bravo', name: 'PTZ cam', broadcasting: false },
  { id: 'li-charlie', name: 'Raspberry Pi', broadcasting: true },
  { id: 'li-delta', name: 'Phone (Larix)', broadcasting: false },
  { id: 'li-echo', name: 'Backup encoder', broadcasting: false },
  { id: 'li-foxtrot', name: 'Stage wide shot', broadcasting: true },
  { id: 'li-golf', name: 'Overflow room', broadcasting: false },
];

const toLiveStream = (stream) => ({
  liveStreamId: stream.id,
  name: stream.name,
  public: true,
  broadcasting: stream.broadcasting,
  streamKey: `key-${stream.id}`,
  createdAt: '2026-08-14T12:00:00.000Z',
  restreams: [],
  assets: { hls: `https://live.api.video/${stream.id}.m3u8` },
});

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload === undefined ? '' : JSON.stringify(payload));
  };

  if (url.pathname === '/health') return send(200, { status: 'ok' });

  if (url.pathname === '/auth/api-key' || url.pathname === '/auth/refresh') {
    return send(200, {
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: 'stub-token',
      refresh_token: 'stub-refresh',
    });
  }

  if (url.pathname === '/live-streams') {
    return send(200, { data: streams.map(toLiveStream), pagination: { itemsTotal: streams.length } });
  }

  const match = /^\/live-streams\/(.+)$/.exec(url.pathname);
  if (match) {
    const stream = streams.find((candidate) => candidate.id === decodeURIComponent(match[1]));
    if (!stream) return send(404, { title: 'not found' });
    return send(200, toLiveStream(stream));
  }

  send(404, { title: 'unexpected path' });
}).listen(port, '127.0.0.1', () => console.log(`api.video stub on http://127.0.0.1:${port}`));
