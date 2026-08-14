import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProbeReport, ProbeReportInput } from './types.js';

/**
 * Probe reports live in memory (newest first) and are appended to a daily
 * JSONL file so a restart or a `docker logs`-less host still lets us read what
 * the glasses reported.
 */
export class ProbeStore {
  readonly #dir: string;
  readonly #limit: number;
  #reports: ProbeReport[] = [];

  constructor(dir: string, limit: number) {
    this.#dir = dir;
    this.#limit = limit;
  }

  /** Re-hydrate memory from the most recent JSONL file. Safe to call on boot. */
  async load(): Promise<void> {
    let files: string[];
    try {
      files = (await readdir(this.#dir)).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      return; // no directory yet — nothing to load
    }
    const newest = files.at(-1);
    if (!newest) return;

    const lines = (await readFile(join(this.#dir, newest), 'utf8')).split('\n').filter(Boolean);
    const parsed: ProbeReport[] = [];
    for (const line of lines.slice(-this.#limit)) {
      try {
        parsed.push(JSON.parse(line) as ProbeReport);
      } catch {
        // A partially written line is not worth failing a boot over.
      }
    }
    this.#reports = parsed.reverse();
  }

  async add(input: ProbeReportInput, remoteAddress: string): Promise<ProbeReport> {
    const report: ProbeReport = {
      ...input,
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      remoteAddress,
    };

    this.#reports.unshift(report);
    if (this.#reports.length > this.#limit) this.#reports.length = this.#limit;

    await mkdir(this.#dir, { recursive: true });
    const day = report.receivedAt.slice(0, 10);
    await appendFile(join(this.#dir, `probe-${day}.jsonl`), `${JSON.stringify(report)}\n`, 'utf8');

    return report;
  }

  list(limit: number): ProbeReport[] {
    return this.#reports.slice(0, limit);
  }

  get(id: string): ProbeReport | undefined {
    return this.#reports.find((report) => report.id === id);
  }

  latest(): ProbeReport | undefined {
    return this.#reports[0];
  }
}

/** Plain-text rendering, so `curl .../api/probe/latest.txt` is readable in a terminal. */
export function renderReportText(report: ProbeReport): string {
  const { environment: env } = report;
  const lines = [
    `probe report ${report.id}`,
    `received     ${report.receivedAt}`,
    `client time  ${report.clientTime}`,
    `tag          ${report.tag ?? '-'}`,
    `remote       ${report.remoteAddress}`,
    '',
    `userAgent        ${env.userAgent}`,
    `devicePixelRatio ${env.devicePixelRatio ?? '?'}`,
    `screen           ${env.screenWidth ?? '?'}x${env.screenHeight ?? '?'}`,
    `innerWindow      ${env.innerWidth ?? '?'}x${env.innerHeight ?? '?'}`,
    '',
  ];

  const width = Math.max(...report.checks.map((check) => check.id.length));
  for (const check of report.checks) {
    const mark = check.ok === true ? 'PASS' : check.ok === false ? 'FAIL' : ' -- ';
    const ms = check.ms === undefined ? '' : ` (${Math.round(check.ms)}ms)`;
    lines.push(`[${mark}] ${check.id.padEnd(width)}  ${check.detail}${ms}`);
  }

  if (report.samples && Object.keys(report.samples).length > 0) {
    lines.push('', 'samples:');
    for (const [key, value] of Object.entries(report.samples)) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
