import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AddressInfo } from 'node:net';

import {
  WingsSocket,
  stripAnsi,
  type WebsocketCredentialSource,
} from '../../src/console/websocket.js';

const PANEL_URL = 'https://panel.example.test';
const SERVER_ID = '1a2b3c4d';
const ESC = '\u001B';

interface Frame {
  event: string;
  args?: string[];
}

/** Sends a Wings envelope, silently ignoring a peer that has already gone away. */
type Send = (event: string, args?: string[]) => void;

interface TestWings {
  url: string;
  /** Every envelope received, across all connections, in order. */
  received: Frame[];
  /** Origin header seen on each handshake. */
  origins: Array<string | undefined>;
  /** Resolves once a client connection has closed. */
  clientClosed: Promise<void>;
  close(): Promise<void>;
}

/**
 * A local server speaking the Wings websocket protocol (docs/pterodactyl-api.md
 * section 15), driven by a per-test script.
 */
async function startWings(script: {
  onConnect?: (send: Send, ctx: TestWings) => void;
  onFrame?: (frame: Frame, send: Send, ctx: TestWings) => void;
}): Promise<TestWings> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sockets = new Set<WsSocket>();
  let resolveClosed: () => void;
  const clientClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const ctx: TestWings = {
    url: `ws://127.0.0.1:${port}/api/servers/uuid/ws`,
    received: [],
    origins: [],
    clientClosed,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) socket.terminate();
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };

  wss.on('connection', (socket, req) => {
    sockets.add(socket);
    ctx.origins.push(req.headers.origin);
    socket.on('error', () => {
      /* a client that vanished mid-write is not a test failure */
    });
    socket.on('close', () => {
      sockets.delete(socket);
      resolveClosed();
    });

    const send: Send = (event, args = []) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ event, args }));
    };

    script.onConnect?.(send, ctx);

    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      ctx.received.push(frame);
      script.onFrame?.(frame, send, ctx);
    });
  });

  // Expose the timer set to scripts that need to schedule sends.
  (ctx as TestWings & { timers: Set<ReturnType<typeof setTimeout>> }).timers = timers;
  return ctx;
}

/** Schedules a send that is cancelled when the test server is closed. */
function later(ctx: TestWings, ms: number, fn: () => void): void {
  const timers = (ctx as TestWings & { timers: Set<ReturnType<typeof setTimeout>> }).timers;
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, ms);
  timers.add(timer);
}

/** Credential source that hands out the scripted tokens in order. */
function fakeCreds(
  url: string,
  tokens: string[],
): WebsocketCredentialSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getWebsocketCredentials(server: string) {
      calls.push(server);
      const token = tokens[Math.min(calls.length - 1, tokens.length - 1)];
      return { token: token as string, socket: url };
    },
  };
}

/** Standard first-auth reply: `auth success` followed by a `status` push. */
function authOk(send: Send, state = 'running'): void {
  send('auth success');
  send('status', [state]);
}

