# Claude Code prompt — api.video live viewer for Meta Ray-Ban Display

> Paste everything below the line into Claude Code (or save it in the repo as `SPEC.md` and say "implement SPEC.md, milestone 0 first").

---

## Step 0 — tooling setup (do this before anything else)

Use https://wearables.developer.meta.com/docs/develop/webapps/ai-assisted-mcp/ to configure AI-assisted Meta Ray-Ban Display Web Apps development. Inspect this project and AI tool setup first. If the Web Apps AI Coding plugin is missing, install it using the instructions for my tool. Add the Wearables MCP endpoint https://mcp.developer.meta.com/wearables, verify that the plugin skills and search_webapps_docs are available, and ask search_webapps_docs what I should install and check before building my first Web App. Do not edit app code until both tools are ready and the test query returns relevant guidance.

## Context and ground rules

Once the tooling above is confirmed working, call `search_webapps_docs` for the current Meta Ray-Ban Display (MRBD) Web Apps constraints, setup, testing and publishing guidance. Also read `https://wearables.developer.meta.com/docs/develop/webapps/build/`. If `search_webapps_docs` is unavailable, say so explicitly and fall back to the build guide.

Do **not** hardcode api.video endpoints, paths or payload shapes from memory. Fetch the current reference from `https://docs.api.video` (live streams, authentication, private live streams, player/HLS assets) and cite in comments which doc page each endpoint came from. If a doc lookup fails, stop and tell me rather than guessing.

Work in small, reviewable commits. Run lint/typecheck/tests after each milestone. Never put the api.video API key in client-side code.

## What I'm building

A web app that runs **on the Meta Ray-Ban Display HUD** and shows a live video feed coming from **any RTMP source** (OBS, a Raspberry Pi with `ffmpeg`, an Android phone running Larix Broadcaster, an ONVIF PTZ camera restreamed via ffmpeg). Ingest and delivery go through **api.video**. A separate control page, used on a normal desktop/phone browser, creates and manages streams and shows the RTMP credentials.

Three surfaces:

1. `/glasses` — the MRBD Web App. 600×600, D-pad only, dark additive UI.
2. `/control` — normal browser. Create/stop streams, copy RTMP URL + key, show a QR code, generate pairing codes.
3. `/api` + WebSocket — Node backend holding the api.video key, minting viewer tokens, and running the fallback frame relay.

## Hard platform constraints (from the MRBD Web Apps docs — respect all of these)

- Fixed **600×600 px** viewport. `body { width:600px; height:600px; overflow:hidden }`. No scrolling anywhere, ever.
- **Additive waveguide display**: pure black renders as fully transparent. Use `#000` backgrounds, bright high-contrast foregrounds. Letterbox bars around the video must be pure black.
- Body text ≥16px, primary content 20–24px.
- **No mouse, no touch, no physical keyboard.** Input arrives as `ArrowUp/Down/Left/Right`, `Enter`, `Escape` from the Neural Band and temple captouch. Every interactive element must carry a `.focusable` class, be reachable by D-pad, and show a visible focus ring. Minimum 88px tap-target height.
- **No camera, no microphone** available to Web Apps.
- Text entry only via the on-glasses composer, which opens on **focus + pinch**, not on programmatic `.focus()`. `type="password"`, `date`, `checkbox`, `radio` do **not** open it. Design so the app is fully usable if the composer is unavailable.
- `localStorage` / `sessionStorage`, 5 MB each. Service Workers + Cache API are available for offline shell caching (HTTPS required). Do not call `history.pushState()` or do SPA routing before a sensor permission promise resolves.
- Icons: PNG ≥52×52 via `<link>` or web manifest. **SVG icons are not supported.**
- Required `<head>` metadata:
  ```html
  <meta name="description" content="...">
  <meta name="mrbd-web-app-capable" content="yes">
  <meta name="viewport" content="width=600, height=600, initial-scale=1.0, user-scalable=no">
  ```

## MILESTONE 0 — capability probe (do this first, before any player work)

