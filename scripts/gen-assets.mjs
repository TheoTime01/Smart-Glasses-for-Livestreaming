/**
 * Generates the PNG assets the app needs.
 *
 * SVG icons are not supported on Meta Ray-Ban Display and icons must be >= 52x52
 * PNG, so we emit real PNGs. Python (and the plugin's favicon_generator.py) is
 * not available on this machine, so this is a minimal RGBA PNG encoder built on
 * node:zlib — no dependencies.
 *
 *   node scripts/gen-assets.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = ~0;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** @param {number} size @param {(x:number,y:number)=>[number,number,number,number]} shade */
function encodePng(size, shade) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter type: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = shade(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
      offset += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(relativePath, buffer) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buffer);
  console.log(`wrote ${relativePath} (${buffer.length} bytes)`);
}

// App icon: a bright play triangle inside a ring, on a dark (not pure black)
// plate so it stays visible on the additive display.
const ICON = 128;
write(
  'public/favicon.png',
  encodePng(ICON, (x, y) => {
    const cx = ICON / 2;
    const cy = ICON / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist > 60) return [0, 0, 0, 0];
    if (dist > 50) return [0x00, 0xd4, 0xff, 255];
    // Triangle pointing right, centred.
    const inTriangle = x > 46 && x < 92 && Math.abs(y - cy) < (92 - x) * 0.62;
    if (inTriangle) return [0xff, 0xff, 0xff, 255];
    return [0x1c, 0x1e, 0x21, 255];
  }),
);

// Probe test image: a 64x64 checkerboard with a bright border. Distinct enough
// that a decoded pixel readback proves the image really rendered.
write(
  'public/probe/dot.png',
  encodePng(64, (x, y) => {
    if (x < 3 || y < 3 || x > 60 || y > 60) return [0x00, 0xd4, 0xff, 255];
    const cell = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
    return cell ? [0xff, 0x5c, 0x5c, 255] : [0x35, 0xe0, 0x7a, 255];
  }),
);
