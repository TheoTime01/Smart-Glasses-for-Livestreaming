import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, requireConfig, type AppConfig } from '../src/config.js';

/**
 * Configuration mistakes must stop the process at startup with a message that
 * names the variable — not surface as a wrong port or a silent default hours
 * later.
 */

const TOUCHED = [
  'PORT',
  'PAIRING_CODE_TTL',
  'PAIR_CLAIM_LIMIT',
  'PROBE_MEMORY_LIMIT',
  'STATUS_CACHE_TTL_MS',
  'PUBLIC_BASE_URL',
  'API_VIDEO_BASE_URL',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));
  for (const key of TOUCHED) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('numeric settings', () => {
  it('falls back to the default when unset or empty', () => {
    expect(loadConfig().port).toBe(3000);
    process.env.PORT = '   ';
    expect(loadConfig().port).toBe(3000);
  });

  it('rejects values parseInt would silently truncate', () => {
    for (const raw of ['8080abc', '0x10', '3.5', 'nope', '--1']) {
      process.env.PORT = raw;
      expect(() => loadConfig(), raw).toThrow(/Invalid PORT/);
    }
  });

  it('rejects out-of-range values', () => {
    process.env.PORT = '70000';
    expect(() => loadConfig()).toThrow(/between 1 and 65535/);

    process.env.PORT = '3000';
    process.env.PAIR_CLAIM_LIMIT = '0';
    expect(() => loadConfig()).toThrow(/Invalid PAIR_CLAIM_LIMIT/);
  });

  it('keeps 0 for the settings where it is meaningful', () => {
    process.env.PAIRING_CODE_TTL = '0';
    process.env.STATUS_CACHE_TTL_MS = '0';
    const config = loadConfig();
    expect(config.pairingCodeTtl).toBe(0);
    expect(config.statusCacheTtlMs).toBe(0);
  });
});

describe('URL settings', () => {
  it('requires HTTPS for the public origin, since the glasses will not load http', () => {
    process.env.PUBLIC_BASE_URL = 'http://example.trycloudflare.com';
    expect(() => loadConfig()).toThrow(/requires HTTPS/);
  });

  it('allows http on localhost, which is the documented dev setup', () => {
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
    expect(loadConfig().publicBaseUrl).toBe('http://localhost:3000');
  });

  it('strips a trailing slash so URLs are built the same way everywhere', () => {
    process.env.PUBLIC_BASE_URL = 'https://xyz.trycloudflare.com/';
    expect(loadConfig().publicBaseUrl).toBe('https://xyz.trycloudflare.com');
  });

  it('rejects a value that is not a URL at all', () => {
    process.env.API_VIDEO_BASE_URL = 'sandbox.api.video';
    expect(() => loadConfig()).toThrow(/Invalid API_VIDEO_BASE_URL/);
  });
});

describe('requireConfig', () => {
  const base = (): AppConfig => ({ ...loadConfig(), apiVideoKey: undefined, jwtSecret: '  ' });

  it('names every missing variable, and only the missing ones', () => {
    expect(() => requireConfig(base(), ['apiVideoKey', 'jwtSecret', 'apiVideoEnv'])).toThrow(
      /API_VIDEO_KEY, JWT_SECRET\./,
    );
  });

  it('does not treat a numeric 0 as missing', () => {
    const config = { ...base(), apiVideoKey: 'set', jwtSecret: 'set', statusCacheTtlMs: 0, port: 0 };
    expect(() => requireConfig(config, ['statusCacheTtlMs', 'port', 'apiVideoKey'])).not.toThrow();
  });
});
