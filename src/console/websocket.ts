/**
 * Wings (Pterodactyl daemon) console websocket client.
 *
 * Protocol reference: docs/pterodactyl-api.md section 15.
 *
 * Every connection is per-call and short lived: fetch credentials from the panel,
 * open the socket, authenticate, do one job (collect logs / dispatch a command),
 * close. Nothing here is long-lived and nothing is cached between calls.
 */

import { WebSocket as WsWebSocket } from 'ws';

/**
 * Supplies short-lived Wings websocket credentials.
 *
 * Implemented by the panel client (`GET /servers/{id}/websocket`). Declared as a
 * local interface so this module has no compile-time dependency on the client.
 */
export interface WebsocketCredentialSource {
  getWebsocketCredentials(server: string): Promise<{ token: string; socket: string }>;
}

export interface WingsSocketOptions {
  creds: WebsocketCredentialSource;
  /** Server short id, passed straight through to the credential source. */
  server: string;
  /**
   * Panel base URL. Sent verbatim as the handshake `Origin` header: Wings'
   * `CheckOrigin` rejects the upgrade unless `Origin` equals the node's
   * configured panel location (docs/pterodactyl-api.md section 15).
   */
  panelUrl: string;
  /**
   * Websocket implementation override (tests inject a fake or the Node global).
   *
   * Defaults to the `ws` package rather than Node 22's global `WebSocket`. The
   * standard `WebSocket` constructor's second parameter is `protocols` and has
   * no way to set request headers; Node's global (undici) does honour a
   * non-standard `{ headers }` option today, but that is undocumented and not
   * part of the WHATWG API, and a missing or wrong `Origin` makes Wings reject
   * the handshake before any message is exchanged. `ws` supports request headers
   * as a documented feature, so it is the default. Any injected implementation
   * is constructed as `new Impl(url, { headers: { Origin: panelUrl } })` —
   * accepted by both `ws` and the Node global; an implementation that ignores
   * the option object simply sends no Origin.
   */
  WebSocketImpl?: typeof WebSocket;
  /** Timeout for both the handshake and the `auth success` reply. Default 10s. */
  connectTimeoutMs?: number;
}

export interface CollectResult {
  lines: string[];
  truncated: boolean;
  state?: string;
  durationMs: number;
  note?: string;
}

/**
 * Matches CSI / OSC / single-character ANSI escape sequences. Built from a
 * string so the source file contains no literal control characters.
 */
const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*' +
    '(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*' +
    '|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)' +
    '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  'g',
);

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

/** Structural view of the bits of the WebSocket API this module uses. */
interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: any) => void): void;
  terminate?(): void;
}
type SocketCtor = new (url: string, options?: unknown) => SocketLike;

interface Envelope {
  event: string;
  args?: unknown[];
}

/** JWT-shaped blobs, so a leaked token never reaches an error message. */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;