let servers: TestWings[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function withServer(script: Parameters<typeof startWings>[0]): Promise<TestWings> {
  const server = await startWings(script);
  servers.push(server);
  return server;
}

function socketFor(server: TestWings, tokens: string[], overrides = {}): WingsSocket {
  return new WingsSocket({
    creds: fakeCreds(server.url, tokens),
    server: SERVER_ID,
    panelUrl: PANEL_URL,
    connectTimeoutMs: 2000,
    ...overrides,
  });
}

describe('WingsSocket.collectLogs', () => {
  it('caps a 200-line backlog at maxLines and reports truncation', async () => {
    let authCount = 0;
    const server = await withServer({
      onFrame: (frame, send) => {
        if (frame.event === 'auth') {
          authCount += 1;
          authOk(send);
        }
        if (frame.event === 'send logs') {
          for (let i = 1; i <= 200; i += 1) send('console output', [`backlog line ${i}`]);
        }
      },
    });

    const ws = socketFor(server, ['token-one']);
    const result = await ws.collectLogs({ windowMs: 3000, maxLines: 150 });

    expect(result.lines).toHaveLength(150);
    expect(result.lines[0]).toBe('backlog line 1');
    expect(result.lines[149]).toBe('backlog line 150');
    expect(result.truncated).toBe(true);
    expect(result.state).toBe('running');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(authCount).toBe(1);
    // The client asks for the backlog and a stats snapshot after auth.
    expect(server.received.map((f) => f.event)).toEqual(
      expect.arrayContaining(['auth', 'send logs', 'send stats']),
    );
  });

  it('returns what it has when the window elapses on a slow trickle', async () => {
    const server = await withServer({
      onFrame: (frame, send, ctx) => {
        if (frame.event === 'auth') authOk(send, 'starting');
        if (frame.event === 'send logs') {
          later(ctx, 20, () => send('console output', ['trickle 1']));
          later(ctx, 60, () => send('console output', ['trickle 2']));
          later(ctx, 100, () => send('console output', ['trickle 3']));
          // Arrives after the window closes; must not appear in the result.
          later(ctx, 900, () => send('console output', ['too late']));
        }
      },
    });

    const ws = socketFor(server, ['token-one']);
    const result = await ws.collectLogs({ windowMs: 300, maxLines: 150 });

    expect(result.lines).toEqual(['trickle 1', 'trickle 2', 'trickle 3']);
    expect(result.truncated).toBe(false);
    expect(result.state).toBe('starting');
  });

  it('re-authenticates with a fresh token on "token expiring" and keeps collecting', async () => {
    const creds = fakeCreds('', ['token-one', 'token-two']);
    const authTokens: string[] = [];
    const server = await withServer({
      onFrame: (frame, send, ctx) => {
        if (frame.event === 'auth') {
          const token = frame.args?.[0] ?? '';
          authTokens.push(token);
          if (authTokens.length === 1) {
            authOk(send);
          } else {
            // Re-auth on an existing session: no repeated status/backlog burst.
            send('auth success');
            send('console output', ['after reauth 1']);
            send('console output', ['after reauth 2']);
          }
        }
        if (frame.event === 'send logs') {
          send('console output', ['before expiry 1']);
          send('console output', ['before expiry 2']);
          later(ctx, 30, () => send('token expiring'));
        }
      },
    });

    const ws = new WingsSocket({
      creds: {
        calls: creds.calls,
        getWebsocketCredentials: async (id: string) => {
          const { token } = await creds.getWebsocketCredentials(id);
          return { token, socket: server.url };
        },
      } as WebsocketCredentialSource,
      server: SERVER_ID,
      panelUrl: PANEL_URL,
      connectTimeoutMs: 2000,
    });

    const result = await ws.collectLogs({ windowMs: 500, maxLines: 150 });

    expect(creds.calls).toEqual([SERVER_ID, SERVER_ID]);
    expect(authTokens).toEqual(['token-one', 'token-two']);
    expect(result.lines).toEqual([
      'before expiry 1',
      'before expiry 2',
      'after reauth 1',
      'after reauth 2',
    ]);
    expect(result.truncated).toBe(false);
    // Re-auth happens on the same socket: exactly one handshake.
    expect(server.origins).toHaveLength(1);
  });

  it('rejects on "jwt error" without leaking the token', async () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.SUPERSECRETPAYLOAD.c2lnbmF0dXJl';
    const server = await withServer({
      onFrame: (frame, send) => {
        if (frame.event === 'auth') {
          // Wings echoes context into the error; the client must not pass it on.
          send('jwt error', [`token is not valid for this server: ${token}`]);
        }
      },
    });

    const ws = socketFor(server, [token]);
    await expect(ws.collectLogs({ windowMs: 500, maxLines: 150 })).rejects.toThrow(
      /rejected by the node/i,
    );

    try {
      await ws.collectLogs({ windowMs: 500, maxLines: 150 });
      expect.unreachable('expected a rejection');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(token);
      expect(message).not.toContain('SUPERSECRETPAYLOAD');
      expect(message).toContain('[redacted]');
    }
  });

  it('strips ANSI escape codes from console output', async () => {
    const server = await withServer({
      onFrame: (frame, send) => {
        if (frame.event === 'auth') authOk(send);
        if (frame.event === 'send logs') {
          send('console output', [
            `${ESC}[32m[12:00:00 INFO]${ESC}[0m: Done (5.123s)! For help, type "help"`,
          ]);
          // One frame carrying several newline-separated lines plus blank padding.
          send('console output', [
            `${ESC}[0;33mWARN${ESC}[m first\n\n${ESC}[1;31mERROR${ESC}[m second\r\n`,
          ]);
        }
      },
    });

    const ws = socketFor(server, ['token-one']);
    const result = await ws.collectLogs({ windowMs: 250, maxLines: 150 });

    expect(result.lines).toEqual([
      '[12:00:00 INFO]: Done (5.123s)! For help, type "help"',
      'WARN first',
      'ERROR second',
    ]);
    for (const line of result.lines) expect(line).not.toContain(ESC);
  });

  it('notes throttling reported by the node', async () => {
    const server = await withServer({
      onFrame: (frame, send) => {
        if (frame.event === 'auth') authOk(send);
        if (frame.event === 'send logs') {
          send('throttled', ['send logs']);
          send('console output', ['one line got through']);
        }
      },
    });

    const ws = socketFor(server, ['token-one']);
    const result = await ws.collectLogs({ windowMs: 250, maxLines: 150 });

    expect(result.note).toMatch(/throttled/i);
    expect(result.note).toContain('send logs');
    expect(result.lines).toEqual(['one line got through']);
  });
});

