import {
  API_VIDEO_RTMP_URL,
  API_VIDEO_RTMPS_URL,
  API_VIDEO_SRT_HOST,
  type ApiVideoClient,
} from '../apivideo/client.js';
import type { ApiVideoLiveStream } from '../apivideo/types.js';

/**
 * How long the client should wait before asking for a fresh playback URL.
 *
 * For a private stream the token is embedded in `assets.hls` by api.video and
 * the docs do not state a TTL for live tokens
 * (https://docs.api.video/delivery/video-privacy-access-management describes
 * one-use tokens and 24h sessions for VOD). We therefore re-fetch well inside
 * any plausible window rather than assume one.
 */
const PLAYBACK_REFRESH_SECONDS = 240;

/** What the frontends see. Deliberately not the raw api.video shape. */
export interface StreamSummary {
  id: string;
  name: string;
  public: boolean;
  broadcasting: boolean;
  createdAt: string | null;
  thumbnail: string | null;
  hls: string | null;
}

/** Adds the ingest credentials. Control page only — never sent to the glasses. */
export interface StreamWithIngest extends StreamSummary {
  ingest: {
    /** Goes in the encoder's "Stream Key" field. */
    streamKey: string;
    /** Server + single-URL form for each protocol api.video accepts. */
    rtmp: { server: string; url: string };
    rtmps: { server: string; url: string };
    srt: { url: string };
  };
}

/** Protocols the QR endpoint can encode. */
export const INGEST_PROTOCOLS = ['rtmp', 'rtmps', 'srt'] as const;
export type IngestProtocol = (typeof INGEST_PROTOCOLS)[number];

export function ingestUrlFor(stream: StreamWithIngest, protocol: IngestProtocol): string {
  if (protocol === 'rtmps') return stream.ingest.rtmps.url;
  if (protocol === 'srt') return stream.ingest.srt.url;
  return stream.ingest.rtmp.url;
}

export interface PlaybackInfo {
  id: string;
  hls: string | null;
  public: boolean;
  broadcasting: boolean;
  /** Seconds until the client should call this endpoint again. */
  refreshAfter: number;
}

export interface StatusInfo {
  id: string;
  broadcasting: boolean;
  checkedAt: string;
  /** True when served from cache rather than a fresh api.video call. */
  cached: boolean;
}

export class StreamService {
  readonly #client: ApiVideoClient;
  readonly #statusTtlMs: number;
  readonly #statusCache = new Map<string, { checkedAt: number; broadcasting: boolean }>();
  /** One in-flight api.video call per stream id, shared by all callers. */
  readonly #inFlight = new Map<string, Promise<ApiVideoLiveStream>>();

  constructor(client: ApiVideoClient, statusTtlMs: number) {
    this.#client = client;
    this.#statusTtlMs = statusTtlMs;
  }

  async create(name: string, isPublic: boolean): Promise<StreamWithIngest> {
    const stream = await this.#client.createLiveStream({ name, public: isPublic });
    return toStreamWithIngest(stream);
  }

  async list(): Promise<StreamWithIngest[]> {
    const response = await this.#client.listLiveStreams({ pageSize: 100, sortBy: 'createdAt', sortOrder: 'desc' });
    return response.data.map(toStreamWithIngest);
  }

  async get(id: string): Promise<StreamWithIngest> {
    return toStreamWithIngest(await this.#client.getLiveStream(id));
  }

  async remove(id: string): Promise<void> {
    await this.#client.deleteLiveStream(id);
    this.#statusCache.delete(id);
  }

  /**
   * Playback URL for the viewer. Always a fresh fetch: for private streams the
   * token lives inside `assets.hls`, so a cached URL is a stale token.
   */
  async playback(id: string): Promise<PlaybackInfo> {
    const stream = await this.#client.getLiveStream(id);
    this.#rememberStatus(id, stream.broadcasting === true);
    return {
      id: stream.liveStreamId,
      hls: stream.assets?.hls ?? null,
      public: stream.public !== false,
      broadcasting: stream.broadcasting === true,
      refreshAfter: PLAYBACK_REFRESH_SECONDS,
    };
  }

  /**
   * Is the stream receiving ingest right now? Cached and de-duplicated so a
   * roomful of clients polling cannot turn into a roomful of api.video calls.
   */
  async status(id: string): Promise<StatusInfo> {
    const cached = this.#statusCache.get(id);
    if (cached && Date.now() - cached.checkedAt < this.#statusTtlMs) {
      return {
        id,
        broadcasting: cached.broadcasting,
        checkedAt: new Date(cached.checkedAt).toISOString(),
        cached: true,
      };
    }

    let pending = this.#inFlight.get(id);
    if (!pending) {
      pending = this.#client.getLiveStream(id).finally(() => this.#inFlight.delete(id));
      this.#inFlight.set(id, pending);
    }

    const stream = await pending;
    const broadcasting = stream.broadcasting === true;
    this.#rememberStatus(id, broadcasting);

    return { id, broadcasting, checkedAt: new Date().toISOString(), cached: false };
  }

  #rememberStatus(id: string, broadcasting: boolean): void {
    this.#statusCache.set(id, { checkedAt: Date.now(), broadcasting });
  }
}

function toStreamWithIngest(stream: ApiVideoLiveStream): StreamWithIngest {
  const streamKey = stream.streamKey ?? '';
  return {
    id: stream.liveStreamId,
    name: stream.name ?? '(unnamed)',
    // `public` is optional in the schema; api.video defaults streams to public.
    public: stream.public !== false,
    broadcasting: stream.broadcasting === true,
    createdAt: stream.createdAt ?? null,
    thumbnail: stream.assets?.thumbnail ?? null,
    hls: stream.assets?.hls ?? null,
    ingest: {
      streamKey,
      rtmp: { server: API_VIDEO_RTMP_URL, url: `${API_VIDEO_RTMP_URL}/${streamKey}` },
      rtmps: { server: API_VIDEO_RTMPS_URL, url: `${API_VIDEO_RTMPS_URL}/${streamKey}` },
      srt: { url: `${API_VIDEO_SRT_HOST}?streamid=${encodeURIComponent(streamKey)}` },
    },
  };
}
