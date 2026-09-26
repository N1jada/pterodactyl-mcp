/**
 * Structural safety net (SPEC §7 / ARCHITECTURE.md "Tool annotations").
 *
 * Every mutating tool is *supposed* to reach the panel only through
 * `runMutation` -> `Guard.check` (`src/tools/_shared.ts`, `src/guard.ts`), but the guard
 * trusts each tool to describe its own effect (`destructive`, `paths`, `fileCount`, ...).
 * A future tool that forgets a field silently loses a safety layer, and nothing in the
 * type system catches that: `MutationRequest` fields are all individually optional or
 * defaultable.
 *
 * This file does not unit-test any one tool (that's `test/tools/*.test.ts`). It builds
 * the REAL server via `buildServer()`, drives it exclusively through `tools/list` +
 * `tools/call` over a real MCP `Client`, and asserts the properties that must hold for
 * *every* tool, present and future:
 *
 *  1. annotation + schema completeness (every tool declares all four hints; every
 *     mutating tool exposes `dry_run`; every destructive tool exposes
 *     `confirmation_token`, with exactly one documented exception) — and the live tool
 *     set matches `docs/ARCHITECTURE.md`'s "Tool annotations" table exactly, so the
 *     table itself is the single source of truth these tests are pinned against;
 *  2. PTERODACTYL_READ_ONLY blocks every mutating tool before any write reaches fetch;
 *  3. every destructive tool refuses to act without a confirmation token;
 *  4. protected paths hold across every path-taking tool, both directions of a rename;
 *  5. every read-only tool only ever issues GETs, even when the console websocket is
 *     unreachable;
 *  6. the audit log records exactly one line per guarded call and never the API key.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../../src/index.js';

const PANEL = 'https://panel.example.com';
const SERVER = '1a2b3c4d';
/** Long enough to survive AuditLog's MIN_SECRET_LENGTH(8) scrub check. */
const API_KEY = 'ptlc_test_super_secret_key_do_not_leak';

/* -------------------------------------------------------------------------- */
/* docs/ARCHITECTURE.md — parsed as the single source of truth                */
/* -------------------------------------------------------------------------- */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHITECTURE_MD = join(__dirname, '../../docs/ARCHITECTURE.md');

interface DocRow {
  names: string[];
  readOnly: boolean;
  destructive: boolean;
}

/** Parse the "## Tool annotations" markdown table into per-row booleans + tool names. */
function parseArchitectureAnnotations(): DocRow[] {
  const text = readFileSync(ARCHITECTURE_MD, 'utf8');
  const marker = '## Tool annotations';
  const start = text.indexOf(marker);
  if (start === -1) {
    throw new Error(`ARCHITECTURE.md: "${marker}" section not found — did it get renamed?`);
  }
  const rows: DocRow[] = [];
  for (const line of text.slice(start).split('\n')) {
    if (!line.startsWith('| ptero_')) continue; // skips the header and the `|---|` rule
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    const [namesCell, readOnlyCell, destructiveCell] = cells;
    rows.push({
      names: (namesCell ?? '').split(',').map((n) => n.trim()).filter(Boolean),
      readOnly: readOnlyCell === 'true',
      destructive: destructiveCell === 'true',
    });
  }
  if (rows.length === 0) {
    throw new Error('ARCHITECTURE.md: no tool rows parsed out of the "Tool annotations" table.');
  }
  return rows;
}

const DOC_ROWS = parseArchitectureAnnotations();
const DOC_ALL_NAMES = DOC_ROWS.flatMap((r) => r.names).sort();
const DOC_READ_ONLY_NAMES = DOC_ROWS.filter((r) => r.readOnly).flatMap((r) => r.names).sort();
const DOC_NON_READ_ONLY_NAMES = DOC_ROWS.filter((r) => !r.readOnly).flatMap((r) => r.names).sort();
const DOC_DESTRUCTIVE_NAMES = DOC_ROWS.filter((r) => r.destructive).flatMap((r) => r.names).sort();

/** The one documented exception: destructive by design, but never asks for a token. */
const UNCONFIRMED_DESTRUCTIVE_EXCEPTION = 'ptero_send_console_command';

/* -------------------------------------------------------------------------- */
/* Fake panel — records every request, answers plausibly for anything GET     */
/* -------------------------------------------------------------------------- */

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string | undefined;
}

