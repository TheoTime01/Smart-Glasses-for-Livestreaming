import type { ProbeCheck, ProbeEnvironment, ProbeReportInput } from './types.js';

export class ValidationError extends Error {}

const MAX_CHECKS = 64;
const MAX_STRING = 2000;

function str(value: unknown, field: string, { max = MAX_STRING } = {}): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  if (value.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return value;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number or null`);
  }
  return value;
}

function parseCheck(value: unknown, index: number): ProbeCheck {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError(`checks[${index}] must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (raw.ok !== true && raw.ok !== false && raw.ok !== null) {
    throw new ValidationError(`checks[${index}].ok must be true, false or null`);
  }
  const check: ProbeCheck = {
    id: str(raw.id, `checks[${index}].id`, { max: 80 }),
    label: str(raw.label, `checks[${index}].label`, { max: 120 }),
    ok: raw.ok,
    detail: str(raw.detail ?? '', `checks[${index}].detail`),
  };
  const ms = nullableNumber(raw.ms, `checks[${index}].ms`);
  if (ms !== null) check.ms = ms;
  return check;
}

function parseEnvironment(value: unknown): ProbeEnvironment {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError('environment must be an object');
  }
  const raw = value as Record<string, unknown>;
  return {
    userAgent: str(raw.userAgent ?? '', 'environment.userAgent'),
    devicePixelRatio: nullableNumber(raw.devicePixelRatio, 'environment.devicePixelRatio'),
    screenWidth: nullableNumber(raw.screenWidth, 'environment.screenWidth'),
    screenHeight: nullableNumber(raw.screenHeight, 'environment.screenHeight'),
    innerWidth: nullableNumber(raw.innerWidth, 'environment.innerWidth'),
    innerHeight: nullableNumber(raw.innerHeight, 'environment.innerHeight'),
  };
}

export function parseProbeReport(body: unknown): ProbeReportInput {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;

  if (!Array.isArray(raw.checks)) throw new ValidationError('checks must be an array');
  if (raw.checks.length === 0) throw new ValidationError('checks must not be empty');
  if (raw.checks.length > MAX_CHECKS) {
    throw new ValidationError(`checks must contain at most ${MAX_CHECKS} entries`);
  }

  const report: ProbeReportInput = {
    clientTime: str(raw.clientTime ?? new Date().toISOString(), 'clientTime', { max: 40 }),
    environment: parseEnvironment(raw.environment ?? {}),
    checks: raw.checks.map(parseCheck),
  };

  if (raw.samples !== undefined && raw.samples !== null) {
    if (typeof raw.samples !== 'object') throw new ValidationError('samples must be an object');
    const samples: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.samples as Record<string, unknown>)) {
      samples[str(key, 'samples key', { max: 40 })] = str(value, `samples.${key}`, { max: 500 });
    }
    report.samples = samples;
  }

  if (raw.tag !== undefined && raw.tag !== null && raw.tag !== '') {
    report.tag = str(raw.tag, 'tag', { max: 80 });
  }

  return report;
}
