/** Result of a single capability check run on the device. */
export interface ProbeCheck {
  /** Stable machine id, e.g. `mse.available`. */
  id: string;
  /** Short human label shown on the HUD. */
  label: string;
  /** true = supported, false = not supported, null = inconclusive/skipped. */
  ok: boolean | null;
  /** Free-form evidence: error codes, type strings, timings. */
  detail: string;
  /** How long the check took, in ms. */
  ms?: number;
}

export interface ProbeEnvironment {
  userAgent: string;
  devicePixelRatio: number | null;
  screenWidth: number | null;
  screenHeight: number | null;
  innerWidth: number | null;
  innerHeight: number | null;
}

/** What the client POSTs to /api/probe. */
export interface ProbeReportInput {
  clientTime: string;
  environment: ProbeEnvironment;
  checks: ProbeCheck[];
  /** Which sample URLs the run actually used. */
  samples?: Record<string, string>;
  /** Free-form label the tester can set via ?tag=. */
  tag?: string;
}

/** What the server stores and returns. */
export interface ProbeReport extends ProbeReportInput {
  id: string;
  receivedAt: string;
  remoteAddress: string;
}