Video playback is **not** listed in the documented MRBD Web App capability table. I do not know whether `<video>`, MSE, WebSocket, or blob URLs work in that runtime. Build `/probe` as a standalone 600×600 page that renders a plain-text report of:

- `!!window.MediaSource` and `MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')`
- `document.createElement('video').canPlayType('application/vnd.apple.mpegurl')`
- Whether a `<video>` element with a known-good sample HLS/MP4 fires `loadedmetadata` and `playing` (with a 10s timeout and the resulting `error.code`)
- WebSocket connect + binary frame receive round trip
- `URL.createObjectURL(blob)` on an `<img>`, and `<canvas>` `drawImage` + `createImageBitmap`
- `fetch` with `ReadableStream` body support
- `navigator.userAgent`, `devicePixelRatio`, `screen.width/height`, `window.innerWidth/innerHeight`

Results must be readable on the HUD (big text, one line per check, ✓/✗ + bright colour) **and** POSTed to `/api/probe` so I can read them server-side. Do not proceed to a default playback path until I paste you the probe output from the real glasses. Assume nothing.

## Architecture

Single Node 20 + TypeScript service (Fastify), serving the static frontends and the API from one origin — avoids CORS and mixed-content problems. No framework on the glasses page: vanilla HTML/CSS/JS, no bundler magic, no SPA router, keep the payload tiny. The control page can use whatever is convenient.

### Backend responsibilities

- `POST /api/streams` — create an api.video live stream, return `liveStreamId`, ingest URL + stream key, HLS playback URL, and whether it's public or private.
- `GET /api/streams` / `DELETE /api/streams/:id`
- `GET /api/streams/:id/status` — is it currently receiving ingest; cache and rate-limit, don't hammer api.video.
- `GET /api/streams/:id/playback` — returns the HLS URL plus, for private streams, a freshly minted api.video viewing token. Short TTL, refreshed by the client before expiry.
- `WS /ws/relay/:id` — the fallback frame relay (see below).
- `GET /api/streams/:id/frame.jpg` — single JPEG, for the ultra-safe polling path.

### Auth — pairing codes, not passwords

The glasses cannot render a usable password field. Implement:

1. Control page calls `POST /api/pair` → server returns a **6-digit numeric code**, TTL 5 minutes, single use.
2. Glasses page shows a **D-pad digit picker** (Left/Right selects the position, Up/Down changes the digit, Enter confirms). It must work with zero composer dependency; optionally offer a `type="number"` field as a shortcut for when the composer is available.
3. `POST /api/pair/claim` with the code → returns a long-lived device JWT, stored in `localStorage` as `mrbd.device_token`. All subsequent glasses calls use it.
4. Control page lists paired devices and can revoke them.

Sign JWTs with `JWT_SECRET`. Viewer tokens are separate, short-lived, and scoped to one stream id.

## Playback: three paths, runtime-selected

Implement all three behind a single `Player` interface with an explicit, overridable strategy (`?player=hls|relay|poll`, persisted in localStorage). Auto-selection order:

**Path A — native/MSE HLS.** `<video autoplay muted playsinline>`, native HLS if `canPlayType` says yes, otherwise `hls.js`. Tune for latency, not quality: `lowLatencyMode: true`, `liveSyncDuration` ~2s, `maxBufferLength` 4, `capLevelToPlayerSize: true`, start on the lowest rendition. Recover from `MEDIA_ERROR`/`NETWORK_ERROR` with bounded exponential backoff. If the probe shows no MSE and no native HLS, this path is disabled at build-time by feature detection, not by a crash.

**Path B — server-side frame relay (must be built regardless of whether Path A works).** The backend spawns `ffmpeg` pulling the api.video HLS playback URL and emitting JPEG frames scaled + letterboxed to exactly 600×600 on black, pushed as binary WebSocket messages. Requirements:
- Configurable FPS (default 6, range 1–15) and JPEG quality, changeable live from the glasses UI.
- One ffmpeg process per stream, shared across connected clients, torn down ~30s after the last client disconnects.
- Backpressure: if `ws.bufferedAmount` exceeds a threshold, drop frames rather than queue them.
- Client renders via `createImageBitmap` → `canvas` when available, else blob URL → `<img>` with the previous object URL revoked. Never leak object URLs.
- Reconnect with jittered backoff; show a bright "reconnecting" indicator.

