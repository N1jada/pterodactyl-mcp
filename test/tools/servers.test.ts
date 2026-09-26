import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { PteroClient } from '../../src/client.js';
import { loadConfig } from '../../src/config.js';
import { AuditLog } from '../../src/audit.js';
import { registerServerTools } from '../../src/tools/servers.js';
import type { ToolContext } from '../../src/tools/_shared.js';

const PANEL = 'https://panel.example.com';

/* -------------------------------------------------------------------------- */
/* Fixtures — shapes copied from docs/pterodactyl-api.md                      */
/* -------------------------------------------------------------------------- */

function allocation(over: Record<string, unknown> = {}) {
  return {
    object: 'allocation',
    attributes: {
      id: 1,
      ip: '203.0.113.10',
      ip_alias: null,
      port: 25565,
      notes: null,
      is_default: true,
      ...over,
    },
  };
}

function serverAttributes(over: Record<string, unknown> = {}) {
  return {
    server_owner: true,
    identifier: '1a2b3c4d',
    uuid: '1a2b3c4d-1234-4321-abcd-0123456789ab',
    name: 'Minecraft',
    node: 'EU-Node-3',
    is_node_under_maintenance: false,
    sftp_details: { ip: 'sftp.example.com', port: 2022 },
    description: 'Paper + Geyser',
    limits: { memory: 8192, swap: 0, disk: 40960, io: 500, cpu: 400, threads: null, oom_disabled: true },
    invocation: 'java -Xms128M -Xmx8192M -jar paper.jar',
    docker_image: 'ghcr.io/pterodactyl/yolks:java_17',
    egg_features: ['eula', 'java_version'],
    feature_limits: { databases: 2, allocations: 4, backups: 5 },
    status: null,
    is_suspended: false,
    is_installing: false,
    is_transferring: false,
    relationships: {
      allocations: {
        object: 'list',
        data: [
          allocation(),
          allocation({ id: 2, port: 19132, is_default: false, notes: 'Geyser / Bedrock' }),
        ],
      },
    },
    ...over,
  };
}

function resourcesResponse(over: Record<string, unknown> = {}) {
  return {
    object: 'stats',
    attributes: {
      current_state: 'running',
      is_suspended: false,
      resources: {
        memory_bytes: 3_221_225_472,
        cpu_absolute: 143.25,
        disk_bytes: 10_737_418_240,
        network_rx_bytes: 1_048_576,
        network_tx_bytes: 2_097_152,
        uptime: 93_784_000,
      },
      ...over,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

type Responder = (url: string) => unknown;

/**
 * Wire a real McpServer (with the phase-1 tools registered) to a real MCP Client over
 * the SDK's in-memory transport pair, so tools are exercised through the actual
 * protocol rather than by calling the handler directly.
 */
async function harness(respond: Responder, env: Record<string, string> = {}) {
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = respond(url);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const config = loadConfig({
    PTERODACTYL_PANEL_URL: PANEL,
    PTERODACTYL_API_KEY: 'ptlc_test',
    PTERODACTYL_DEFAULT_SERVER: '1a2b3c4d',
    ...env,
  });

  const mcp = new McpServer({ name: 'pterodactyl-mcp-test', version: '0.0.0' });

  const ctx: ToolContext = {
    server: mcp,
    client: new PteroClient({ panelUrl: config.panelUrl, apiKey: config.apiKey, fetch: fakeFetch }),
    // guard.ts belongs to another phase and no phase-1 tool touches it.
    guard: undefined as unknown as ToolContext['guard'],
    config,
    audit: new AuditLog('/dev/null'),
  };

  registerServerTools(ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);

  return { client, mcp, close: async () => client.close() };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('phase 1 tool registration', () => {
  let h: Awaited<ReturnType<typeof harness>>;

  beforeEach(async () => {
    h = await harness(() => ({ object: 'list', data: [] }));
    return () => h.close();
  });

  it('registers exactly the three phase-1 tools', async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'ptero_get_server',
      'ptero_get_server_resources',
      'ptero_list_servers',
    ]);
  });

  it('annotates all three as read-only, non-destructive, idempotent, closed-world', async () => {
    const { tools } = await h.client.listTools();
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it('declares an output schema and a description on every tool', async () => {
    const { tools } = await h.client.listTools();
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.description ?? '', tool.name).not.toBe('');
      // Descriptions are written for the calling model: they must say when to use the
      // tool and what it does not do.
      expect(tool.description!.length, tool.name).toBeGreaterThan(150);
    }
  });

  it('exposes the server argument as optional, defaulting to the configured server', async () => {
    const { tools } = await h.client.listTools();
    const getServer = tools.find((t) => t.name === 'ptero_get_server')!;
    const schema = getServer.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.properties).toHaveProperty('server');
    expect(schema.required ?? []).not.toContain('server');
  });
});

