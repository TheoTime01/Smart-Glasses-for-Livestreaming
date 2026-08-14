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
  /** Directory where probe reports are appended as JSONL. */
  probeLogDir: string;
  /** Max probe reports kept in memory for `GET /api/probe`. */
  probeMemoryLimit: number;
  /** Cross-origin HLS sample used by the probe when no same-origin one exists. */
  sampleHlsUrl: string;
  /** MP4 sample used by the probe; overridden by a same-origin file when present. */
  sampleMp4Url: string;
  /** Present only from M1 onwards. */
  apiVideoKey: string | undefined;
  apiVideoEnv: 'sandbox' | 'production';
  jwtSecret: string | undefined;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: expected an integer, got "${raw}"`);
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  const apiVideoEnv = process.env.API_VIDEO_ENV ?? 'sandbox';
  if (apiVideoEnv !== 'sandbox' && apiVideoEnv !== 'production') {
    throw new Error(`Invalid API_VIDEO_ENV: expected "sandbox" or "production", got "${apiVideoEnv}"`);
  }

  return {
    port: int('PORT', 3000),
    host: process.env.HOST ?? '0.0.0.0',
    publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined,
    probeLogDir: process.env.PROBE_LOG_DIR ?? 'data/probe',
    probeMemoryLimit: int('PROBE_MEMORY_LIMIT', 50),
    // Apple's public HLS reference stream. Verified to send
    // `Access-Control-Allow-Origin: *`, which the MSE/hls.js path needs.
    sampleHlsUrl:
      process.env.PROBE_SAMPLE_HLS_URL ??
      'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
    sampleMp4Url:
      process.env.PROBE_SAMPLE_MP4_URL ??
      'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
    apiVideoKey: process.env.API_VIDEO_KEY || undefined,
    apiVideoEnv,
    jwtSecret: process.env.JWT_SECRET || undefined,
  };
}

/**
 * Fail fast, with a message that says exactly what to set and where.
 * Called by the milestone that actually needs the variable.
 */
export function requireConfig(config: AppConfig, keys: Array<keyof AppConfig>): void {
  const missing = keys.filter((key) => config[key] === undefined || config[key] === '');
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
  jwtSecret: 'JWT_SECRET',
};