**Path C — JPEG polling.** `<img>` re-fetched from `/api/streams/:id/frame.jpg?t=` at 1–2 fps. Dumbest possible path; guaranteed to render; also useful as a battery-saving mode. Server caches the last decoded frame so polling doesn't spawn extra ffmpeg work.

## Glasses UI screens

1. **Pair** — digit picker, big status line.
2. **Stream list** — D-pad vertical list of streams with live/offline dot. Enter opens the viewer. No scrolling: paginate with Left/Right if more than fits, and show "3 of 7".
3. **Viewer** — full-bleed video/canvas centred in 600×600 on pure black. An overlay HUD that auto-hides after 4s and returns on any D-pad event, showing: live/offline, current path (HLS/relay/poll), measured fps, estimated latency, and a bitrate or frame-size readout. Enter toggles the HUD. Escape returns to the list. Up/Down changes relay fps when in relay mode.
4. **Error / offline** — plain, bright, actionable text. Never a blank screen.

## Testing without wearing the glasses

Build `/sim`: a page that hosts `/glasses` in a 600×600 iframe on a black backdrop, forwards keyboard arrows/Enter/Escape into it, and has on-screen buttons that dispatch the same synthetic events. Add Playwright tests asserting: the document never scrolls, every `.focusable` is reachable by pure arrow-key traversal from the first element, focus is always visible, and the viewer falls back correctly when MSE is stubbed out as unavailable.

## Deployment

- HTTPS is mandatory (service workers, geolocation, and the glasses runtime all require it).
- Ship a `Dockerfile` with `ffmpeg` installed. Cloudflare Pages cannot host the relay — the backend needs a long-lived process, so target a container host (Fly.io / Railway / a small VPS) and optionally put Cloudflare in front. Document this trade-off in the README.
- Env: `API_VIDEO_KEY`, `API_VIDEO_ENV` (sandbox|production), `PUBLIC_BASE_URL`, `JWT_SECRET`, `RELAY_FPS`, `RELAY_JPEG_QUALITY`, `PAIRING_CODE_TTL`. Provide `.env.example`. Fail fast with a clear message on missing config.
- README must include ready-to-paste ingest commands for: OBS, a Raspberry Pi (`libcamera-vid | ffmpeg`), ffmpeg restreaming an ONVIF/RTSP camera, and Larix Broadcaster on Android — all with **keyframe interval 1s, 720p30 max, modest bitrate**, because GOP length dominates HLS latency.

## Latency expectations — state these in the README

RTMP ingest → HLS playback is inherently a few seconds. Realistic glass-to-glass latency is roughly 3–10s on Path A depending on segment and GOP size, plus ~0.5–1s on Path B. Sub-second would require WebRTC playback, which this design does not provide. Do not silently "optimise" toward a promise the architecture can't keep — surface the measured latency in the HUD instead.

## Milestones

- **Step 0** — plugin + Wearables MCP installed and verified, test query answered. No app code yet.
- **M0** — capability probe (`/probe`), deployed and testable. **Stop and report.**
- **M1** — backend + api.video stream CRUD + `/control` page with RTMP credentials and QR code.
- **M2** — `/glasses` shell: 600×600, D-pad focus system, pairing flow, stream list, `/sim` harness, Playwright tests.
- **M3** — Path A player + HUD overlay.
- **M4** — Path B relay (ffmpeg + WebSocket + canvas) and Path C polling, with strategy auto-selection and manual override.
- **M5** — offline shell via service worker, icons, MRBD metadata, README, Dockerfile, deploy docs.

Start with M0 only. Ask me before making any assumption you can't verify from the docs.