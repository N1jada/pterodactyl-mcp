import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';

import { AuditLog } from '../../src/audit.js';
import { PteroClient } from '../../src/client.js';
import { loadConfig } from '../../src/config.js';
import { Confirmation, type ElicitCapableServer, type ElicitInputResult } from '../../src/confirm.js';
import { Guard, type AuditSink, type BackupCreator, type ConfirmationLike } from '../../src/guard.js';
import { registerConsoleTools } from '../../src/tools/console.js';
import type { ToolContext } from '../../src/tools/_shared.js';

const PANEL = 'https://panel.example.com';
const SERVER_ID = '1a2b3c4d';

/* -------------------------------------------------------------------------- */
/* Scripted Wings websocket server (copied from test/console/websocket.test.ts) */
/* -------------------------------------------------------------------------- */

interface Frame {
  event: string;
  args?: string[];
}

type Send = (event: string, args?: string[]) => void;

interface TestWings {
  url: string;
  received: Frame[];
  close(): Promise<void>;
}

async function startWings(script: {
  onFrame?: (frame: Frame, send: Send, ctx: TestWings) => void;
}): Promise<TestWings> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;

  const sockets = new Set<WsSocket>();
  const ctx: TestWings = {
    url: `ws://127.0.0.1:${port}/api/servers/uuid/ws`,
    received: [],
    async close() {
      for (const socket of sockets) socket.terminate();
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };

  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {
      /* a client that vanished mid-write is not a test failure */
    });
    socket.on('close', () => sockets.delete(socket));

    const send: Send = (event, args = []) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ event, args }));
    };

    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      ctx.received.push(frame);
      script.onFrame?.(frame, send, ctx);
    });
  });

  return ctx;
}

/** Standard first-auth reply: `auth success` followed by a `status` push. */
function authOk(send: Send, state = 'running'): void {
  send('auth success');
  send('status', [state]);
}

let wingsServers: TestWings[] = [];

afterEach(async () => {
  await Promise.all(wingsServers.map((s) => s.close()));
  wingsServers = [];
});

