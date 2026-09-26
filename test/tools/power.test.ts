import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../../src/audit.js';
import { PteroClient } from '../../src/client.js';
import { loadConfig } from '../../src/config.js';
import { Confirmation } from '../../src/confirm.js';
import { Guard, type AuditSink, type BackupCreator, type GuardConfig } from '../../src/guard.js';
import { registerPowerTools } from '../../src/tools/power.js';
import type { ToolContext } from '../../src/tools/_shared.js';

const PANEL = 'https://panel.example.com';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function resourcesBody(state: string) {
  return {
    object: 'stats',
    attributes: {
      current_state: state,
      is_suspended: false,
      resources: {
        memory_bytes: 0,
        cpu_absolute: 0,
        disk_bytes: 0,
        network_rx_bytes: 0,
        network_tx_bytes: 0,
        uptime: 0,
      },
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/* -------------------------------------------------------------------------- */
/* Harness — real McpServer + InMemoryTransport + Client, fake fetch          */
/* PteroClient, real Guard/Confirmation with test config and fakes            */
/* -------------------------------------------------------------------------- */

type Responder = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

interface Call {
  url: string;
  init: RequestInit | undefined;
}

async function harness(opts: {
  respond: Responder;
  guardOverrides?: Partial<GuardConfig>;
  now?: () => number;
}) {
  const calls: Call[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return opts.respond(url, init);
  }) as unknown as typeof fetch;

  const config = loadConfig({
    PTERODACTYL_PANEL_URL: PANEL,
    PTERODACTYL_API_KEY: 'ptlc_test',
    PTERODACTYL_DEFAULT_SERVER: 'srv1',
    PTERODACTYL_ALLOWED_SERVERS: 'srv1',
  });

  const client = new PteroClient({ panelUrl: config.panelUrl, apiKey: config.apiKey, fetch: fakeFetch });

  const mcp = new McpServer({ name: 'power-test', version: '0.0.0' });

  const auditEntries: Record<string, unknown>[] = [];
  const auditSink: AuditSink = {
    append: async (entry) => {
      auditEntries.push(entry);
    },
  };

  // No elicitation capability is declared by the test client below, so the guard falls
  // back to the two-phase token flow — matching how test/guard.test.ts exercises it.
  const confirm = new Confirmation({ server: mcp, ...(opts.now ? { now: opts.now } : {}) });

  const backups: { server: string; name: string }[] = [];
  const createBackup: BackupCreator = async (server, name) => {
    backups.push({ server, name });
    return { uuid: 'backup-uuid-1' };
  };

  const guardConfig: GuardConfig = {
    readOnly: false,
    allowedServers: ['srv1'],
    allowDelete: true,
    allowKill: false,
    protectedPaths: [],
    maxMutations: 20,
    autoBackup: true,
    defaultServer: 'srv1',
    ...opts.guardOverrides,
  };

  const guard = new Guard({
    config: guardConfig,
    audit: auditSink,
    confirm,
    createBackup,
    ...(opts.now ? { now: opts.now } : {}),
  });

  const ctx: ToolContext = {
    server: mcp,
    client,
    guard,
    config,
    audit: new AuditLog('/dev/null'),
  };

  registerPowerTools(ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const testClient = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([testClient.connect(clientTransport), mcp.connect(serverTransport)]);

  return {
    client: testClient,
    calls,
    audit: auditEntries,
    backups,
    close: async () => testClient.close(),
  };
}

type CallToolResult = Awaited<ReturnType<Client['callTool']>>;

function text(result: CallToolResult): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

function structured(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('ptero_set_power_state', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers the tool with the correct annotations and an output schema', async () => {
    const h = await harness({ respond: () => json(resourcesBody('offline')) });
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['ptero_set_power_state']);
    expect(tools[0]!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tools[0]!.outputSchema).toBeDefined();
    await h.close();
  });

  it('start proceeds without confirmation and POSTs {signal:"start"}', async () => {
    const h = await harness({
      respond: (url) => {
        if (url.endsWith('/resources')) return json(resourcesBody('offline'));
        if (url.endsWith('/power')) return new Response(null, { status: 204 });
        throw new Error(`unexpected url ${url}`);
      },
    });

    const result = await h.client.callTool({
      name: 'ptero_set_power_state',
      arguments: { signal: 'start' },
    });

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      status: 'success',
      signal: 'start',
      previous_state: 'offline',
    });

    const powerCall = h.calls.find((c) => c.url.endsWith('/power'));
    expect(powerCall).toBeDefined();
    expect(powerCall!.init?.method).toBe('POST');
    expect(powerCall!.init?.body).toBe(JSON.stringify({ signal: 'start' }));

    await h.close();
  });

  it('stop needs confirmation first, then succeeds when the token is replayed', async () => {
    const h = await harness({
      respond: (url) => {
        if (url.endsWith('/resources')) return json(resourcesBody('running'));
        if (url.endsWith('/power')) return new Response(null, { status: 204 });
        throw new Error(`unexpected url ${url}`);
      },
    });

    const first = await h.client.callTool({
      name: 'ptero_set_power_state',
      arguments: { signal: 'stop' },
    });

    expect(first.isError).toBeFalsy();
    const firstStructured = structured(first);
    expect(firstStructured['status']).toBe('needs_confirmation');
    const preview = firstStructured['preview'] as Record<string, unknown>;
    expect(preview['signal']).toBe('stop');
    expect(preview['current_state']).toBe('running');
    expect(String(preview['note'])).toMatch(/disconnect/i);
    const token = firstStructured['confirmation_token'] as string;
    expect(token).toBeTruthy();

    // No POST should have happened yet.
    expect(h.calls.some((c) => c.url.endsWith('/power'))).toBe(false);

    const second = await h.client.callTool({
      name: 'ptero_set_power_state',
      arguments: { signal: 'stop', confirmation_token: token },
    });

    expect(second.isError).toBeFalsy();
    const secondStructured = structured(second);
    expect(secondStructured).toMatchObject({
      status: 'success',
      signal: 'stop',
      previous_state: 'running',
      confirmed_via: 'token',
    });

    const powerCall = h.calls.find((c) => c.url.endsWith('/power'));
    expect(powerCall!.init?.body).toBe(JSON.stringify({ signal: 'stop' }));

    await h.close();
  });

  it('refuses kill when PTERODACTYL_ALLOW_KILL is not set', async () => {
    const h = await harness({
      respond: (url) => {
        if (url.endsWith('/resources')) return json(resourcesBody('running'));
        throw new Error(`unexpected url ${url}`);
      },
      guardOverrides: { allowKill: false },
    });

    const result = await h.client.callTool({
      name: 'ptero_set_power_state',
      arguments: { signal: 'kill' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('PTERODACTYL_ALLOW_KILL');
    expect(h.calls.some((c) => c.url.endsWith('/power'))).toBe(false);

    await h.close();
  });

  it('kill with allowKill=true proceeds two-phase and reports the auto-backup id', async () => {
    const h = await harness({
      respond: (url) => {
        if (url.endsWith('/resources')) return json(resourcesBody('running'));
        if (url.endsWith('/power')) return new Response(null, { status: 204 });
        throw new Error(`unexpected url ${url}`);
      },
      guardOverrides: { allowKill: true, autoBackup: true },
    });

    const first = await h.client.callTool({
      name: 'ptero_set_power_state',
      arguments: { signal: 'kill' },
    });
    expect(structured(first)['status']).toBe('needs_confirmation');
    const token = structured(first)['confirmation_token'] as string;

    // The backup only happens once confirmation is actually given.
    expect(h.backups).toHaveLength(0);

    const second = await h.client.callTool({
      name: 'ptero_set_power_state',
      arguments: { signal: 'kill', confirmation_token: token },
    });

    expect(second.isError).toBeFalsy();
    const s = structured(second);
    expect(s['status']).toBe('success');
    expect(s['backup_id']).toBe('backup-uuid-1');
    expect(h.backups).toHaveLength(1);
    expect(h.backups[0]!.server).toBe('srv1');
    expect(h.backups[0]!.name).toContain('ptero_set_power_state');

    const powerCall = h.calls.find((c) => c.url.endsWith('/power'));
    expect(powerCall!.init?.body).toBe(JSON.stringify({ signal: 'kill' }));

    await h.close();
  });

  it('refuses a second power action within the 30s cooldown', async () => {
    let clock = 1_700_000_000_000;
    const now = () => clock;

    const h = await harness({
      respond: (url) => {
        if (url.endsWith('/resources')) return json(resourcesBody('offline'));
        if (url.endsWith('/power')) return new Response(null, { status: 204 });
        throw new Error(`unexpected url ${url}`);
      },
      now,
    });

    const firstResult = await h.client.callTool({
      name: 'ptero_set_power_state',
      arguments: { signal: 'start' },
    });
    expect(structured(firstResult)['status']).toBe('success');

    clock += 5_000; // still inside the 30s cooldown

    const secondResult = await h.client.callTool({
      name: 'ptero_set_power_state',
      arguments: { signal: 'start' },
    });

    expect(secondResult.isError).toBe(true);
    expect(text(secondResult)).toMatch(/power action/i);
    expect(text(secondResult)).toMatch(/30s|30 s/);

    // Only the first call reached the daemon.
    expect(h.calls.filter((c) => c.url.endsWith('/power'))).toHaveLength(1);

    await h.close();
  });

  it('dry_run makes no POST and reports the preview only', async () => {
    const h = await harness({
      respond: (url) => {
        if (url.endsWith('/resources')) return json(resourcesBody('running'));
        if (url.endsWith('/power')) return new Response(null, { status: 204 });
        throw new Error(`unexpected url ${url}`);
      },
    });

    const result = await h.client.callTool({
      name: 'ptero_set_power_state',
      arguments: { signal: 'restart', dry_run: true },
    });

    expect(result.isError).toBeFalsy();
    expect(structured(result)['status']).toBe('dry_run');
    expect(h.calls.some((c) => c.url.endsWith('/power'))).toBe(false);

    await h.close();
  });

  it('wait_seconds polls getResources and reports state_after once the state changes', async () => {
    vi.useFakeTimers();

    const states = ['offline', 'offline', 'running'];
    let resourceCall = 0;

    const h = await harness({
      respond: (url) => {
        if (url.endsWith('/resources')) {
          const state = states[Math.min(resourceCall, states.length - 1)]!;
          resourceCall += 1;
          return json(resourcesBody(state));
        }
        if (url.endsWith('/power')) return new Response(null, { status: 204 });
        throw new Error(`unexpected url ${url}`);
      },
    });

    const resultPromise = h.client.callTool({
      name: 'ptero_set_power_state',
      arguments: { signal: 'start', wait_seconds: 4 },
    });

    // First 2s poll: state is still 'offline' (unchanged) -> loop continues.
    await vi.advanceTimersByTimeAsync(2_000);
    // Second 2s poll: state flips to 'running' -> loop stops.
    await vi.advanceTimersByTimeAsync(2_000);

    const result = await resultPromise;

    expect(result.isError).toBeFalsy();
    const s = structured(result);
    expect(s['previous_state']).toBe('offline');
    expect(s['state_after']).toBe('running');
    // pre-check + 2 polls
    expect(h.calls.filter((c) => c.url.endsWith('/resources'))).toHaveLength(3);

    await h.close();
  });

  it.each([502, 409])(
    'maps an API %d error on dispatch to an actionable failure and audits it as an error',
    async (status) => {
      const h = await harness({
        respond: (url) => {
          if (url.endsWith('/resources')) return json(resourcesBody('offline'));
          if (url.endsWith('/power')) {
            return json(
              { errors: [{ code: 'SomeException', status: String(status), detail: 'daemon unreachable' }] },
              status,
            );
          }
          throw new Error(`unexpected url ${url}`);
        },
      });

      const result = await h.client.callTool({
        name: 'ptero_set_power_state',
        arguments: { signal: 'start' },
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain(String(status));

      const errorEntry = h.audit.find((e) => e['outcome'] === 'error');
      expect(errorEntry).toBeDefined();
      expect(errorEntry!['tool']).toBe('ptero_set_power_state');

      await h.close();
    },
  );
});
