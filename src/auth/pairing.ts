import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#storePath), { recursive: true });
    await writeFile(this.#storePath, JSON.stringify([...this.#devices.values()], null, 2), 'utf8');
  }

  /** Mints a 6-digit code. Called by the control page. */
  createCode(): { code: string; expiresAt: string; ttlSeconds: number } {
    this.#prune();
    // randomInt is uniform; padStart keeps leading zeros so it is always 6 digits.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = Date.now() + this.#ttlMs;
    this.#pending.push({ code, expiresAt });
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

    // Cheap enough to write through; the file holds a handful of records.
    device.lastSeenAt = new Date().toISOString();
    await this.#persist();
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
