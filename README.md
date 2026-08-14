# Smart-Glasses-for-Livestreaming

An api.video live viewer for **Meta Ray-Ban Display** (MRBD): a 600×600 D-pad web app that
watches a stream ingested over RTMP from OBS, a Raspberry Pi, a phone, or a restreamed PTZ
camera. See [SPEC.md](SPEC.md) for the full design.

**Status: Milestone 0 — the capability probe.** No player, no api.video calls, no pairing yet.

## Why a probe first

Video playback is not in the documented MRBD Web App capability table. Before committing to a
playback architecture we measure what the runtime actually does: `<video>`, MSE, native HLS,
WebSocket binary frames, blob object URLs, `createImageBitmap`, and streaming `fetch` bodies.
The three playback paths in the spec (HLS / frame relay / JPEG polling) are chosen based on
what this reports back from the real device.

## Run it

```bash
npm install
cp .env.example .env        # every M0 value has a working default
npm run fetch:samples       # optional: same-origin MP4 sample (~1 MB, gitignored)
npm run dev                 # http://localhost:3000/probe/
```

`npm run gen:assets` regenerates `public/favicon.png` and `public/probe/dot.png` (PNG only —
SVG icons are not supported on MRBD).

### Put it on the glasses

The glasses require **HTTPS**, so a `localhost` URL will not load. For a quick device test,
tunnel the local server:

```bash
cloudflared tunnel --url http://localhost:3000     # or: ngrok http 3000
```

Open `https://<tunnel-host>/probe/?tag=glasses-1` on the device. The probe runs on load and
POSTs its results automatically; `?tag=` just labels the run.

### Read the results

```bash
curl https://<host>/api/probe/latest.txt    # newest report, plain text
curl https://<host>/api/probe?limit=5       # recent reports, JSON
```

Reports are also appended to `data/probe/probe-YYYY-MM-DD.jsonl`.

Everything is readable on the HUD too — one line per check, ✓/✗, paginated with ◀ ▶ (the page
never scrolls). ▲ ▼ moves between the two buttons, Enter activates.

## What the probe checks

| id | Decides |
|---|---|
| `mse.available`, `mse.h264.aac` | whether `hls.js` (Path A fallback) can work at all |
| `video.canplaytype.hls` / `.mp4` | whether native HLS playback is available |
| `video.mp4.*` | same-origin progressive MP4: does `<video>` decode and play anything |
| `video.hls.*` | cross-origin HLS: the shape api.video actually delivers |
| `ws.connect`, `ws.binary` | Path B — the frame relay transport |
| `blob.objecturl`, `canvas.drawimage`, `createimagebitmap` | Path B — how relay frames get drawn |
| `fetch.readablestream` | whether streamed response bodies arrive incrementally |
| `storage.local`, `serviceworker.available` | M2 device token, M5 offline shell |
| `env.*` | user agent, screen size, viewport, DPR |

Video checks are bounded at 10s each and report the `MediaError` code on failure, so a runtime
without playback produces a readable report rather than a hang or a blank screen.

The MP4 sample is served from our own origin when `npm run fetch:samples` has run; the HLS
sample is Apple's public bipbop stream, which is cross-origin like api.video will be. If the
same-origin MP4 plays and cross-origin HLS does not, the problem is network/CORS, not `<video>`.
Both URLs are overridable — see `.env.example`.

## Endpoints (M0)

| Route | Purpose |
|---|---|
| `GET /probe/` | the probe page (open this on the glasses) |
| `GET /api/probe/config` | sample URLs the client should test |
| `POST /api/probe` | store a report |
| `GET /api/probe`, `/api/probe/:id`, `/api/probe/latest.txt` | read reports |
| `GET /api/probe/stream-test` | 3 chunks with gaps, for the streaming-body check |
| `WS /ws/probe` | `ping` → `pong` + a 1024-byte binary frame with a known pattern |
| `GET /api/health` | liveness |

## Checks

```bash
npm run lint
npm run typecheck
npm test
```

## Latency expectations

RTMP ingest → HLS playback is inherently a few seconds. Realistic glass-to-glass latency is
roughly **3–10s** on the native/MSE HLS path depending on segment and GOP size, plus another
**0.5–1s** on the server-side frame relay. Sub-second would require WebRTC playback, which this
design does not provide. Measured latency will be shown in the viewer HUD rather than hidden.

Ingest settings dominate this: keyframe interval **1s**, 720p30 max, modest bitrate. Ready-to-paste
OBS / Raspberry Pi / ffmpeg-RTSP / Larix commands land with M1.

## Deployment note

The frame relay (M4) spawns a long-lived `ffmpeg` process per stream, so this cannot run on
Cloudflare Pages or any request-scoped serverless host. Target a container host (Fly.io,
Railway, a small VPS) with `ffmpeg` installed, optionally behind Cloudflare. The `Dockerfile`
and full deploy docs land with M5.

## Milestones

- **Step 0** — Web Apps plugin + Wearables MCP configured ✅
- **M0** — capability probe ✅ *(awaiting a run on real glasses)*
- **M1** — backend + api.video stream CRUD + `/control` page
- **M2** — `/glasses` shell: D-pad focus, pairing flow, stream list, `/sim`, Playwright tests
- **M3** — Path A player + HUD overlay
- **M4** — Path B relay + Path C polling, with strategy selection
- **M5** — offline shell, icons, README, Dockerfile, deploy docs