function redact(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out.replace(JWT_PATTERN, '[redacted]');
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

function decodeFrame(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  return null;
}

function stringArgs(args: unknown[] | undefined): string[] {
  if (!Array.isArray(args)) return [];
  return args.filter((a): a is string => typeof a === 'string');
}

/**
 * One authenticated Wings connection. Created by `Connection.open`, disposed on
 * every exit path (success, failure, timeout) so no socket or timer is leaked.
 */
class Connection {
  private readonly socket: SocketLike;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly secrets: string[] = [];

  private disposed = false;
  private fatal: Error | null = null;
  private onFatal: ((err: Error) => void) | null = null;
  private onLine: (() => void) | null = null;
  private onAuthSuccess: (() => void) | null = null;
  private reauthInFlight = false;
  private attached = false;

  readonly lines: string[] = [];
  state: string | undefined;
  note: string | undefined;

  private constructor(
    socket: SocketLike,
    private readonly refresh: () => Promise<{ token: string; socket: string }>,
  ) {
    this.socket = socket;
  }

  static async open(
    ctor: SocketCtor,
    panelUrl: string,
    refresh: () => Promise<{ token: string; socket: string }>,
    connectTimeoutMs: number,
  ): Promise<Connection> {
    const initial = await refresh();

    // `headers` is non-standard but honoured by `ws` and by Node's global
    // WebSocket; see WingsSocketOptions.WebSocketImpl for why Origin matters.
    const socket = new ctor(initial.socket, { headers: { Origin: panelUrl } });
    const conn = new Connection(socket, refresh);
    conn.secrets.push(initial.token);

    try {
      await conn.waitForOpen(connectTimeoutMs);
      conn.send('auth', [initial.token]);
      await conn.waitForAuth(connectTimeoutMs);
    } catch (err) {
      conn.dispose();
      throw err;
    }
    return conn;
  }

  private track(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
    this.timers.add(timer);
    return timer;
  }

  private clear(timer: ReturnType<typeof setTimeout> | undefined): void {
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  private waitForOpen(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error): void => {
        if (settled) return;
        settled = true;
        this.clear(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = this.track(
        setTimeout(() => {
          done(new Error(`Websocket connection to the node timed out after ${timeoutMs}ms.`));
        }, timeoutMs),
      );

      this.socket.addEventListener('open', () => {
        this.attach();
        done();
      });
      this.socket.addEventListener('error', (ev: any) => {
        const reason = redact(
          errorMessage(ev?.error ?? ev?.message ?? 'connection error'),
          this.secrets,
        );
        const err = new Error(`Websocket connection to the node failed: ${reason}`);
        done(err);
        this.fail(err);
      });
      this.socket.addEventListener('close', () => {
        done(new Error('Websocket closed before the connection was established.'));
        this.fail(new Error('Websocket was closed by the node before the request completed.'));
      });

      // Some implementations may already be open by the time we subscribe.
      if (this.socket.readyState === 1) {
        this.attach();
        done();
      }
    });
  }

  /** Wires the message pump once the socket is open. */
  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.socket.addEventListener('message', (ev: any) => this.handleFrame(ev?.data));
  }

  private waitForAuth(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        this.clear(timer);
        this.onAuthSuccess = null;
        this.onFatal = null;
        if (err) reject(err);
        else resolve();
      };
      const timer = this.track(
        setTimeout(() => {
          finish(
            new Error(
              'Websocket authentication failed or timed out: the node did not return "auth success" ' +
                `within ${timeoutMs}ms. The websocket token may be expired, or the node may be unreachable.`,
            ),
          );
        }, timeoutMs),
      );

      if (this.fatal) {
        finish(this.fatal);
        return;
      }
      this.onAuthSuccess = () => finish();
      this.onFatal = (err) => finish(err);
    });
  }

  private handleFrame(data: unknown): void {
    const raw = decodeFrame(data);
    if (raw === null) return;

    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return; // Not a Wings envelope; ignore rather than tear the socket down.
    }
    if (!envelope || typeof envelope.event !== 'string') return;

    const args = stringArgs(envelope.args);
    switch (envelope.event) {
      case 'auth success':
        this.onAuthSuccess?.();
        break;

      case 'status': {
        const state = args[0];
        if (state && this.state === undefined) this.state = state;
        break;
      }

      case 'console output':
      case 'install output': {
        let pushed = false;
        for (const arg of args) {
          for (const line of stripAnsi(arg).split('\n')) {
            const cleaned = line.replace(/\r+$/, '');
            if (cleaned.trim().length === 0) continue;
            this.lines.push(cleaned);
            pushed = true;
          }
        }
        if (pushed) this.onLine?.();
        break;
      }

      case 'token expiring':
      case 'token expired':
        void this.reauthenticate();
        break;

      case 'throttled': {
        const which = args[0] ? `"${args[0]}"` : 'an event';
        this.note = `The node throttled ${which} sent by this client; some console output may be missing.`;
        break;
      }

      case 'jwt error':
        this.fail(
          new Error(
            `Websocket authentication was rejected by the node: ${redact(args[0] ?? 'jwt error', this.secrets)}`,
          ),
        );
        break;

      case 'daemon error':
        this.fail(
          new Error(
            `The node reported an error: ${redact(args[0] ?? 'daemon error', this.secrets)}`,
          ),
        );
        break;

      default:
        break;
    }
  }

  /**
   * Token refresh: mint a new JWT from the panel and re-`auth` on the *same*
   * socket (docs/pterodactyl-api.md section 15, re-auth flow) — no reconnect,
   * so no duplicate backlog burst.
   */
  private async reauthenticate(): Promise<void> {
    if (this.reauthInFlight || this.disposed) return;
    this.reauthInFlight = true;
    try {
      const fresh = await this.refresh();
      if (this.disposed) return;
      this.secrets.push(fresh.token);
      this.send('auth', [fresh.token]);
    } catch (err) {
      this.fail(
        new Error(
          `Websocket re-authentication failed while refreshing the token: ${redact(errorMessage(err), this.secrets)}`,
        ),
      );
    } finally {
      this.reauthInFlight = false;
    }
  }

  private fail(err: Error): void {
    if (this.fatal) return;
    this.fatal = err;
    this.onFatal?.(err);
  }

  send(event: string, args: string[] = []): void {
    if (this.disposed || this.socket.readyState !== 1) return;
    try {
      this.socket.send(JSON.stringify({ event, args }));
    } catch (err) {
      this.fail(
        new Error(
          `Failed to send "${event}" on the websocket: ${redact(errorMessage(err), this.secrets)}`,
        ),
      );
    }
  }

  /** Collect console output until the window elapses or the line budget is hit. */
  collect(windowMs: number, maxLines: number): Promise<{ lines: string[]; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      if (this.fatal) {
        reject(this.fatal);
        return;
      }
      let settled = false;
      const finish = (err?: Error, truncated = false): void => {
        if (settled) return;
        settled = true;
        this.clear(timer);
        this.onLine = null;
        this.onFatal = null;
        if (err) reject(err);
        else resolve({ lines: this.lines.slice(0, maxLines), truncated });
      };
      // Window elapsed: what we have is the whole answer for this window.
      const timer = this.track(setTimeout(() => finish(undefined, false), windowMs));

      this.onFatal = (err) => finish(err);
      // Line cap reached: collection was cut short, so output is being dropped.
      this.onLine = () => {
        if (this.lines.length >= maxLines) finish(undefined, true);
      };

      if (this.lines.length >= maxLines) finish(undefined, maxLines > 0);
    });
  }

  /** Wait `ms`, rejecting early if the node reports an error in that window. */
  quiet(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.fatal) {
        reject(this.fatal);
        return;
      }
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        this.clear(timer);
        this.onFatal = null;
        if (err) reject(err);
        else resolve();
      };
      const timer = this.track(setTimeout(() => finish(), ms));
      this.onFatal = (err) => finish(err);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onFatal = null;
    this.onLine = null;
    this.onAuthSuccess = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    try {
      if (this.socket.readyState === 0 || this.socket.readyState === 1) {
        this.socket.close(1000, 'done');
      }
    } catch {
      /* already gone */
    }
    // Belt and braces: if the peer never completes the closing handshake, drop
    // the connection so the process can exit. Unref'd so it never holds the loop.
    if (typeof this.socket.terminate === 'function') {
      const kill = setTimeout(() => {
        try {
          this.socket.terminate?.();
        } catch {
          /* ignore */
        }
      }, 1000);
      kill.unref?.();
    }
  }
}