async function withWings(script: Parameters<typeof startWings>[0]): Promise<TestWings> {
  const server = await startWings(script);
  wingsServers.push(server);
  return server;
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface HarnessOpts {
  wsUrl?: string;
  commandStatus?: number;
  commandBody?: unknown;
  env?: Record<string, string>;
}

async function harness(opts: HarnessOpts = {}) {
  const commandCalls: Array<{ url: string; body: unknown }> = [];

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('/websocket')) {
      return new Response(JSON.stringify({ data: { token: 'test-token', socket: opts.wsUrl } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.includes('/command')) {
      commandCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const status = opts.commandStatus ?? 204;
      if (status === 204) return new Response(null, { status: 204 });
      return new Response(
        JSON.stringify(opts.commandBody ?? { errors: [{ code: 'HttpException', detail: 'offline' }] }),
        { status, headers: { 'content-type': 'application/json' } },
      );
    }

    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;

  const config = loadConfig({
    PTERODACTYL_PANEL_URL: PANEL,
    PTERODACTYL_API_KEY: 'ptlc_test',
    PTERODACTYL_DEFAULT_SERVER: SERVER_ID,
    ...opts.env,
  });

  const client = new PteroClient({ panelUrl: config.panelUrl, apiKey: config.apiKey, fetch: fakeFetch });

  const auditEntries: Record<string, unknown>[] = [];
  const auditSink: AuditSink = {
    append: async (entry) => {
      auditEntries.push(entry);
    },
  };

  // No elicitation support declared: the guard falls back to the token flow. Neither
  // path is exercised by `ptero_send_console_command` (not `destructive`), but the
  // guard always needs a ConfirmationLike to construct.
  const stubServer: ElicitCapableServer = {
    server: {
      getClientCapabilities: () => undefined,
      elicitInput: async (): Promise<ElicitInputResult> => ({ action: 'cancel' }),
    },
  };
  const confirmation = new Confirmation({ server: stubServer });
  const confirm: ConfirmationLike = {
    clientSupportsElicitation: () => confirmation.clientSupportsElicitation(),
    elicit: (preview, extra) => confirmation.elicit(preview, extra),
    mint: (hash) => confirmation.mint(hash),
    consume: (token, hash) => confirmation.consume(token, hash),
  };

  const createBackup: BackupCreator = async () => {
    throw new Error('unexpected backup creation in console tool tests');
  };

  // `Config` is a structural superset of `GuardConfig` — the real, env-driven config
  // doubles as the guard's config so env overrides (e.g. PTERODACTYL_READ_ONLY) apply
  // to both.
  const guard = new Guard({ config, audit: auditSink, confirm, createBackup });

  const mcp = new McpServer({ name: 'pterodactyl-mcp-test', version: '0.0.0' });

  const ctx: ToolContext = {
    server: mcp,
    client,
    guard,
    config,
    audit: new AuditLog('/dev/null'),
  };

  registerConsoleTools(ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([mcpClient.connect(clientTransport), mcp.connect(serverTransport)]);

  return {
    client: mcpClient,
    mcp,
    commandCalls,
    auditEntries,
    close: async () => mcpClient.close(),
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('phase 2 tool registration', () => {
  it('registers exactly the two phase-2 tools with honest annotations', async () => {
    const h = await harness();
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['ptero_get_console_log', 'ptero_send_console_command']);

    const log = tools.find((t) => t.name === 'ptero_get_console_log')!;
    expect(log.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const send = tools.find((t) => t.name === 'ptero_send_console_command')!;
    expect(send.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });

    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.description ?? '', tool.name).not.toBe('');
    }

    await h.close();
  });

  it('describes the console problem: backlog+stream, no last-N, buffer rollover, and the send->read pairing', async () => {
    const h = await harness();
    const { tools } = await h.client.listTools();
    const log = tools.find((t) => t.name === 'ptero_get_console_log')!;
    const d = log.description ?? '';

    const iBacklog = d.indexOf('backlog');
    const iNoLastN = d.toLowerCase().indexOf('no "give me the last');
    const iRollover = d.toLowerCase().indexOf('rolls over');
    const iLatestLog = d.indexOf('logs/latest.log');
    const iAfterSend = d.indexOf('ptero_send_console_command');

    expect([iBacklog, iNoLastN, iRollover, iLatestLog, iAfterSend].every((i) => i >= 0)).toBe(true);
    expect(iBacklog).toBeLessThan(iNoLastN);
    expect(iNoLastN).toBeLessThan(iRollover);
    expect(iRollover).toBeLessThan(iLatestLog);
    expect(iLatestLog).toBeLessThan(iAfterSend);

    await h.close();
  });

  it('is honest that dispatch confirms nothing about output, and names ptero_set_power_state', async () => {
    const h = await harness();
    const { tools } = await h.client.listTools();
    const send = tools.find((t) => t.name === 'ptero_send_console_command')!;
    const d = send.description ?? '';

    expect(d).toMatch(/does not return|asynchronous/i);
    expect(d).toContain('ptero_get_console_log');
    expect(d).toContain('ptero_set_power_state');

    await h.close();
  });
});

describe('ptero_get_console_log', () => {
  it('returns collected lines and the reported state', async () => {
    const wings = await withWings({
      onFrame: (frame, send) => {
        if (frame.event === 'auth') authOk(send, 'running');
        if (frame.event === 'send logs') {
          send('console output', ['Starting minecraft server version 1.20.4']);
          send('console output', ['Done (5.123s)! For help, type "help"']);
        }
      },
    });

    const h = await harness({ wsUrl: wings.url });
    const result = await h.client.callTool({
      name: 'ptero_get_console_log',
      arguments: { window_seconds: 1, max_lines: 150 },
    });

    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as Record<string, unknown>;
    expect(s['server']).toBe(SERVER_ID);
    expect(s['state']).toBe('running');
    expect(s['lines']).toEqual([
      'Starting minecraft server version 1.20.4',
      'Done (5.123s)! For help, type "help"',
    ]);
    expect(s['line_count']).toBe(2);
    expect(s['truncated']).toBe(false);
    expect(s['window_seconds']).toBe(1);
    expect(typeof s['duration_ms']).toBe('number');

    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('running');
    expect(text).toContain('Done (5.123s)');

    await h.close();
  });

  it('caps collection at max_lines and reports truncated: true', async () => {
    const wings = await withWings({
      onFrame: (frame, send) => {
        if (frame.event === 'auth') authOk(send);
        if (frame.event === 'send logs') {
          for (let i = 1; i <= 20; i += 1) send('console output', [`line ${i}`]);
        }
      },
    });

    const h = await harness({ wsUrl: wings.url });
    const result = await h.client.callTool({
      name: 'ptero_get_console_log',
      arguments: { window_seconds: 2, max_lines: 5 },
    });

    const s = result.structuredContent as Record<string, unknown>;
    expect(s['lines']).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
    expect(s['line_count']).toBe(5);
    expect(s['truncated']).toBe(true);

    await h.close();
  });

  it('applies `filter` (case-insensitive) to collected lines', async () => {
    const wings = await withWings({
      onFrame: (frame, send) => {
        if (frame.event === 'auth') authOk(send);
        if (frame.event === 'send logs') {
          send('console output', ['[Server] Loading plugins']);
          send('console output', ['[GeyserSpigot] Started Geyser on port 19132']);
          send('console output', ['[Server] Done']);
        }
      },
    });

    const h = await harness({ wsUrl: wings.url });
    const result = await h.client.callTool({
      name: 'ptero_get_console_log',
      arguments: { window_seconds: 1, filter: 'geyser' },
    });

    const s = result.structuredContent as Record<string, unknown>;
    expect(s['lines']).toEqual(['[GeyserSpigot] Started Geyser on port 19132']);
    expect(s['line_count']).toBe(1);

    await h.close();
  });

  it('reports an offline server as zero lines with a note explaining why', async () => {
    const wings = await withWings({
      onFrame: (frame, send) => {
        if (frame.event === 'auth') authOk(send, 'offline');
        // No console output at all: nothing to send on "send logs".
      },
    });

    const h = await harness({ wsUrl: wings.url });
    const result = await h.client.callTool({
      name: 'ptero_get_console_log',
      arguments: { window_seconds: 1 },
    });

    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as Record<string, unknown>;
    expect(s['state']).toBe('offline');
    expect(s['lines']).toEqual([]);
    expect(s['line_count']).toBe(0);
    expect(s['note']).toMatch(/offline/i);

    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/offline/i);

    await h.close();
  });
});

describe('ptero_send_console_command', () => {
  it('POSTs {command} to the panel and reports dispatched:true without claiming output', async () => {
    const h = await harness({ commandStatus: 204 });

    const result = await h.client.callTool({
      name: 'ptero_send_console_command',
      arguments: { command: 'say hello world' },
    });

    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as Record<string, unknown>;
    expect(s['status']).toBe('success');
    expect(s['command']).toBe('say hello world');
    expect(s['dispatched']).toBe(true);

    expect(h.commandCalls).toHaveLength(1);
    expect(h.commandCalls[0]!.url).toContain(`/servers/${SERVER_ID}/command`);
    expect(h.commandCalls[0]!.body).toEqual({ command: 'say hello world' });

    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/dispatch/i);
    expect(text).toContain('ptero_get_console_log');

    await h.close();
  });

  it('maps a 502 (offline server) to an actionable error naming ptero_set_power_state', async () => {
    const h = await harness({ commandStatus: 502, commandBody: {} });

    const result = await h.client.callTool({
      name: 'ptero_send_console_command',
      arguments: { command: 'stop' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/offline/i);
    expect(text).toContain('ptero_set_power_state');

    await h.close();
  });

  it('dry_run previews without sending any request to the panel', async () => {
    const h = await harness();

    const result = await h.client.callTool({
      name: 'ptero_send_console_command',
      arguments: { command: 'say hi', dry_run: true },
    });

    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as Record<string, unknown>;
    expect(s['status']).toBe('dry_run');
    expect(h.commandCalls).toHaveLength(0);

    await h.close();
  });

  it('refuses in read-only mode, naming PTERODACTYL_READ_ONLY', async () => {
    const h = await harness({ env: { PTERODACTYL_READ_ONLY: 'true' } });

    const result = await h.client.callTool({
      name: 'ptero_send_console_command',
      arguments: { command: 'say hi' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('PTERODACTYL_READ_ONLY');
    expect(h.commandCalls).toHaveLength(0);

    await h.close();
  });

  it('rejects a command containing a newline at the schema level', async () => {
    const h = await harness();

    const result = await h.client.callTool({
      name: 'ptero_send_console_command',
      arguments: { command: 'say hi\nsay again' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/newline/i);
    expect(h.commandCalls).toHaveLength(0);

    await h.close();
  });
});