function fileObject(name: string, size = 200, isFile = true) {
  return {
    object: 'file_object',
    attributes: {
      name,
      mode: isFile ? '-rw-r--r--' : 'drwxr-xr-x',
      mode_bits: isFile ? '644' : '755',
      size,
      is_file: isFile,
      is_symlink: false,
      mimetype: isFile ? 'text/plain' : 'inode/directory',
      created_at: '2024-01-01T00:00:00+00:00',
      modified_at: '2024-01-02T03:04:05+00:00',
    },
  };
}

/**
 * A GET answer for every endpoint any tool in this server can reach, plus a 204 for
 * everything else (the mutation endpoints, which none of these tests should ever
 * successfully invoke — the guard is supposed to stop them first).
 *
 * `/files/list` always reports a single file named `config.yml` regardless of the
 * directory asked for, so `ptero_write_file`'s own pre-flight existence probe always
 * finds a match — every write below is therefore an "overwrite", which is what makes it
 * destructive and lets the guard's confirmation layer (not the tool's own guess) be the
 * thing under test.
 */
function defaultRespond(req: Recorded): unknown {
  const { method, path } = req;

  if (path.endsWith('/websocket')) {
    // A syntactically valid credential pointing at a port nothing listens on: the
    // websocket tools should fail fast (ECONNREFUSED) without ever reaching here again.
    return { data: { token: 'dummy.websocket.token', socket: 'ws://127.0.0.1:1/' } };
  }
  if (path.endsWith('/resources')) {
    return {
      object: 'stats',
      attributes: {
        current_state: 'running',
        is_suspended: false,
        resources: {
          memory_bytes: 1_000_000,
          cpu_absolute: 1,
          disk_bytes: 1_000_000,
          network_rx_bytes: 0,
          network_tx_bytes: 0,
          uptime: 60_000,
        },
      },
    };
  }
  if (path.endsWith('/files/list')) {
    return { object: 'list', data: [fileObject('config.yml', 200)] };
  }
  if (path.endsWith('/files/contents')) {
    return 'sample file contents\n';
  }
  if (path.endsWith('/network/allocations')) {
    return { object: 'list', data: [] };
  }
  if (path.endsWith('/schedules')) {
    return { object: 'list', data: [] };
  }
  if (path.endsWith('/startup')) {
    return {
      object: 'list',
      data: [],
      meta: { startup_command: 'java -jar server.jar', raw_startup_command: 'java -jar server.jar' },
    };
  }
  if (/\/backups\/[^/]+\/download$/.test(path) && method === 'GET') {
    return { object: 'signed_url', attributes: { url: 'https://panel.example.com/dl/dummy' } };
  }
  if (/\/backups\/[^/]+$/.test(path) && method === 'GET') {
    return {
      object: 'backup',
      attributes: {
        uuid: path.split('/').filter(Boolean).pop(),
        is_successful: true,
        is_locked: false,
        name: 'backup-1',
        ignored_files: [],
        checksum: 'deadbeef',
        bytes: 100,
        created_at: '2024-01-01T00:00:00+00:00',
        completed_at: '2024-01-01T00:01:00+00:00',
      },
    };
  }
  if (path.endsWith('/backups') && method === 'GET') {
    return { object: 'list', data: [], meta: {} };
  }
  if (/\/servers\/[^/]+$/.test(path) && method === 'GET') {
    return {
      object: 'server',
      attributes: {
        server_owner: true,
        identifier: SERVER,
        uuid: `${SERVER}-0000-0000-0000-000000000000`,
        name: 'Test Server',
        node: 'node-1',
        sftp_details: { ip: '127.0.0.1', port: 2022 },
        description: null,
        limits: { memory: 1024, swap: 0, disk: 1024, io: 500, cpu: 100 },
        invocation: 'java -jar server.jar',
        docker_image: 'itzg/minecraft-server',
        feature_limits: { databases: 0, allocations: 1, backups: 5 },
        status: null,
        is_suspended: false,
        is_installing: false,
        is_transferring: false,
      },
    };
  }
  if (path === '/' && method === 'GET') {
    return {
      object: 'list',
      data: [],
      meta: { pagination: { total: 0, count: 0, per_page: 50, current_page: 1, total_pages: 1 } },
    };
  }
  return undefined; // 204 — reached only if a guard failed to stop a real mutation.
}