describe('ptero_list_servers', () => {
  it('returns structured rows plus a readable summary', async () => {
    const h = await harness(() => ({
      object: 'list',
      data: [
        { object: 'server', attributes: serverAttributes() },
        {
          object: 'server',
          attributes: serverAttributes({
            identifier: 'aa11bb22',
            name: 'Test Box',
            status: 'suspended',
            is_suspended: true,
            relationships: { allocations: { object: 'list', data: [] } },
          }),
        },
      ],
      meta: { pagination: { total: 2, count: 2, per_page: 50, current_page: 1, total_pages: 1 } },
    }));

    const result = await h.client.callTool({ name: 'ptero_list_servers', arguments: {} });
    expect(result.isError).toBeFalsy();

    const structured = result.structuredContent as {
      servers: Array<Record<string, unknown>>;
      count: number;
      total: number;
      page: number;
      has_more: boolean;
    };

    expect(structured.count).toBe(2);
    expect(structured.total).toBe(2);
    expect(structured.page).toBe(1);
    expect(structured.has_more).toBe(false);

    expect(structured.servers[0]).toMatchObject({
      identifier: '1a2b3c4d',
      name: 'Minecraft',
      node: 'EU-Node-3',
      primary_allocation: '203.0.113.10:25565',
      memory_limit_mb: 8192,
      disk_limit_mb: 40960,
      is_suspended: false,
      status: null,
    });
    expect(structured.servers[1]).toMatchObject({
      identifier: 'aa11bb22',
      primary_allocation: null,
      is_suspended: true,
      status: 'suspended',
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('1a2b3c4d');
    expect(text).toContain('203.0.113.10:25565');
    expect(text).toContain('[suspended]');

    await h.close();
  });

  it('flags further pages and passes `page` through to the panel', async () => {
    let seenUrl = '';
    const h = await harness((url) => {
      seenUrl = url;
      return {
        object: 'list',
        data: [],
        meta: { pagination: { total: 120, count: 0, per_page: 50, current_page: 2, total_pages: 3 } },
      };
    });

    const result = await h.client.callTool({ name: 'ptero_list_servers', arguments: { page: 2 } });
    const structured = result.structuredContent as { has_more: boolean; page: number; total_pages: number };

    expect(new URL(seenUrl).searchParams.get('page')).toBe('2');
    expect(structured.page).toBe(2);
    expect(structured.total_pages).toBe(3);
    expect(structured.has_more).toBe(true);

    await h.close();
  });

  it('handles an empty list without pretending it failed', async () => {
    const h = await harness(() => ({ object: 'list', data: [] }));

    const result = await h.client.callTool({ name: 'ptero_list_servers', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { count: number }).count).toBe(0);
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/No servers/i);

    await h.close();
  });
});

describe('ptero_get_server', () => {
  it('surfaces every field the spec asks for', async () => {
    const h = await harness(() => ({
      object: 'server',
      attributes: serverAttributes(),
      meta: { is_server_owner: true, user_permissions: ['control.console'] },
    }));

    const result = await h.client.callTool({ name: 'ptero_get_server', arguments: {} });
    expect(result.isError).toBeFalsy();

    const s = result.structuredContent as Record<string, unknown>;

    expect(s['identifier']).toBe('1a2b3c4d');
    expect(s['uuid']).toBe('1a2b3c4d-1234-4321-abcd-0123456789ab');
    expect(s['name']).toBe('Minecraft');
    expect(s['description']).toBe('Paper + Geyser');
    expect(s['node']).toBe('EU-Node-3');
    expect(s['is_suspended']).toBe(false);
    expect(s['is_installing']).toBe(false);
    expect(s['is_transferring']).toBe(false);
    expect(s['docker_image']).toBe('ghcr.io/pterodactyl/yolks:java_17');
    expect(s['invocation']).toContain('paper.jar');

    expect(s['limits']).toMatchObject({ memory: 8192, swap: 0, disk: 40960, io: 500, cpu: 400 });
    expect(s['feature_limits']).toMatchObject({ databases: 2, allocations: 4, backups: 5 });
    expect(s['sftp_details']).toEqual({ ip: 'sftp.example.com', port: 2022 });

    const allocations = s['allocations'] as Array<Record<string, unknown>>;
    expect(allocations).toHaveLength(2);
    expect(allocations[0]).toEqual({
      id: 1,
      ip: '203.0.113.10',
      ip_alias: null,
      port: 25565,
      is_default: true,
      notes: null,
    });
    expect(allocations[1]).toMatchObject({ port: 19132, is_default: false, notes: 'Geyser / Bedrock' });

    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('203.0.113.10:19132');
    expect(text).toContain('Geyser / Bedrock');
    expect(text).toContain('(primary)');

    await h.close();
  });

  it('uses the explicit server argument over the configured default', async () => {
    let seenUrl = '';
    const h = await harness((url) => {
      seenUrl = url;
      return { object: 'server', attributes: serverAttributes({ identifier: 'zz999999' }) };
    });

    await h.client.callTool({ name: 'ptero_get_server', arguments: { server: 'zz999999' } });
    expect(seenUrl).toBe(`${PANEL}/api/client/servers/zz999999`);

    await h.close();
  });

  it('returns an actionable tool error when no server is given and none is configured', async () => {
    const h = await harness(
      () => ({ object: 'server', attributes: serverAttributes() }),
      { PTERODACTYL_DEFAULT_SERVER: '' },
    );

    const result = await h.client.callTool({ name: 'ptero_get_server', arguments: {} });
    expect(result.isError).toBe(true);

    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('PTERODACTYL_DEFAULT_SERVER');
    expect(text).toContain('ptero_list_servers');

    await h.close();
  });

  it('turns a panel 404 into an error result rather than throwing', async () => {
    const h = await harness(
      () =>
        new Response(
          JSON.stringify({ errors: [{ code: 'NotFoundHttpException', status: '404', detail: 'Not found.' }] }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
    );

    const result = await h.client.callTool({ name: 'ptero_get_server', arguments: { server: 'nope' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('ptero_list_servers');

    await h.close();
  });

  it('copes with a key that cannot read allocations', async () => {
    const h = await harness(() => ({
      object: 'server',
      attributes: serverAttributes({ relationships: {} }),
    }));

    const result = await h.client.callTool({ name: 'ptero_get_server', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { allocations: unknown[] }).allocations).toEqual([]);

    await h.close();
  });
});

describe('ptero_get_server_resources', () => {
  it('reports state, byte counts with human forms, CPU and uptime', async () => {
    const h = await harness(() => resourcesResponse());

    const result = await h.client.callTool({ name: 'ptero_get_server_resources', arguments: {} });
    expect(result.isError).toBeFalsy();

    const s = result.structuredContent as Record<string, unknown>;

    expect(s['server']).toBe('1a2b3c4d');
    expect(s['current_state']).toBe('running');
    expect(s['is_suspended']).toBe(false);

    expect(s['memory_bytes']).toBe(3_221_225_472);
    expect(s['memory_human']).toBe('3.00 GiB');
    expect(s['cpu_absolute']).toBe(143.25);
    expect(s['disk_bytes']).toBe(10_737_418_240);
    expect(s['disk_human']).toBe('10.0 GiB');
    expect(s['network_rx_bytes']).toBe(1_048_576);
    expect(s['network_rx_human']).toBe('1.00 MiB');
    expect(s['network_tx_human']).toBe('2.00 MiB');

    expect(s['uptime_ms']).toBe(93_784_000);
    expect(s['uptime_human']).toBe('1d 2h 3m 4s');

    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('running');
    expect(text).toContain('3.00 GiB');
    expect(text).toContain('1d 2h 3m 4s');

    await h.close();
  });

  it('reports an offline server as all zeroes without erroring', async () => {
    const h = await harness(() =>
      resourcesResponse({
        current_state: 'offline',
        resources: {
          memory_bytes: 0,
          cpu_absolute: 0,
          disk_bytes: 0,
          network_rx_bytes: 0,
          network_tx_bytes: 0,
          uptime: 0,
        },
      }),
    );

    const result = await h.client.callTool({ name: 'ptero_get_server_resources', arguments: {} });
    const s = result.structuredContent as Record<string, unknown>;

    expect(result.isError).toBeFalsy();
    expect(s['current_state']).toBe('offline');
    expect(s['uptime_human']).toBe('0s');
    expect(s['memory_human']).toBe('0 B');

    await h.close();
  });

  it('flags suspension in the summary text', async () => {
    const h = await harness(() => resourcesResponse({ current_state: 'offline', is_suspended: true }));

    const result = await h.client.callTool({ name: 'ptero_get_server_resources', arguments: {} });
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('SUSPENDED');

    await h.close();
  });
});
