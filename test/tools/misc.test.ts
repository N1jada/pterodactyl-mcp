import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';

import { AuditLog } from '../../src/audit.js';
import { PteroClient } from '../../src/client.js';
import { loadConfig } from '../../src/config.js';
import { registerMiscTools } from '../../src/tools/misc.js';
import type { ToolContext } from '../../src/tools/_shared.js';

const PANEL = 'https://panel.example.com';

/* -------------------------------------------------------------------------- */
/* Harness — mirrors test/tools/servers.test.ts. All misc tools are read-only */
/* so, exactly like phase 1, the guard is never touched.                     */
/* -------------------------------------------------------------------------- */

type Responder = (url: string) => unknown;

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
    guard: undefined as unknown as ToolContext['guard'],
    config,
    audit: new AuditLog('/dev/null'),
  };

  registerMiscTools(ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);

  return { client, close: async () => client.close() };
}

/* -------------------------------------------------------------------------- */
/* ptero_list_schedules                                                       */
/* -------------------------------------------------------------------------- */

describe('ptero_list_schedules', () => {
  it('returns cron as one string, flags, run times and ordered tasks', async () => {
    const h = await harness(() => ({
      object: 'list',
      data: [
        {
          object: 'server_schedule',
          attributes: {
            id: 1,
            name: 'Nightly restart',
            cron: { minute: '0', hour: '3', day_of_month: '*', month: '*', day_of_week: '*' },
            is_active: true,
            is_processing: false,
            only_when_online: true,
            last_run_at: '2024-01-01T03:00:00+00:00',
            next_run_at: '2024-01-02T03:00:00+00:00',
            created_at: '2023-01-01T00:00:00+00:00',
            updated_at: '2023-01-01T00:00:00+00:00',
            relationships: {
              tasks: {
                object: 'list',
                data: [
                  {
                    object: 'schedule_task',
                    attributes: {
                      id: 1,
                      sequence_id: 1,
                      action: 'power',
                      payload: 'restart',
                      time_offset: 0,
                      is_queued: false,
                      continue_on_failure: false,
                      created_at: '2023-01-01T00:00:00+00:00',
                      updated_at: '2023-01-01T00:00:00+00:00',
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    }));

    const result = await h.client.callTool({ name: 'ptero_list_schedules', arguments: {} });
    expect(result.isError).toBeFalsy();

    const s = result.structuredContent as { server: string; count: number; schedules: Array<Record<string, unknown>> };
    expect(s.server).toBe('1a2b3c4d');
    expect(s.count).toBe(1);

    const sched = s.schedules[0]!;
    expect(sched['name']).toBe('Nightly restart');
    expect(sched['cron']).toBe('0 3 * * *');
    expect(sched['is_active']).toBe(true);
    expect(sched['only_when_online']).toBe(true);
    expect(sched['last_run_at']).toBe('2024-01-01T03:00:00+00:00');
    expect(sched['next_run_at']).toBe('2024-01-02T03:00:00+00:00');

    const tasks = sched['tasks'] as Array<Record<string, unknown>>;
    expect(tasks).toEqual([
      { sequence_id: 1, action: 'power', payload: 'restart', time_offset: 0, continue_on_failure: false },
    ]);

    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('Nightly restart');
    expect(text).toContain('0 3 * * *');

    await h.close();
  });

  it('reports no schedules without erroring', async () => {
    const h = await harness(() => ({ object: 'list', data: [] }));
    const result = await h.client.callTool({ name: 'ptero_list_schedules', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { count: number }).count).toBe(0);
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/No schedules/i);
    await h.close();
  });
});

/* -------------------------------------------------------------------------- */
/* ptero_list_allocations                                                     */
/* -------------------------------------------------------------------------- */

describe('ptero_list_allocations', () => {
  it('returns ip/port rows and marks the default allocation in the summary', async () => {
    const h = await harness(() => ({
      object: 'list',
      data: [
        {
          object: 'allocation',
          attributes: { id: 1, ip: '203.0.113.10', ip_alias: null, port: 25565, notes: null, is_default: true },
        },
        {
          object: 'allocation',
          attributes: {
            id: 2,
            ip: '203.0.113.10',
            ip_alias: null,
            port: 19132,
            notes: 'Geyser / Bedrock',
            is_default: false,
          },
        },
      ],
    }));

    const result = await h.client.callTool({ name: 'ptero_list_allocations', arguments: {} });
    expect(result.isError).toBeFalsy();

    const s = result.structuredContent as { count: number; allocations: Array<Record<string, unknown>> };
    expect(s.count).toBe(2);
    expect(s.allocations[0]).toEqual({
      id: 1,
      ip: '203.0.113.10',
      ip_alias: null,
      port: 25565,
      notes: null,
      is_default: true,
    });
    expect(s.allocations[1]).toMatchObject({ port: 19132, notes: 'Geyser / Bedrock', is_default: false });

    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('203.0.113.10:25565 (default)');
    expect(text).toContain('203.0.113.10:19132');
    expect(text).toContain('Geyser / Bedrock');

    await h.close();
  });
});

/* -------------------------------------------------------------------------- */
/* ptero_get_startup_variables                                                */
/* -------------------------------------------------------------------------- */

describe('ptero_get_startup_variables', () => {
  it('returns the startup command, raw command, docker image and variables', async () => {
    const h = await harness(() => ({
      object: 'list',
      data: [
        {
          object: 'egg_variable',
          attributes: {
            name: 'Server Jar File',
            description: 'The name of the server jar to run.',
            env_variable: 'SERVER_JARFILE',
            default_value: 'server.jar',
            server_value: 'paper.jar',
            is_editable: true,
            rules: 'required|string|max:20',
          },
        },
      ],
      meta: {
        startup_command: 'java -jar {{SERVER_JARFILE}}',
        raw_startup_command: 'java -jar {{SERVER_JARFILE}} --nogui',
        docker_images: { 'Java 17': 'ghcr.io/pterodactyl/yolks:java_17' },
      },
    }));

    const result = await h.client.callTool({ name: 'ptero_get_startup_variables', arguments: {} });
    expect(result.isError).toBeFalsy();

    const s = result.structuredContent as Record<string, unknown>;
    expect(s['startup_command']).toBe('java -jar {{SERVER_JARFILE}}');
    expect(s['raw_startup_command']).toBe('java -jar {{SERVER_JARFILE}} --nogui');
    expect(s['docker_image']).toBe('ghcr.io/pterodactyl/yolks:java_17');

    const variables = s['variables'] as Array<Record<string, unknown>>;
    expect(variables).toEqual([
      {
        name: 'Server Jar File',
        env_variable: 'SERVER_JARFILE',
        description: 'The name of the server jar to run.',
        server_value: 'paper.jar',
        default_value: 'server.jar',
        is_editable: true,
        rules: 'required|string|max:20',
      },
    ]);

    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('SERVER_JARFILE');
    expect(text).toContain('paper.jar');

    await h.close();
  });

  it('omits docker_image when the panel reports more than one candidate image', async () => {
    const h = await harness(() => ({
      object: 'list',
      data: [],
      meta: {
        startup_command: 'java -jar server.jar',
        raw_startup_command: 'java -jar server.jar',
        docker_images: { 'Java 17': 'ghcr.io/pterodactyl/yolks:java_17', 'Java 21': 'ghcr.io/pterodactyl/yolks:java_21' },
      },
    }));

    const result = await h.client.callTool({ name: 'ptero_get_startup_variables', arguments: {} });
    const s = result.structuredContent as Record<string, unknown>;
    expect(s['docker_image']).toBeUndefined();

    await h.close();
  });
});