function buildHarness(env: Record<string, string> = {}) {
  const requests: Recorded[] = [];

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const parsed = new URL(url);
    const record: Recorded = {
      method: init?.method ?? 'GET',
      path: parsed.pathname.replace('/api/client', '') || '/',
      query: parsed.searchParams,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    requests.push(record);

    const result = defaultRespond(record);
    if (result === undefined) return new Response(null, { status: 204 });
    if (typeof result === 'string') {
      return new Response(result, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  vi.stubGlobal('fetch', fakeFetch);

  const { server, ctx } = buildServer({
    PTERODACTYL_PANEL_URL: PANEL,
    PTERODACTYL_API_KEY: API_KEY,
    PTERODACTYL_DEFAULT_SERVER: SERVER,
    ...env,
  });

  return { server, ctx, requests };
}

async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'guard-coverage-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  return content[0]?.text ?? '';
}

function schemaHas(tool: { inputSchema?: unknown }, prop: string): boolean {
  const props =
    (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  return Object.prototype.hasOwnProperty.call(props, prop);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/* Shared audit-log path — tests 2-4 all point at it; test 6 reads it back    */
/* -------------------------------------------------------------------------- */

const AUDIT_DIR = mkdtempSync(join(tmpdir(), 'ptero-guard-coverage-'));
const AUDIT_LOG_PATH = join(AUDIT_DIR, 'audit.jsonl');
let expectedAuditLines = 0;

/**
 * `ptero_upload_file` reads its bytes off the local disk before it reaches the guard, so
 * every call below needs a real local file — otherwise the tool would fail on the local
 * stat and never exercise the guard layer this file is about.
 */
const LOCAL_UPLOAD_FIXTURE = join(AUDIT_DIR, 'upload-fixture.bin');
writeFileSync(LOCAL_UPLOAD_FIXTURE, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));

async function callAndCount(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  expectedAuditLines += 1;
  return result;
}

/* -------------------------------------------------------------------------- */
/* 1. Annotation + schema completeness, pinned to docs/ARCHITECTURE.md        */
/* -------------------------------------------------------------------------- */

describe('1. every tool declares the full guard-completeness contract', () => {
  it('matches docs/ARCHITECTURE.md exactly, and only ptero_send_console_command skips confirmation_token', async () => {
    const { server } = buildHarness({ PTERODACTYL_AUDIT_LOG: join(AUDIT_DIR, 'unused-1.jsonl') });
    const client = await connectClient(server);
    const { tools } = await client.listTools();

    // The live tool set must be exactly what the architecture doc's table lists.
    expect(tools.map((t) => t.name).sort()).toEqual(DOC_ALL_NAMES);

    const missingHints: string[] = [];
    const noOutputSchema: string[] = [];
    const mutatingWithoutDryRun: string[] = [];
    const readOnlyWithMutationFields: string[] = [];
    const destructiveWithoutToken: string[] = [];

    for (const tool of tools) {
      const a = (tool.annotations ?? {}) as Record<string, unknown>;
      const hasAllHints =
        typeof a['readOnlyHint'] === 'boolean' &&
        typeof a['destructiveHint'] === 'boolean' &&
        typeof a['idempotentHint'] === 'boolean' &&
        typeof a['openWorldHint'] === 'boolean';
      if (!hasAllHints) missingHints.push(tool.name);
      if (!tool.outputSchema) noOutputSchema.push(tool.name);

      const readOnly = a['readOnlyHint'] === true;
      const destructive = a['destructiveHint'] === true;
      const hasDryRun = schemaHas(tool, 'dry_run');
      const hasToken = schemaHas(tool, 'confirmation_token');

      if (readOnly) {
        if (hasDryRun || hasToken) readOnlyWithMutationFields.push(tool.name);
      } else {
        if (!hasDryRun) mutatingWithoutDryRun.push(tool.name);
        if (destructive && !hasToken) destructiveWithoutToken.push(tool.name);
      }
    }

    expect(missingHints, 'tools missing one or more of the four annotation hints').toEqual([]);
    expect(noOutputSchema, 'tools missing an outputSchema').toEqual([]);
    expect(mutatingWithoutDryRun, 'mutating tools missing dry_run in their input schema').toEqual([]);
    expect(
      readOnlyWithMutationFields,
      'read-only tools that unexpectedly declare dry_run/confirmation_token',
    ).toEqual([]);
    // The whole point of this test file: this must be *exactly* the one documented
    // exception, not "empty" and not "more than one".
    expect(destructiveWithoutToken.sort()).toEqual([UNCONFIRMED_DESTRUCTIVE_EXCEPTION]);

    // Cross-check the doc-derived readOnly/destructive sets against the live server too.
    const readOnlyNames = tools
      .filter((t) => (t.annotations as Record<string, unknown> | undefined)?.['readOnlyHint'] === true)
      .map((t) => t.name)
      .sort();
    const nonReadOnlyNames = tools
      .filter((t) => (t.annotations as Record<string, unknown> | undefined)?.['readOnlyHint'] === false)
      .map((t) => t.name)
      .sort();
    const destructiveNames = tools
      .filter((t) => (t.annotations as Record<string, unknown> | undefined)?.['destructiveHint'] === true)
      .map((t) => t.name)
      .sort();
    expect(readOnlyNames).toEqual(DOC_READ_ONLY_NAMES);
    expect(nonReadOnlyNames).toEqual(DOC_NON_READ_ONLY_NAMES);
    expect(destructiveNames).toEqual(DOC_DESTRUCTIVE_NAMES);

    await client.close();
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Read-only mode blocks every mutating tool, end-to-end                   */
/* -------------------------------------------------------------------------- */

/** Minimal valid arguments for every non-read-only tool, derived from its own schema. */
const MUTATING_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  ptero_send_console_command: { command: 'say hello' },
  ptero_write_file: { path: 'plugins/config.yml', content: 'hello: world\n' },
  ptero_upload_file: { local_path: LOCAL_UPLOAD_FIXTURE, remote_dir: 'plugins', remote_name: 'config.yml' },
  ptero_rename_file: { root: '/', from: 'plugins/old.jar', to: 'plugins/new.jar' },
  ptero_copy_file: { path: 'plugins/config.yml' },
  ptero_delete_file: { root: '/plugins', files: ['old.jar'] },
  ptero_set_power_state: { signal: 'stop' },
  ptero_create_backup: {},
  ptero_delete_backup: { backup_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
};

describe('2. PTERODACTYL_READ_ONLY blocks every mutating tool', () => {
  it('refuses every non-read-only tool and issues no POST/PUT/DELETE', async () => {
    expect(Object.keys(MUTATING_TOOL_ARGS).sort()).toEqual(DOC_NON_READ_ONLY_NAMES);

    const { server, requests } = buildHarness({
      PTERODACTYL_READ_ONLY: 'true',
      PTERODACTYL_AUDIT_LOG: AUDIT_LOG_PATH,
    });
    const client = await connectClient(server);

    for (const [name, args] of Object.entries(MUTATING_TOOL_ARGS)) {
      const result = await callAndCount(client, name, args);
      expect((result as { isError?: boolean }).isError, `${name} should error in read-only mode`).toBe(
        true,
      );
      expect(firstText(result), `${name} error text`).toContain('PTERODACTYL_READ_ONLY');
    }

    const nonGet = requests.filter((r) => r.method !== 'GET');
    expect(nonGet, `unexpected non-GET requests: ${JSON.stringify(nonGet)}`).toEqual([]);

    await client.close();
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Destructive tools never mutate without a confirmation token             */
/* -------------------------------------------------------------------------- */

/**
 * `ptero_write_file` targets `plugins/config.yml`, which the fake panel's `/files/list`
 * always reports as existing — making this call an overwrite, and therefore destructive.
 */
const DESTRUCTIVE_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  ptero_write_file: { path: 'plugins/config.yml', content: 'new: content\n' },
  ptero_upload_file: { local_path: LOCAL_UPLOAD_FIXTURE, remote_dir: 'plugins', remote_name: 'config.yml' },
  ptero_delete_file: { root: '/plugins', files: ['unimportant.jar'] },
  ptero_set_power_state: { signal: 'stop' },
  ptero_delete_backup: { backup_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
};

describe('3. destructive tools refuse to mutate without a confirmation token', () => {
  it('every destructiveHint tool except ptero_send_console_command needs confirmation first', async () => {
    const expectedDestructiveNeedingToken = DOC_DESTRUCTIVE_NAMES.filter(
      (n) => n !== UNCONFIRMED_DESTRUCTIVE_EXCEPTION,
    ).sort();
    expect(Object.keys(DESTRUCTIVE_TOOL_ARGS).sort()).toEqual(expectedDestructiveNeedingToken);

    const { server, requests } = buildHarness({
      PTERODACTYL_ALLOW_DELETE: 'true',
      PTERODACTYL_ALLOW_KILL: 'true',
      PTERODACTYL_AUTO_BACKUP: 'false',
      PTERODACTYL_AUDIT_LOG: AUDIT_LOG_PATH,
    });
    const client = await connectClient(server);

    for (const [name, args] of Object.entries(DESTRUCTIVE_TOOL_ARGS)) {
      const result = await callAndCount(client, name, args);
      const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
      const status = structured?.['status'];
      expect(['needs_confirmation', 'refused'], `${name} status was ${String(status)}`).toContain(
        status,
      );
    }

    const nonGet = requests.filter((r) => r.method !== 'GET');
    expect(nonGet, `unexpected non-GET requests: ${JSON.stringify(nonGet)}`).toEqual([]);

    await client.close();
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Protected paths hold across every path-taking mutating tool             */
/* -------------------------------------------------------------------------- */

const PROTECTED_TARGETS = ['world/level.dat', 'server.properties', 'banned-ips.json', 'ops.json'];

describe('4. protected paths hold across every path-taking tool', () => {
  it('refuses ptero_write_file / ptero_delete_file / ptero_rename_file (both directions) / ptero_copy_file', async () => {
    const { server, requests } = buildHarness({
      PTERODACTYL_ALLOW_DELETE: 'true',
      PTERODACTYL_ALLOW_KILL: 'true',
      PTERODACTYL_AUDIT_LOG: AUDIT_LOG_PATH,
    });
    const client = await connectClient(server);

    const expectRefused = async (name: string, args: Record<string, unknown>): Promise<void> => {
      const before = requests.length;
      const result = await callAndCount(client, name, args);
      const label = `${name} ${JSON.stringify(args)}`;
      expect((result as { isError?: boolean }).isError, label).toBe(true);
      expect(firstText(result), label).toContain('PTERODACTYL_PROTECTED_PATHS');
      const writes = requests.slice(before).filter((r) => r.method !== 'GET');
      expect(writes, `${label} issued a write: ${JSON.stringify(writes)}`).toEqual([]);
    };

    for (const target of PROTECTED_TARGETS) {
      await expectRefused('ptero_write_file', { path: target, content: 'x' });
      await expectRefused('ptero_upload_file', {
        local_path: LOCAL_UPLOAD_FIXTURE,
        remote_dir: target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '/',
        remote_name: target.slice(target.lastIndexOf('/') + 1),
      });
      await expectRefused('ptero_delete_file', { root: '/', files: [target] });
      await expectRefused('ptero_rename_file', { root: '/', from: target, to: 'safe-place.tmp' });
      await expectRefused('ptero_rename_file', { root: '/', from: 'safe-source.tmp', to: target });
      await expectRefused('ptero_copy_file', { path: target });
    }

    await client.close();
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Read-only tools issue only GETs, even against a dead console websocket  */
/* -------------------------------------------------------------------------- */

const READ_ONLY_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  ptero_list_servers: {},
  ptero_get_server: {},
  ptero_get_server_resources: {},
  ptero_get_console_log: { window_seconds: 1, max_lines: 5 },
  ptero_list_files: {},
  ptero_read_file: { path: 'config.yml' },
  ptero_list_backups: {},
  ptero_get_backup_download_url: { backup_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
  ptero_list_schedules: {},
  ptero_list_allocations: {},
  ptero_get_startup_variables: {},
};

describe('5. read-only tools issue only GETs', () => {
  it(
    'every readOnlyHint tool only performs GETs, including ptero_get_console_log against an unreachable socket',
    async () => {
      expect(Object.keys(READ_ONLY_TOOL_ARGS).sort()).toEqual(DOC_READ_ONLY_NAMES);

      const { server, requests } = buildHarness({
        PTERODACTYL_AUDIT_LOG: join(AUDIT_DIR, 'unused-5.jsonl'),
      });
      const client = await connectClient(server);

      for (const [name, args] of Object.entries(READ_ONLY_TOOL_ARGS)) {
        const result = await client.callTool({ name, arguments: args });
        if (name !== 'ptero_get_console_log') {
          expect((result as { isError?: boolean }).isError, `${name} unexpectedly errored: ${firstText(result)}`).toBeFalsy();
        }
        // ptero_get_console_log is explicitly allowed to fail against the dummy socket —
        // the point of this test is that it never sends anything but the GET for
        // credentials while trying.
      }

      const nonGet = requests.filter((r) => r.method !== 'GET');
      expect(nonGet, `unexpected non-GET requests: ${JSON.stringify(nonGet)}`).toEqual([]);

      await client.close();
    },
    15_000,
  );
});

/* -------------------------------------------------------------------------- */
/* 6. Audit log: one line per guarded call, never the API key                 */
/* -------------------------------------------------------------------------- */

describe('6. audit log integrity', () => {
  it('records exactly one line per guarded call from tests 2-4, and never the API key', () => {
    expect(expectedAuditLines).toBeGreaterThan(0);

    const raw = readFileSync(AUDIT_LOG_PATH, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(expectedAuditLines);

    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(['refused', 'needs_confirmation']).toContain(entry['outcome']);
      expect(typeof entry['tool']).toBe('string');
    }

    expect(raw).not.toContain(API_KEY);
  });
});
