/**
 * Types transcribed from the api.video OpenAPI specification
 * (https://github.com/apivideo/api.video-api-specification, `oas_apivideo.yaml`),
 * schemas `live-stream`, `live-stream-assets`, `live-stream-creation-payload`,
 * `live-stream-list-response`, `pagination` and `access-token`.
 *
 * Nothing here is written from memory — see the citations on each endpoint in
 * `client.ts`.
 */

/** Schema: `live-stream-assets`. */
export interface LiveStreamAssets {
  /** HLS manifest. For private streams this URL already carries a token. */
  hls?: string;
  iframe?: string;
  player?: string;
  thumbnail?: string;
}

/** Schema: `live-stream`. Only `liveStreamId` and `restreams` are required. */
export interface ApiVideoLiveStream {
  liveStreamId: string;
  name?: string;
  streamKey?: string;
  public?: boolean;
  broadcasting?: boolean;
  assets?: LiveStreamAssets;
  playerId?: string;
  restreams?: Array<{ name?: string; serverUrl?: string; streamKey?: string }>;
  createdAt?: string;
  updatedAt?: string;
}

/** Schema: `pagination`. */
export interface ApiVideoPagination {
  itemsTotal?: number;
  pagesTotal?: number;
  pageSize?: number;
  currentPage?: number;
}

/** Schema: `live-stream-list-response`. */
export interface ApiVideoListResponse {
  data: ApiVideoLiveStream[];
  pagination: ApiVideoPagination;
}

/** Schema: `live-stream-creation-payload`. `name` is the only required field. */
export interface CreateLiveStreamPayload {
  name: string;
  public?: boolean;
  playerId?: string;
}

/** Schema: `access-token`, returned by POST /auth/api-key and POST /auth/refresh. */
export interface ApiVideoAccessToken {
  token_type: string;
  expires_in: number;
  access_token: string;
  refresh_token: string;
}

/** api.video error bodies follow RFC 7807-ish shape: type/title/name/status. */
export class ApiVideoError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(message: string, status: number, detail = '') {
    super(message);
    this.name = 'ApiVideoError';
    this.status = status;
    this.detail = detail;
  }
}
