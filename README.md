# Smart-Glasses-for-Livestreaming

An api.video live viewer for **Meta Ray-Ban Display** (MRBD): a 600×600 D-pad web app that
watches a stream ingested over RTMP from OBS, a Raspberry Pi, a phone, or a restreamed PTZ
camera. See [SPEC.md](SPEC.md) for the full design.

**Status: Milestone 2 — the glasses app shell, pairing, stream list, `/sim` harness and Playwright
suite.** The video player itself is still to come (M3/M4).

## Why a probe first

Video playback is not in the documented MRBD Web App capability table. Before committing to a
playback architecture we measure what the runtime actually does: `<video>`, MSE, native HLS,
WebSocket binary frames, blob object URLs, `createImageBitmap`, and streaming `fetch` bodies.
The three playback paths in the spec (HLS / frame relay / JPEG polling) are chosen based on
what this reports back from the real device.

## Run it

```bash
npm install
cp .env.example .env        # add API_VIDEO_KEY for M1; M0 works without it
npm run fetch:samples       # optional: same-origin MP4 sample (~1 MB, gitignored)
npm run dev                 # http://localhost:3000/control/ and /probe/
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

## The control page (M1)

`/control/` runs in a normal browser — create and delete api.video live streams, copy the ingest
credentials for RTMP, RTMPS or SRT, scan a QR of any of those URLs, and check whether a stream is
receiving ingest. Stream keys are masked until you press **Show**, so a shared screen does not leak
them.

Ingest endpoints, per [create a live stream](https://docs.api.video/live-streaming/create-a-live-stream):

| Protocol | Server | Key placement |
|---|---|---|
| RTMP | `rtmp://broadcast.api.video:1935/s` | path segment |
| RTMPS | `rtmps://broadcast.api.video:1936/s` | path segment |
| SRT | `srt://broadcast.api.video:6200` | `?streamid=<key>` |

Prefer **RTMPS** where the encoder supports it — plain RTMP sends the stream key in clear text, and
some networks block port 1935 outright.

**Protect it.** These routes create billable api.video resources and hand out RTMP credentials,
and they are usually reachable through a public tunnel. Set `CONTROL_TOKEN` to any random string
and the page will ask for it once and remember it. Left unset, the API is open to anyone who can
reach the URL, and the server says so loudly at startup. Glasses-side pairing auth arrives in M2.

The token travels in an `x-control-token` header. `GET /api/streams/:id/qr.png` also accepts
`?control_token=` because an `<img src>` cannot send a header — no other route does, since query
strings end up in access logs, proxy logs and `Referer` headers. That QR encodes the stream key
itself, so treat its URL as a credential: it is served `no-store`, but a screenshot of it is a
working ingest key.

A missing `API_VIDEO_KEY` is a supported mode: `/api/streams` answers `503 not_configured` and the
M0 probe keeps working. A key that is present but *invalid* stops the server at startup instead of
failing on every click.

## The glasses app (M2)

`/glasses/` is the 600×600 D-pad app. It never scrolls, never needs the text composer, and never
receives a stream key.

**Pairing.** The glasses cannot render a usable password field, so: press **Pair a device** on
`/control/`, and a 6-digit code appears with a countdown. On the glasses, Left/Right picks the digit
position and Up/Down changes the value; Enter confirms. The code is single use with a 5 minute TTL,
claims are rate limited, and the server returns a device token that lives in `localStorage` as
`mrbd.device_token`. Revoke any device from `/control/` and its token dies on the next request.
Tokens also carry a 90 day expiry, so a pair of glasses that is lost rather than revoked does not
stay authorised forever; an expired token lands back on the pairing screen.

**Two separate audiences, two separate keys.** `/api/streams*` uses the control token and returns
ingest credentials. `/api/glasses/*` uses a device token and returns only id, name, public and
broadcasting — there is a test asserting a stream key can never appear in that response.

**Testing without the hardware.** `/sim/` hosts `/glasses/` in a 600×600 frame on black and
forwards your arrow keys, Enter and Escape into it, with on-screen buttons that dispatch the same
synthetic events. That is exactly what the Neural Band and temple captouch send, so anything that
works in `/sim` works on the device.

```bash
npm run test:e2e     # Playwright, real Chromium at 600x600
npm run test:all     # unit + e2e
```