export class WingsSocket {
  private readonly creds: WebsocketCredentialSource;
  private readonly server: string;
  private readonly panelUrl: string;
  private readonly ctor: SocketCtor;
  private readonly connectTimeoutMs: number;

  constructor(opts: WingsSocketOptions) {
    this.creds = opts.creds;
    this.server = opts.server;
    this.panelUrl = opts.panelUrl;
    this.ctor = (opts.WebSocketImpl ?? WsWebSocket) as unknown as SocketCtor;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  }

  private open(): Promise<Connection> {
    return Connection.open(
      this.ctor,
      this.panelUrl,
      () => this.creds.getWebsocketCredentials(this.server),
      this.connectTimeoutMs,
    );
  }

  /**
   * Connect, request the console backlog, and collect output until `windowMs`
   * elapses or `maxLines` lines are gathered, then disconnect.
   *
   * Wings has no "give me the last N lines" request: what arrives is the node's
   * ring buffer (150 lines by default) plus whatever streams in during the
   * window. For history older than that, read `logs/latest.log` instead.
   */
  async collectLogs(opts: { windowMs: number; maxLines: number }): Promise<CollectResult> {
    const startedAt = Date.now();
    const conn = await this.open();
    try {
      conn.send('send logs');
      conn.send('send stats');
      const { lines, truncated } = await conn.collect(opts.windowMs, opts.maxLines);
      const result: CollectResult = {
        lines,
        truncated,
        durationMs: Date.now() - startedAt,
      };
      if (conn.state !== undefined) result.state = conn.state;
      if (conn.note !== undefined) result.note = conn.note;
      return result;
    } finally {
      conn.dispose();
    }
  }

  /**
   * Dispatch a console command. Wings does not correlate command output with the
   * command that produced it, so this only confirms dispatch — read the console
   * separately to see what happened.
   */
  async sendCommand(command: string): Promise<{ dispatched: true; state?: string }> {
    const conn = await this.open();
    try {
      conn.send('send command', [command]);
      // Brief settle window so an immediate `daemon error` surfaces as a rejection.
      await conn.quiet(300);
      const result: { dispatched: true; state?: string } = { dispatched: true };
      if (conn.state !== undefined) result.state = conn.state;
      return result;
    } finally {
      conn.dispose();
    }
  }
}
