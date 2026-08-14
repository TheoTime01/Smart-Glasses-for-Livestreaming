import {
  ApiVideoError,
  type ApiVideoAccessToken,
  type ApiVideoListResponse,
  type ApiVideoLiveStream,
  type CreateLiveStreamPayload,
} from './types.js';

/**
 * Minimal api.video client — only the live stream surface this project needs.
 *
 * Every endpoint below is transcribed from the official OpenAPI specification
 * (https://github.com/apivideo/api.video-api-specification `oas_apivideo.yaml`),
 * cross-checked against https://docs.api.video/reference/api/Live-Streams.
 * The API key never leaves the server.
 *
 * Base URLs — `servers:` block of the spec:
 *   production https://ws.api.video
 *   sandbox    https://sandbox.api.video   (assets watermarked, deleted after 24h)
 */
export const API_VIDEO_BASE_URLS = {
  production: 'https://ws.api.video',
  sandbox: 'https://sandbox.api.video',
} as const;

/**
 * Ingest endpoints. Source: https://docs.api.video/live-streaming/create-a-live-stream
 * — the server URL goes in the encoder's *Server* field and the `streamKey` from
 * the create response goes in its *Stream Key* field. api.video accepts RTMP,
 * RTMPS and SRT. No separate sandbox ingest host is documented, so both
 * environments use these.
 *
 * The ports match what the api.video dashboard shows for a live stream. 1935 is
 * the RTMP default and the docs usually omit it; stating it explicitly helps on
 * networks where it matters and matches the dashboard exactly.
 */
export const API_VIDEO_RTMP_URL = 'rtmp://broadcast.api.video:1935/s';
export const API_VIDEO_RTMPS_URL = 'rtmps://broadcast.api.video:1936/s';
/** SRT carries the key as a `streamid` query parameter, not a path segment. */
export const API_VIDEO_SRT_HOST = 'srt://broadcast.api.video:6200';

/** Refresh the bearer token this many ms before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

export interface ApiVideoClientOptions {
  apiKey: string;
  environment: 'sandbox' | 'production';
  /** Overrides the environment's base URL. Only for pointing at a local stub. */
  baseUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

interface CachedToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class ApiVideoClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #token: CachedToken | null = null;
  /** De-duplicates concurrent authentications. */
  #pendingAuth: Promise<CachedToken> | null = null;

  constructor(options: ApiVideoClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? API_VIDEO_BASE_URLS[options.environment];
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /**
   * POST /auth/api-key — "Get Bearer Token".
   * Request `{ apiKey }` (schema `authenticate-payload`), response
   * `{ token_type, expires_in, access_token, refresh_token }` (schema `access-token`).
   */
  async authenticate(): Promise<void> {
    await this.#getToken(true);
  }

  /** POST /live-streams — "Create live stream". Responds 200 with a `live-stream`. */
  async createLiveStream(payload: CreateLiveStreamPayload): Promise<ApiVideoLiveStream> {
    return this.#request<ApiVideoLiveStream>('POST', '/live-streams', { body: payload });
  }

  /**
   * GET /live-streams — "List all live streams".
   * Query params: currentPage, pageSize, sortBy, sortOrder, name, streamKey.
   * Responds `{ data, pagination }` (schema `live-stream-list-response`).
   */
  async listLiveStreams(
    query: { currentPage?: number; pageSize?: number; sortBy?: string; sortOrder?: 'asc' | 'desc' } = {},
  ): Promise<ApiVideoListResponse> {
    return this.#request<ApiVideoListResponse>('GET', '/live-streams', { query });
  }

  /**
   * GET /live-streams/{liveStreamId} — "Retrieve live stream".
   *
   * This is also how playback URLs are obtained: for a private stream the
   * returned `assets.hls` already carries the access token, so a fresh GET is
   * the way to get a fresh URL. See
   * https://docs.api.video/delivery/private-video-on-hls-or-external-players
   * and https://docs.api.video/delivery/video-privacy-access-management.
   */
  async getLiveStream(liveStreamId: string): Promise<ApiVideoLiveStream> {
    return this.#request<ApiVideoLiveStream>('GET', `/live-streams/${encodeURIComponent(liveStreamId)}`);
  }

  /** DELETE /live-streams/{liveStreamId} — "Delete a live stream". Responds 204. */
  async deleteLiveStream(liveStreamId: string): Promise<void> {
    await this.#request<void>('DELETE', `/live-streams/${encodeURIComponent(liveStreamId)}`, {
      expectNoContent: true,
    });
  }

  /* ------------------------------------------------------------------ auth */

  async #getToken(force = false): Promise<CachedToken> {
    if (!force && this.#token && Date.now() < this.#token.expiresAt - TOKEN_SKEW_MS) {
      return this.#token;
    }
    // A forced authentication must not adopt an in-flight lazy one: the startup
    // credential check would then "pass" on a token minted before it ran.
    if (!force && this.#pendingAuth) return this.#pendingAuth;

    const previous = this.#token;
    const pending = (async () => {
      // Prefer the cheaper refresh when we already hold a refresh token.
      if (!force && previous) {
        try {
          return await this.#exchange('/auth/refresh', { refreshToken: previous.refreshToken });
        } catch {
          // Refresh tokens are single use and can go stale; fall through.
        }
      }
      return this.#exchange('/auth/api-key', { apiKey: this.#apiKey });
    })();
    this.#pendingAuth = pending;

    try {
      this.#token = await pending;
      return this.#token;
    } finally {
      // Only clear our own: a concurrent forced auth may have replaced it.
      if (this.#pendingAuth === pending) this.#pendingAuth = null;
    }
  }

  async #exchange(path: string, body: Record<string, string>): Promise<CachedToken> {
    const response = await this.#fetchWithTimeout(`${this.#baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await safeText(response);
      throw new ApiVideoError(
        `api.video authentication failed (HTTP ${response.status}). Check API_VIDEO_KEY and API_VIDEO_ENV.`,
        response.status,
        detail,
      );
    }

    const token = (await response.json()) as ApiVideoAccessToken;
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    };
  }

  /* --------------------------------------------------------------- request */

  async #request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      expectNoContent?: boolean;
      isRetry?: boolean;
    } = {},
  ): Promise<T> {
    const token = await this.#getToken();

    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    const response = await this.#fetchWithTimeout(url.toString(), init);

    // A token can be invalidated server-side before it expires; re-auth once.
    if (response.status === 401 && !options.isRetry) {
      this.#token = null;
      return this.#request<T>(method, path, { ...options, isRetry: true });
    }

    if (!response.ok) {
      const detail = await safeText(response);
      throw new ApiVideoError(
        `api.video ${method} ${path} failed (HTTP ${response.status})`,
        response.status,
        detail,
      );
    }

    if (options.expectNoContent || response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async #fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ApiVideoError(`api.video request timed out after ${this.#timeoutMs}ms`, 504);
      }
      throw new ApiVideoError(
        `api.video request failed: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}
