/**
 * Downloads a small MP4 into public/samples/ so the probe can test video
 * playback from our own origin. Optional: without it the probe falls back to
 * the cross-origin URL in PROBE_SAMPLE_MP4_URL.
 *
 * Having both matters — if same-origin MP4 plays and cross-origin HLS does not,
 * the problem is the network/CDN, not the <video> element.
 *
 *   npm run fetch:samples
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url =
  process.env.PROBE_SAMPLE_MP4_URL ??
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';
const target = join(root, 'public', 'samples', 'sample.mp4');

const response = await fetch(url);
if (!response.ok) {
  console.error(`Failed to download ${url}: HTTP ${response.status}`);
  process.exit(1);
}

const bytes = Buffer.from(await response.arrayBuffer());
await mkdir(dirname(target), { recursive: true });
await writeFile(target, bytes);
console.log(`wrote public/samples/sample.mp4 (${bytes.length} bytes) from ${url}`);
