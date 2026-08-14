import { config as loadDotenv } from 'dotenv';

loadDotenv();

/**
 * Configuration for the whole service.
 *
 * Milestone 0 only needs the probe-related settings, so the api.video / JWT
 * settings are optional here and validated by the milestones that introduce
 * them (M1 for api.video, M2 for JWT_SECRET). `requireForMilestone()` below is
 * the single place where "fail fast with a clear message" is implemented.
 */
export interface AppConfig {
  port: number;
  host: string;
  /** Public HTTPS origin the glasses will load, e.g. https://xyz.trycloudflare.com */
  publicBaseUrl: string | undefined;
  /** Root for anything the server persists (paired devices, probe reports). */
  dataDir: string;
  /** Directory where probe reports are appended as JSONL. */
  probeLogDir: string;
  /** How long a pairing code stays claimable, in seconds. */
  pairingCodeTtl: number;
  /** Claim attempts allowed per client per minute. */
  pairClaimLimit: number;
  /** Max probe reports kept in memory for `GET /api/probe`. */
  probeMemoryLimit: number;
  /** Cross-origin HLS sample used by the probe when no same-origin one exists. */
  sampleHlsUrl: string;
  /** MP4 sample used by the probe; overridden by a same-origin file when present. */
  sampleMp4Url: string;
  /** Present only from M1 onwards. */
  apiVideoKey: string | undefined;
  apiVideoEnv: 'sandbox' | 'production';
  /** Testing escape hatch: point the client at a local api.video stub. */
  apiVideoBaseUrl: string | undefined;
  /** Optional shared secret guarding /api/streams and /control. */
  controlToken: string | undefined;
  /** How long a stream's broadcasting flag is reused before re-asking api.video. */
  statusCacheTtlMs: number;
  jwtSecret: string | undefined;
}

interface IntRange {
  min?: number;
  max?: number;
}

/**
 * A misconfigured number must fail at startup, not at the first request.
 * `parseInt` is too forgiving for that — it reads "8080abc" as 8080 and "0x10"
 * as 0 — so the value has to be a plain integer and land inside its range.
 */
function int(name: string, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER }: IntRange = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${name}: expected an integer, got "${raw}"`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: expected an integer between ${min} and ${max}, got ${parsed}`);
  }
  return parsed;
}

/**
 * The glasses runtime and service workers both require HTTPS, so a plain-http
 * PUBLIC_BASE_URL is a deployment mistake worth catching at startup rather than
 * on the device. localhost is exempt — it is the documented dev setup.
 */
function url(name: string, { requireHttps = false } = {}): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid ${name}: expected an absolute URL, got "${raw}"`);
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (requireHttps && parsed.protocol !== 'https:' && !isLocal) {
    throw new Error(`Invalid ${name}: the glasses runtime requires HTTPS, got "${parsed.protocol}//"`);
  }
  return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, ''));
}

/**
 * An empty value means "not set". `.env.example` ships keys with empty values
 * for the operator to fill in, so `VAR=` must fall back to the default rather
 * than override it with an empty string.
 */
function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

export function loadConfig(): AppConfig {
  const apiVideoEnv = str('API_VIDEO_ENV', 'sandbox');
  if (apiVideoEnv !== 'sandbox' && apiVideoEnv !== 'production') {
    throw new Error(`Invalid API_VIDEO_ENV: expected "sandbox" or "production", got "${apiVideoEnv}"`);
  }

  return {
    port: int('PORT', 3000, { min: 1, max: 65_535 }),
    host: str('HOST', '0.0.0.0'),
    publicBaseUrl: url('PUBLIC_BASE_URL', { requireHttps: true }),
    dataDir: str('DATA_DIR', 'data'),
    probeLogDir: str('PROBE_LOG_DIR', 'data/probe'),
    // 0 is allowed: it makes every code expire on issue, which the tests use.
    pairingCodeTtl: int('PAIRING_CODE_TTL', 300, { min: 0, max: 86_400 }),
    pairClaimLimit: int('PAIR_CLAIM_LIMIT', 10, { min: 1, max: 1_000 }),
    probeMemoryLimit: int('PROBE_MEMORY_LIMIT', 50, { min: 1, max: 10_000 }),
    // Apple's public HLS reference stream. Verified to send
    // `Access-Control-Allow-Origin: *`, which the MSE/hls.js path needs.
    sampleHlsUrl: str(
      'PROBE_SAMPLE_HLS_URL',
      'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
    ),
    sampleMp4Url: str(
      'PROBE_SAMPLE_MP4_URL',
      'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
    ),
    apiVideoKey: process.env.API_VIDEO_KEY || undefined,
    apiVideoEnv,
    apiVideoBaseUrl: url('API_VIDEO_BASE_URL'),
    controlToken: process.env.CONTROL_TOKEN || undefined,
    statusCacheTtlMs: int('STATUS_CACHE_TTL_MS', 5000, { min: 0, max: 300_000 }),
    jwtSecret: process.env.JWT_SECRET || undefined,
  };
}

/**
 * Fail fast, with a message that says exactly what to set and where.
 * Called by the milestone that actually needs the variable — M0–M2 all treat
 * their optional settings as feature switches instead (see `app.ts`), so the
 * first caller arrives with the M5 deploy checks.
 *
 * Only strings can be "missing": every numeric setting has a default, and 0 is
 * a legitimate value for several of them.
 */
export function requireConfig(config: AppConfig, keys: Array<keyof AppConfig>): void {
  const missing = keys.filter((key) => {
    const value = config[key];
    return value === undefined || (typeof value === 'string' && value.trim() === '');
  });
  if (missing.length > 0) {
    const envNames = missing.map((key) => CONFIG_ENV_NAMES[key] ?? String(key));
    throw new Error(
      `Missing required configuration: ${envNames.join(', ')}. ` +
        `Copy .env.example to .env and fill these in.`,
    );
  }
}

const CONFIG_ENV_NAMES: Partial<Record<keyof AppConfig, string>> = {
  publicBaseUrl: 'PUBLIC_BASE_URL',
  apiVideoKey: 'API_VIDEO_KEY',
  apiVideoEnv: 'API_VIDEO_ENV',
  controlToken: 'CONTROL_TOKEN',
  jwtSecret: 'JWT_SECRET',
};
