import {
  PteroApiError,
  PteroHtmlResponseError,
  PteroRateLimitError,
} from './errors.js';
import type {
  AccountResponse,
  AllocationListResponse,
  BackupItem,
  BackupListResponse,
  CreateBackupOptions,
  FileListResponse,
  FileRenameEntry,
  PowerSignal,
  PteroErrorEnvelope,
  RateLimitInfo,
  ResourcesResponse,
  ScheduleListResponse,
  ServerListResponse,
  ServerResponse,
  SignedUrlResponse,
  StartupResponse,
  WebsocketCredentials,
  WebsocketCredentialsResponse,
} from './types.js';

/** Query parameter values accepted by the client. `undefined` entries are dropped. */
export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface PteroClientOptions {
  panelUrl: string;
  apiKey: string;
  /** Injection point for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const ACCEPT_HEADER = 'Application/vnd.pterodactyl.v1+json';

/**
 * Thin, typed wrapper over the Pterodactyl Client API.
 *
 * - Base path is `${panelUrl}/api/client`.
 * - Non-2xx responses become `PteroApiError` / `PteroRateLimitError` /
 *   `PteroHtmlResponseError`; nothing leaks the API key.
 * - Rate-limit headers are parsed off *every* response and exposed via `rateLimit()`.
 */
export class PteroClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private lastRateLimit: RateLimitInfo | undefined;

  constructor(opts: PteroClientOptions) {
    this.baseUrl = `${opts.panelUrl.replace(/\/+$/, '')}/api/client`;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('No fetch implementation available (Node 18+ or inject one).');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Low-level verbs                                                    */
  /* ------------------------------------------------------------------ */

  /** GET returning a parsed JSON body. */
  async get<T>(path: string, query?: QueryParams): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  /** POST with a JSON body. Returns `undefined` for 204 responses. */
  async post<T>(path: string, body?: unknown, query?: QueryParams): Promise<T> {
    return this.request<T>('POST', path, { body, query });
  }

  /** PUT with a JSON body. Returns `undefined` for 204 responses. */
  async put<T>(path: string, body?: unknown, query?: QueryParams): Promise<T> {
    return this.request<T>('PUT', path, { body, query });
  }

  /** DELETE. Pterodactyl answers 204 for every client-API delete. */
  async delete(path: string, query?: QueryParams): Promise<void> {
    await this.request<void>('DELETE', path, { query });
  }

  /** GET returning the raw response body as text (file contents are not JSON). */
  async getText(path: string, query?: QueryParams): Promise<string> {
    return this.request<string>('GET', path, { query, raw: 'text' });
  }

  /**
   * POST a raw (non-JSON) body — used by `files/write`, whose request body is the file
   * content verbatim. Returns `undefined` for the expected 204.
   */
  async postRaw(
    path: string,
    body: string,
    query?: QueryParams,
    contentType = 'text/plain',
  ): Promise<void> {
    await this.request<void>('POST', path, { rawBody: body, contentType, query });
  }

  /** Rate-limit state from the most recent response, if the panel sent the headers. */
  rateLimit(): RateLimitInfo | undefined {
    return this.lastRateLimit;
  }

  /* ------------------------------------------------------------------ */
  /* Core request                                                       */
  /* ------------------------------------------------------------------ */

  private buildUrl(path: string, query?: QueryParams): string {
    const normalisedPath = path.startsWith('/') ? path : `/${path}`;
    let url = `${this.baseUrl}${normalisedPath}`;
    if (query) {
      // URLSearchParams handles percent-encoding of `/`, spaces and everything else in
      // file paths correctly; hand-rolled concatenation does not.
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        params.append(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      rawBody?: string;
      contentType?: string;
      query?: QueryParams;
      raw?: 'text';
    } = {},
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: ACCEPT_HEADER,
    };

    let requestBody: string | undefined;
    if (opts.rawBody !== undefined) {
      requestBody = opts.rawBody;
      headers['Content-Type'] = opts.contentType ?? 'text/plain';
    } else if (opts.body !== undefined) {
      requestBody = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }

    const init: RequestInit = { method, headers };
    if (requestBody !== undefined) init.body = requestBody;

    const response = await this.fetchImpl(url, init);

    this.lastRateLimit = parseRateLimitHeaders(response.headers);

    if (!response.ok) {
      throw await this.toError(response, path);
    }

    if (response.status === 204 || response.status === 205) {
      return undefined as T;
    }

    const text = await response.text();

    if (text.length === 0) {
      return undefined as T;
    }

    if (opts.raw === 'text') {
      // A file's contents can legitimately begin with `<` (HTML, XML, YAML front-matter
      // in some plugins), so only trust the content-type header here.
      if (isHtmlContentType(response.headers.get('content-type'))) {
        throw new PteroHtmlResponseError({
          status: response.status,
          path,
          snippet: snippetOf(text),
        });
      }
      return text as T;
    }

    if (looksLikeHtml(text, response.headers.get('content-type'))) {
      throw new PteroHtmlResponseError({
        status: response.status,
        path,
        snippet: snippetOf(text),
      });
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PteroApiError({
        status: response.status,
        code: 'InvalidJsonResponse',
        detail: `Expected JSON but could not parse the response body (starts: ${snippetOf(text, 80)}).`,
        path,
      });
    }
  }

  private async toError(
    response: Response,
    path: string,
  ): Promise<PteroApiError | PteroHtmlResponseError | PteroRateLimitError> {
    const text = await response.text().catch(() => '');

    if (response.status === 429) {
      const rl = this.lastRateLimit;
      const retryAfter = Number(response.headers.get('retry-after'));
      const resetAt =
        rl?.resetAt ??
        (Number.isFinite(retryAfter) && retryAfter > 0
          ? new Date(Date.now() + retryAfter * 1000)
          : new Date(Date.now() + 60_000));
      return new PteroRateLimitError({
        path,
        resetAt,
        ...(rl?.limit !== undefined ? { limit: rl.limit } : {}),
      });
    }

    if (looksLikeHtml(text, response.headers.get('content-type'))) {
      return new PteroHtmlResponseError({
        status: response.status,
        path,
        snippet: snippetOf(text),
      });
    }

    let code: string | undefined;
    let detail: string | undefined;
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text) as PteroErrorEnvelope;
        const first = Array.isArray(parsed.errors) ? parsed.errors[0] : undefined;
        if (first) {
          code = first.code;
          detail = first.detail;
        }
      } catch {
        detail = snippetOf(text, 200);
      }
    }

    return new PteroApiError({
      status: response.status,
      ...(code !== undefined ? { code } : {}),
      ...(detail !== undefined ? { detail } : {}),
      path,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Typed helpers — the surface every tool phase builds on              */
  /* ------------------------------------------------------------------ */

  /** `GET /` — servers this API key can see. `page` is 1-based. */
  async listServers(page?: number): Promise<ServerListResponse> {
    return this.get<ServerListResponse>('/', page !== undefined ? { page } : undefined);
  }

  /** `GET /servers/{id}` — full detail, with allocations and variables included. */
  async getServer(id: string): Promise<ServerResponse> {
    return this.get<ServerResponse>(`/servers/${encodeURIComponent(id)}`);
  }

  /** `GET /servers/{id}/resources` — live utilisation (panel-cached for ~20s). */
  async getResources(id: string): Promise<ResourcesResponse> {
    return this.get<ResourcesResponse>(`/servers/${encodeURIComponent(id)}/resources`);
  }

  /**
   * `GET /servers/{id}/websocket` — short-lived (10 minute) console JWT plus the node's
   * socket URL. The token is a secret: never log or audit it.
   */
  async getWebsocketCredentials(id: string): Promise<WebsocketCredentials> {
    const res = await this.get<WebsocketCredentialsResponse>(
      `/servers/${encodeURIComponent(id)}/websocket`,
    );
    return res.data;
  }

  /**
   * `POST /servers/{id}/command` — 204 on dispatch. Output is *not* returned; read the
   * console separately. 502 means the server is offline.
   */
  async sendCommand(id: string, command: string): Promise<void> {
    await this.post<void>(`/servers/${encodeURIComponent(id)}/command`, { command });
  }

  /** `POST /servers/{id}/power` — 204. Signal is dispatched, not awaited. */
  async setPower(id: string, signal: PowerSignal): Promise<void> {
    await this.post<void>(`/servers/${encodeURIComponent(id)}/power`, { signal });
  }

  /** `GET /servers/{id}/files/list` — directory listing, unpaginated. */
  async listFiles(id: string, directory = '/'): Promise<FileListResponse> {
    return this.get<FileListResponse>(`/servers/${encodeURIComponent(id)}/files/list`, {
      directory,
    });
  }

  /** `GET /servers/{id}/files/contents` — raw text body, not a JSON envelope. */
  async getFileContents(id: string, path: string): Promise<string> {
    return this.getText(`/servers/${encodeURIComponent(id)}/files/contents`, { file: path });
  }

  /** `POST /servers/{id}/files/write` — raw body is the new file content. 204. */
  async writeFile(id: string, path: string, content: string): Promise<void> {
    await this.postRaw(`/servers/${encodeURIComponent(id)}/files/write`, content, {
      file: path,
    });
  }

  /** `PUT /servers/{id}/files/rename` — moves/renames relative to `root`. 204. */
  async renameFiles(
    id: string,
    root: string,
    files: FileRenameEntry[],
  ): Promise<void> {
    await this.put<void>(`/servers/${encodeURIComponent(id)}/files/rename`, { root, files });
  }

  /** `POST /servers/{id}/files/copy` — duplicates `location` alongside itself. 204. */
  async copyFile(id: string, location: string): Promise<void> {
    await this.post<void>(`/servers/${encodeURIComponent(id)}/files/copy`, { location });
  }

  /** `POST /servers/{id}/files/delete` — deletes `files` relative to `root`. 204. */
  async deleteFiles(id: string, root: string, files: string[]): Promise<void> {
    await this.post<void>(`/servers/${encodeURIComponent(id)}/files/delete`, { root, files });
  }

  /**
   * `GET /servers/{id}/files/upload` — a signed, 15-minute Wings URL (token scope
   * `FileUpload`) of the form `https://<node>/upload/file?token=...`. The panel does not
   * carry the bytes; the caller POSTs them to this URL itself (`uploadToSignedUrl`).
   * The URL embeds a bearer-equivalent token: never log or audit it.
   */
  async getFileUploadUrl(id: string): Promise<string> {
    const res = await this.get<SignedUrlResponse>(
      `/servers/${encodeURIComponent(id)}/files/upload`,
    );
    return res.attributes.url;
  }

  /**
   * Step two of the upload flow: POST the bytes straight to Wings.
   *
   * Wings' `postServerUploadFiles` (`router/router_server_files.go`) reads the destination
   * directory from the `directory` query parameter, and the files themselves from the
   * multipart form's `files` field — one part per file, the part's `filename` giving the
   * name on disk. It authenticates from the `token` already embedded in `signedUrl`, so the
   * panel API key must NOT be sent here.
   *
   * Sends exactly one part. `fetch` sets the `multipart/form-data` content type and boundary.
   */
  async uploadToSignedUrl(
    signedUrl: string,
    directory: string,
    filename: string,
    bytes: Uint8Array,
    contentType = 'application/octet-stream',
  ): Promise<void> {
    const url = new URL(signedUrl);
    url.searchParams.set('directory', directory);

    const form = new FormData();
    // `BlobPart` only admits an `ArrayBuffer`-backed view, while `Buffer`/`Uint8Array` are
    // typed as `ArrayBufferLike`-backed. The runtime accepts either; only the types differ.
    form.append('files', new Blob([bytes as unknown as BlobPart], { type: contentType }), filename);

    const response = await this.fetchImpl(url.toString(), { method: 'POST', body: form });

    if (!response.ok) {
      // `signedUrl` is a secret, so the error names the panel-side route instead of it.
      throw await this.toError(response, '/files/upload (Wings node)');
    }
  }

  /** `GET /servers/{id}/files/download` — signed, 15-minute Wings URL. Never audit it. */
  async getFileDownloadUrl(id: string, path: string): Promise<string> {
    const res = await this.get<SignedUrlResponse>(
      `/servers/${encodeURIComponent(id)}/files/download`,
      { file: path },
    );
    return res.attributes.url;
  }

  /** `GET /servers/{id}/backups` — paginated; `meta.backup_count` excludes failures. */
  async listBackups(id: string, perPage?: number): Promise<BackupListResponse> {
    return this.get<BackupListResponse>(
      `/servers/${encodeURIComponent(id)}/backups`,
      perPage !== undefined ? { per_page: perPage } : undefined,
    );
  }

  /** `POST /servers/{id}/backups` — returns the backup object immediately; it completes async. */
  async createBackup(id: string, opts: CreateBackupOptions = {}): Promise<BackupItem> {
    const body: Record<string, unknown> = {};
    if (opts.name !== undefined) body['name'] = opts.name;
    if (opts.ignored !== undefined) body['ignored'] = opts.ignored;
    if (opts.is_locked !== undefined) body['is_locked'] = opts.is_locked;
    return this.post<BackupItem>(`/servers/${encodeURIComponent(id)}/backups`, body);
  }

  /** `GET /servers/{id}/backups/{uuid}` — one backup, including completion state. */
  async getBackup(id: string, uuid: string): Promise<BackupItem> {
    return this.get<BackupItem>(
      `/servers/${encodeURIComponent(id)}/backups/${encodeURIComponent(uuid)}`,
    );
  }

  /** `DELETE /servers/{id}/backups/{uuid}` — irreversible. 204. */
  async deleteBackup(id: string, uuid: string): Promise<void> {
    await this.delete(
      `/servers/${encodeURIComponent(id)}/backups/${encodeURIComponent(uuid)}`,
    );
  }

  /** `GET /servers/{id}/backups/{uuid}/download` — signed URL. Never log or audit it. */
  async getBackupDownloadUrl(id: string, uuid: string): Promise<string> {
    const res = await this.get<SignedUrlResponse>(
      `/servers/${encodeURIComponent(id)}/backups/${encodeURIComponent(uuid)}/download`,
    );
    return res.attributes.url;
  }

  /** `GET /servers/{id}/schedules` — tasks are included by default. */
  async listSchedules(id: string): Promise<ScheduleListResponse> {
    return this.get<ScheduleListResponse>(`/servers/${encodeURIComponent(id)}/schedules`);
  }

  /** `GET /servers/{id}/network/allocations` — ports assigned to the server. */
  async listAllocations(id: string): Promise<AllocationListResponse> {
    return this.get<AllocationListResponse>(
      `/servers/${encodeURIComponent(id)}/network/allocations`,
    );
  }

  /** `GET /servers/{id}/startup` — user-viewable egg variables plus the startup command. */
  async getStartup(id: string): Promise<StartupResponse> {
    return this.get<StartupResponse>(`/servers/${encodeURIComponent(id)}/startup`);
  }

  /** `GET /account` — cheapest possible key/connectivity check. */
  async getAccount(): Promise<AccountResponse> {
    return this.get<AccountResponse>('/account');
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isHtmlContentType(contentType: string | null): boolean {
  return contentType !== null && /text\/html|application\/xhtml/i.test(contentType);
}

function looksLikeHtml(body: string, contentType: string | null): boolean {
  if (isHtmlContentType(contentType)) return true;
  const trimmedBody = body.trimStart();
  return trimmedBody.startsWith('<');
}

function snippetOf(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

/**
 * Parse Laravel's throttle headers. `X-RateLimit-Reset` is a unix timestamp in seconds;
 * some proxies emit a relative "seconds from now" instead, so small values are treated
 * as relative.
 */
export function parseRateLimitHeaders(
  headers: Headers,
  now: number = Date.now(),
): RateLimitInfo | undefined {
  const limitRaw = headers.get('x-ratelimit-limit');
  const remainingRaw = headers.get('x-ratelimit-remaining');
  const resetRaw = headers.get('x-ratelimit-reset');

  if (limitRaw === null && remainingRaw === null && resetRaw === null) {
    return undefined;
  }

  const limit = Number(limitRaw);
  const remaining = Number(remainingRaw);
  const reset = Number(resetRaw);

  let resetAt: Date;
  if (Number.isFinite(reset) && resetRaw !== null) {
    // Anything below ~1e6 cannot be a plausible unix timestamp, so read it as a delta.
    resetAt = reset > 1_000_000 ? new Date(reset * 1000) : new Date(now + reset * 1000);
  } else {
    resetAt = new Date(now);
  }

  return {
    limit: Number.isFinite(limit) ? limit : 0,
    remaining: Number.isFinite(remaining) ? remaining : 0,
    resetAt,
  };
}