The suite pins the properties the runtime makes non-negotiable: the document never scrolls on any
screen, every `.focusable` is reachable with arrow keys alone, focus is never lost to `<body>` and
always paints a visible ring, the list paginates rather than scrolls and Up/Down crosses a page
boundary instead of wrapping inside one, Escape returns from the viewer, a revoked device lands
back on the pairing screen, and playback falls back to the relay strategy when MSE and native HLS
are stubbed away. It runs against a stubbed api.video
(`e2e/apivideo-stub.mjs`), so it is offline, free and side-effect free.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /api/pair` | mint a 6-digit pairing code (control token) |
| `POST /api/pair/claim` | exchange a code for a device token (no control token) |
| `GET /api/devices`, `DELETE /api/devices/:id` | list and revoke paired devices |
| `GET /api/glasses/streams` | stream list for a paired device — no credentials |
| `GET /api/glasses/streams/:id/playback` | playback URL for a paired device |
| `POST /api/streams` | create a live stream — `{ name, public }` |
| `GET /api/streams` | list streams with ingest credentials |
| `GET /api/streams/:id` | one stream |
| `DELETE /api/streams/:id` | delete a stream |
| `GET /api/streams/:id/status` | is it receiving ingest (cached, see `STATUS_CACHE_TTL_MS`) |
| `GET /api/streams/:id/playback` | HLS URL, always freshly fetched — private tokens live in it |
| `GET /api/streams/:id/qr.png` | QR of the ingest URL — `?protocol=rtmp` (default) `\|rtmps\|srt` |
| `GET /probe/` | the capability probe (open this on the glasses) |
| `GET /api/probe/config` | sample URLs the probe client should test |
| `POST /api/probe` | store a probe report |
| `GET /api/probe`, `/api/probe/:id`, `/api/probe/latest.txt` | read probe reports |
| `GET /api/probe/stream-test` | 3 chunks with gaps, for the streaming-body check |
| `WS /ws/probe` | `ping` → `pong` + a 1024-byte binary frame with a known pattern |
| `GET /api/health` | liveness, plus whether api.video is configured |

### api.video sources

No endpoint or payload shape here was written from memory. Everything is transcribed from the
official [OpenAPI specification](https://github.com/apivideo/api.video-api-specification)
(`oas_apivideo.yaml`: `live-stream`, `live-stream-creation-payload`, `live-stream-list-response`,
`access-token`), with the RTMP host from
[create a live stream](https://docs.api.video/live-streaming/create-a-live-stream) and private
token behaviour from
[private video delivery](https://docs.api.video/delivery/private-video-on-hls-or-external-players).
Each is cited in the source file that uses it.

One gap worth knowing: the docs state that private **VOD** tokens are one-use with 24h sessions,
but give no TTL for private **live** tokens. `/playback` therefore re-fetches from api.video on
every call and tells the client to refresh every 240s, rather than assuming a lifetime.

## Sending video to a stream

Create a stream on `/control/`, then paste its **Stream key** into one of these. All of them use a
**1 second keyframe interval, 720p30 max, modest bitrate** — GOP length dominates HLS latency far
more than bitrate does.

**OBS** — Settings → Stream → Service `Custom`:

```
Server:     rtmps://broadcast.api.video:1936/s     (or rtmp://broadcast.api.video:1935/s)
Stream Key: <STREAM_KEY>
```

Then Settings → Output (Advanced) → Bitrate `2500 Kbps`, Keyframe Interval `1 s`, Profile `main`,
Tune `zerolatency`; Settings → Video → Output resolution `1280x720`, FPS `30`.

**Raspberry Pi camera** (`--intra 30` = one keyframe per second at 30 fps):

```bash
libcamera-vid -t 0 --inline --width 1280 --height 720 --framerate 30 \
  --bitrate 2500000 --intra 30 --codec h264 -o - \
| ffmpeg -f h264 -i - -c:v copy -an -f flv \
  rtmps://broadcast.api.video:1936/s/<STREAM_KEY>
```

**ONVIF / RTSP camera, restreamed** (adds a silent audio track, which some encoders' RTMP
implementations expect):

```bash
ffmpeg -rtsp_transport tcp -i rtsp://user:pass@camera.local/stream1 \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
  -vf "scale=1280:-2,fps=30" \
  -c:v libx264 -preset veryfast -tune zerolatency \
  -b:v 2500k -maxrate 2500k -bufsize 5000k \
  -g 30 -keyint_min 30 -sc_threshold 0 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -shortest -f flv \
  rtmps://broadcast.api.video:1936/s/<STREAM_KEY>
```

**Larix Broadcaster (Android/iOS)** — scan the QR code on `/control/`, which encodes the whole
connection URL. Pick RTMP, RTMPS or SRT from the dropdown under the QR; SRT gives the lowest
ingest latency of the three. Then set Video to 1280×720 @ 30 fps, bitrate 2.5 Mbps, keyframe
interval 1 s.

**No camera at all** — a test pattern, useful for M3/M4 work:

```bash
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=440 \
  -c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k \
  -g 30 -keyint_min 30 -sc_threshold 0 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -f flv \
  rtmps://broadcast.api.video:1936/s/<STREAM_KEY>
```

## Checks

```bash
npm run lint
npm run typecheck
npm test          # vitest: API, pairing, probe
npm run test:e2e  # playwright: the glasses UI in a real browser
```

## Latency expectations

RTMP ingest → HLS playback is inherently a few seconds. Realistic glass-to-glass latency is
roughly **3–10s** on the native/MSE HLS path depending on segment and GOP size, plus another
**0.5–1s** on the server-side frame relay. Sub-second would require WebRTC playback, which this
design does not provide. Measured latency will be shown in the viewer HUD rather than hidden.

Ingest settings dominate this — see the ready-to-paste commands above, all set to a 1 second
keyframe interval.

## Deployment note

The frame relay (M4) spawns a long-lived `ffmpeg` process per stream, so this cannot run on
Cloudflare Pages or any request-scoped serverless host. Target a container host (Fly.io,
Railway, a small VPS) with `ffmpeg` installed, optionally behind Cloudflare. The `Dockerfile`
and full deploy docs land with M5.

## Milestones

- **Step 0** — Web Apps plugin + Wearables MCP configured ✅
- **M0** — capability probe ✅ *(awaiting a run on real glasses)*
- **M1** — backend + api.video stream CRUD + `/control` page ✅
- **M2** — `/glasses` shell: D-pad focus, pairing flow, stream list, `/sim`, Playwright tests ✅
- **M3** — Path A player + HUD overlay
- **M4** — Path B relay + Path C polling, with strategy selection
- **M5** — offline shell, icons, README, Dockerfile, deploy docs