describe('WingsSocket.sendCommand', () => {
  it('sends the exact "send command" envelope and resolves dispatched', async () => {
    const server = await withServer({
      onFrame: (frame, send) => {
        if (frame.event === 'auth') authOk(send);
      },
    });

    const ws = socketFor(server, ['token-one']);
    const result = await ws.sendCommand('say hello world');

    expect(result).toEqual({ dispatched: true, state: 'running' });
    expect(server.received).toContainEqual({ event: 'send command', args: ['say hello world'] });
    // Dispatch only: no log request is made on this path.
    expect(server.received.map((f) => f.event)).not.toContain('send logs');
  });

  it('rejects when the node answers with an immediate daemon error', async () => {
    const server = await withServer({
      onFrame: (frame, send) => {
        if (frame.event === 'auth') authOk(send, 'offline');
        if (frame.event === 'send command') send('daemon error', ['server is not running']);
      },
    });

    const ws = socketFor(server, ['token-one']);
    await expect(ws.sendCommand('stop')).rejects.toThrow(/server is not running/);
  });
});

describe('WingsSocket connection handling', () => {
  it('rejects and closes the socket when auth is never acknowledged', async () => {
    const server = await withServer({
      onFrame: () => {
        /* deliberately silent: no auth success */
      },
    });

    const ws = socketFor(server, ['token-one'], { connectTimeoutMs: 200 });
    const started = Date.now();
    await expect(ws.collectLogs({ windowMs: 5000, maxLines: 150 })).rejects.toThrow(
      /authentication failed or timed out/i,
    );
    expect(Date.now() - started).toBeLessThan(2000);

    // The client must not leave the socket open after giving up.
    await server.clientClosed;
  });

  it('sends an Origin header equal to the panel URL', async () => {
    const server = await withServer({
      onFrame: (frame, send) => {
        if (frame.event === 'auth') authOk(send);
      },
    });

    const ws = socketFor(server, ['token-one']);
    await ws.collectLogs({ windowMs: 100, maxLines: 150 });

    expect(server.origins).toEqual([PANEL_URL]);
  });
});

describe('stripAnsi', () => {
  it('removes colour, cursor and OSC sequences but keeps the text', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gprogress`)).toBe('progress');
    expect(stripAnsi(`${ESC}]0;window-title${'\u0007'}body`)).toBe('body');
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});
