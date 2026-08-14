import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { signDeviceToken, verifyDeviceToken, JwtError } from './jwt.js';

/** A device that completed pairing. Revoking deletes the record. */
export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string;
}

interface PendingCode {
  code: string;
  expiresAt: number;
}

/**
 * How stale `lastSeenAt` is allowed to get before it is written to disk again.
 * Without this, every single glasses request rewrites the whole device file.
 */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

/** Bounds the pending-code list; codes also expire on their own TTL. */
const MAX_PENDING_CODES = 100;

export class PairingError extends Error {
  readonly reason: 'invalid_code' | 'expired_code' | 'invalid_token' | 'revoked';

  constructor(reason: PairingError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Pairing codes and device tokens.
 *
 * The glasses cannot render a usable password field, so pairing is: control
 * page mints a 6-digit code, the wearer types it with the D-pad digit picker,
 * and the server swaps it for a long-lived device token. Codes are single use
 * and short lived; tokens are revoked by deleting the device record, so a
 * stolen token dies the moment the device is removed on /control.
 */
export class PairingService {
  readonly #secret: string;
  readonly #ttlMs: number;
  readonly #storePath: string;
  #pending: PendingCode[] = [];
  #devices = new Map<string, PairedDevice>();
  /** Tail of the write chain, so two requests never interleave a save. */
  #writes: Promise<void> = Promise.resolve();

  constructor(secret: string, ttlSeconds: number, storePath: string) {
    this.#secret = secret;
    this.#ttlMs = ttlSeconds * 1000;
    this.#storePath = storePath;
  }

  /** Reload paired devices so a restart does not unpair every device. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.#storePath, 'utf8');
      const parsed = JSON.parse(raw) as PairedDevice[];
      this.#devices = new Map(parsed.map((device) => [device.id, device]));
    } catch {
      this.#devices = new Map(); // no file yet, or unreadable — start empty
    }
  }

  /**
   * Saves are serialised through one chain: concurrent glasses requests each
   * rewrite the whole file, and two of them interleaving would leave a torn
   * store that unpairs every device on the next boot.
   */
  #persist(): Promise<void> {
    const next = this.#writes.then(
      () => this.#writeStore(),
      () => this.#writeStore(), // a failed save must not poison the chain
    );
    this.#writes = next.catch(() => undefined);
    return next;
  }

  async #writeStore(): Promise<void> {
    await mkdir(dirname(this.#storePath), { recursive: true });
    const payload = JSON.stringify([...this.#devices.values()], null, 2);
    // Write-then-rename: a crash mid-write leaves the previous file intact
    // instead of a truncated one that no longer parses.
    const temporary = `${this.#storePath}.${process.pid}.tmp`;
    await writeFile(temporary, payload, 'utf8');
    await rename(temporary, this.#storePath);
  }

  /** Mints a 6-digit code. Called by the control page. */
  createCode(): { code: string; expiresAt: string; ttlSeconds: number } {
    this.#prune();
    // randomInt is uniform; padStart keeps leading zeros so it is always 6 digits.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = Date.now() + this.#ttlMs;
    this.#pending.push({ code, expiresAt });
    // Oldest first, so a burst of unclaimed codes cannot grow without bound.
    if (this.#pending.length > MAX_PENDING_CODES) {
      this.#pending.splice(0, this.#pending.length - MAX_PENDING_CODES);
    }
    return {
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      ttlSeconds: Math.floor(this.#ttlMs / 1000),
    };
  }

  /** Exchanges a code for a device token. The code cannot be reused. */
  async claim(code: string, deviceName: string): Promise<{ token: string; device: PairedDevice }> {
    this.#prune();
    const index = this.#pending.findIndex((pending) => pending.code === code);
    if (index === -1) {
      throw new PairingError('invalid_code', 'That code is not valid. Ask for a new one.');
    }
    this.#pending.splice(index, 1); // single use, even if the rest fails

    const device: PairedDevice = {
      id: randomUUID(),
      name: deviceName.slice(0, 60) || 'Glasses',
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    this.#devices.set(device.id, device);
    await this.#persist();

    return { token: signDeviceToken(device.id, this.#secret), device };
  }

  /** Verifies a device token and refreshes lastSeenAt. Throws if revoked. */
  async authenticate(token: string): Promise<PairedDevice> {
    let deviceId: string;
    try {
      deviceId = verifyDeviceToken(token, this.#secret).sub;
    } catch (error) {
      throw new PairingError('invalid_token', error instanceof JwtError ? error.message : 'Invalid token');
    }

    const device = this.#devices.get(deviceId);
    if (!device) {
      throw new PairingError('revoked', 'This device has been removed. Pair it again.');
    }

    // Kept in memory always, written at most once a minute per device: the
    // glasses call this on every request and the file holds every record.
    const now = Date.now();
    const lastWritten = Date.parse(device.lastSeenAt);
    device.lastSeenAt = new Date(now).toISOString();
    if (!Number.isFinite(lastWritten) || now - lastWritten >= LAST_SEEN_WRITE_INTERVAL_MS) {
      await this.#persist();
    }
    return device;
  }

  listDevices(): PairedDevice[] {
    return [...this.#devices.values()].sort((a, b) => b.pairedAt.localeCompare(a.pairedAt));
  }

  async revoke(deviceId: string): Promise<boolean> {
    const existed = this.#devices.delete(deviceId);
    if (existed) await this.#persist();
    return existed;
  }

  /** Number of codes still claimable — surfaced on the control page. */
  pendingCount(): number {
    this.#prune();
    return this.#pending.length;
  }

  #prune(): void {
    const now = Date.now();
    this.#pending = this.#pending.filter((pending) => pending.expiresAt > now);
  }
}

export function devicesStorePath(dataDir: string): string {
  return join(dataDir, 'devices.json');
}
