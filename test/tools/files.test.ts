import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AuditLog } from '../../src/audit.js';
import { PteroClient } from '../../src/client.js';
import { loadConfig } from '../../src/config.js';
import { Confirmation, type ElicitCapableServer } from '../../src/confirm.js';
import { Guard, type AuditSink, type BackupCreator } from '../../src/guard.js';
import { registerFileTools } from '../../src/tools/files.js';
import type { ToolContext } from '../../src/tools/_shared.js';

const PANEL = 'https://panel.example.com';
const SERVER = '1a2b3c4d';

/* -------------------------------------------------------------------------- */
/* Fixtures — `file_object` shape from docs/pterodactyl-api.md §9             */
/* -------------------------------------------------------------------------- */

function fileObject(over: Record<string, unknown> = {}) {
  return {
    object: 'file_object',
    attributes: {
      name: 'latest.log',
      mode: '-rw-r--r--',
      mode_bits: '644',
      size: 1234,
      is_file: true,
      is_symlink: false,
      mimetype: 'text/plain',
      created_at: '2024-01-01T00:00:00+00:00',
      modified_at: '2024-01-02T03:04:05+00:00',
      ...over,
    },
  };
}

function listing(...entries: ReturnType<typeof fileObject>[]) {
  return { object: 'list', data: entries };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Recorded {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  body: string | undefined;
  /** The verbatim `RequestInit`, so a non-string body (multipart) can be inspected. */
  init: RequestInit | undefined;
}

type Responder = (req: Recorded) => unknown;

/**
 * A real `McpServer` with the phase-3 tools registered, wired to a real MCP `Client`
 * over the SDK's in-memory transport, a `PteroClient` backed by a recording fake
 * fetch, and the REAL `Guard` + `Confirmation` (with a stub MCP server that declares
 * no elicitation capability, so the two-phase token flow is exercised).
 */
async function harness(respond: Responder, env: Record<string, string> = {}) {
  const requests: Recorded[] = [];

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const parsed = new URL(url);
    const record: Recorded = {
      method: init?.method ?? 'GET',
      url,
      path: parsed.pathname.replace('/api/client', ''),
      query: parsed.searchParams,
      body: typeof init?.body === 'string' ? init.body : undefined,
      init,
    };
    requests.push(record);

    const result = respond(record);
    if (result instanceof Response) return result;
    if (result === undefined) return new Response(null, { status: 204 });
    if (typeof result === 'string') {
      return new Response(result, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const config = loadConfig({
    PTERODACTYL_PANEL_URL: PANEL,
    PTERODACTYL_API_KEY: 'ptlc_test',
    PTERODACTYL_DEFAULT_SERVER: SERVER,
    ...env,
  });

  const auditEntries: Record<string, unknown>[] = [];
  const audit: AuditSink = {
    append: async (entry) => {
      auditEntries.push(entry);
    },
  };

  const backups: { server: string; name: string }[] = [];
  const createBackup: BackupCreator = async (server, name) => {
    backups.push({ server, name });
    return { uuid: 'backup-uuid-1' };
  };

  // No elicitation capability -> guard falls back to the two-phase token flow.
  const elicitStub: ElicitCapableServer = {
    server: {
      getClientCapabilities: () => ({}),
      elicitInput: async () => ({ action: 'decline' }),
    },
  };
  const confirm = new Confirmation({ server: elicitStub });

  const mcp = new McpServer({ name: 'pterodactyl-mcp-test', version: '0.0.0' });

  const ctx: ToolContext = {
    server: mcp,
    client: new PteroClient({ panelUrl: config.panelUrl, apiKey: config.apiKey, fetch: fakeFetch }),
    guard: new Guard({ config, audit, confirm, createBackup }),
    config,
    audit: audit as unknown as AuditLog,
  };

  registerFileTools(ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);

  return {
    client,
    requests,
    audit: auditEntries,
    backups,
    close: async () => client.close(),
  };
}

/** First text block of a tool result. `callTool`'s return type is a union, hence the cast. */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  return content[0]!.text;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

describe('phase 3 tool registration', () => {
  it('registers exactly the seven file tools with schemas, descriptions and annotations', async () => {
    const h = await harness(() => listing());
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual([
      'ptero_copy_file',
      'ptero_delete_file',
      'ptero_list_files',
      'ptero_read_file',
      'ptero_rename_file',
      'ptero_upload_file',
      'ptero_write_file',
    ]);

    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect((tool.description ?? '').length, tool.name).toBeGreaterThan(150);
    }

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName['ptero_read_file']!.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName['ptero_list_files']!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName['ptero_write_file']!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName['ptero_rename_file']!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(byName['ptero_upload_file']!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName['ptero_copy_file']!.annotations).toMatchObject({ destructiveHint: false });
    expect(byName['ptero_delete_file']!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });

    await h.close();
  });

  it('tells the model that logs/latest.log is how to get boot-time output', async () => {
    const h = await harness(() => listing());
    const { tools } = await h.client.listTools();
    const read = tools.find((t) => t.name === 'ptero_read_file')!;
    expect(read.description).toContain('logs/latest.log');
    expect(read.description).toMatch(/150/);
    expect(read.description).toMatch(/console/i);
    await h.close();
  });

  it('tells the model that delete is irreversible, capped, gated and previewed for a human', async () => {
    const h = await harness(() => listing());
    const { tools } = await h.client.listTools();
    const del = tools.find((t) => t.name === 'ptero_delete_file')!.description!;
    expect(del).toMatch(/IRREVERSIBLE/i);
    expect(del).toContain('PTERODACTYL_ALLOW_DELETE');
    expect(del).toContain('PTERODACTYL_PROTECTED_PATHS');
    expect(del).toMatch(/10 files/);
    expect(del).toMatch(/FOR THE HUMAN/i);
    await h.close();
  });

  it('tells the model that copies are named by the panel', async () => {
    const h = await harness(() => listing());
    const { tools } = await h.client.listTools();
    expect(tools.find((t) => t.name === 'ptero_copy_file')!.description).toContain('copy.yml');
    await h.close();
  });

  it('tells the model that rename also moves between directories', async () => {
    const h = await harness(() => listing());
    const { tools } = await h.client.listTools();
    expect(tools.find((t) => t.name === 'ptero_rename_file')!.description).toMatch(/MOVE it between directories/i);
    await h.close();
  });

  it('tells the model that overwriting needs confirmation, backs up, and to read first', async () => {
    const h = await harness(() => listing());
    const { tools } = await h.client.listTools();
    const write = tools.find((t) => t.name === 'ptero_write_file')!.description!;
    expect(write).toMatch(/needs_confirmation/);
    expect(write).toMatch(/automatic backup/i);
    expect(write).toContain('ptero_read_file');
    await h.close();
  });
});

/* -------------------------------------------------------------------------- */
/* ptero_list_files                                                           */
/* -------------------------------------------------------------------------- */

describe('ptero_list_files', () => {
  it('returns the documented entry shape, with a joined path, directories first then by name', async () => {
    const h = await harness((req) => {
      if (req.path.endsWith('/files/list')) {
        return listing(
          fileObject({ name: 'zeta.yml', size: 10 }),
          fileObject({ name: 'alpha.yml', size: 20 }),
          fileObject({
            name: 'Geyser-Spigot',
            is_file: false,
            size: 4096,
            mode: 'drwxr-xr-x',
            mimetype: 'inode/directory',
          }),
          fileObject({ name: 'AnotherPlugin', is_file: false, mimetype: 'inode/directory' }),
        );
      }
      return listing();
    });

    const result = await h.client.callTool({
      name: 'ptero_list_files',
      arguments: { directory: 'plugins' },
    });
    expect(result.isError).toBeFalsy();

    expect(h.requests[0]!.query.get('directory')).toBe('/plugins');

    const s = result.structuredContent as {
      server: string;
      directory: string;
      entries: Array<Record<string, unknown>>;
      count: number;
      file_count: number;
      directory_count: number;
    };

    expect(s.server).toBe(SERVER);
    expect(s.directory).toBe('/plugins');
    expect(s.count).toBe(4);
    expect(s.file_count).toBe(2);
    expect(s.directory_count).toBe(2);

    expect(s.entries.map((e) => e['name'])).toEqual([
      'AnotherPlugin',
      'Geyser-Spigot',
      'alpha.yml',
      'zeta.yml',
    ]);

    expect(s.entries[1]).toMatchObject({
      name: 'Geyser-Spigot',
      path: 'plugins/Geyser-Spigot',
      is_file: false,
      is_symlink: false,
      size_bytes: 4096,
      mode: 'drwxr-xr-x',
      mimetype: 'inode/directory',
      modified_at: '2024-01-02T03:04:05+00:00',
    });
    // The `path` is the thing other tools take, so it must be the joined form.
    expect(s.entries[2]).toMatchObject({ name: 'alpha.yml', path: 'plugins/alpha.yml', is_file: true });

    await h.close();
  });

  it('defaults to the server root', async () => {
    const h = await harness(() => listing(fileObject({ name: 'eula.txt' })));
    const result = await h.client.callTool({ name: 'ptero_list_files', arguments: {} });

    expect(h.requests[0]!.query.get('directory')).toBe('/');
    const s = result.structuredContent as { directory: string; entries: Array<Record<string, unknown>> };
    expect(s.directory).toBe('/');
    expect(s.entries[0]!['path']).toBe('eula.txt');

    await h.close();
  });

  it('handles an empty directory without pretending it failed', async () => {
    const h = await harness(() => listing());
    const result = await h.client.callTool({ name: 'ptero_list_files', arguments: { directory: 'logs' } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { count: number }).count).toBe(0);
    expect(textOf(result)).toContain('(empty)');
    await h.close();
  });
});

/* -------------------------------------------------------------------------- */
/* ptero_read_file                                                            */
/* -------------------------------------------------------------------------- */

describe('ptero_read_file', () => {
  const LOG = ['one', 'two', 'three', 'four', 'five'].join('\n') + '\n';

  it('reads a file and applies tail_lines after the fetch', async () => {
    const h = await harness((req) => {
      if (req.path.endsWith('/files/list')) {
        return listing(fileObject({ name: 'latest.log', size: LOG.length }));
      }
      if (req.path.endsWith('/files/contents')) return LOG;
      return listing();
    });

    const result = await h.client.callTool({
      name: 'ptero_read_file',
      arguments: { path: 'logs/latest.log', tail_lines: 2 },
    });
    expect(result.isError).toBeFalsy();

    // Listing the parent directory first is what makes the size guard possible.
    expect(h.requests[0]!.query.get('directory')).toBe('/logs');
    expect(h.requests[1]!.query.get('file')).toBe('/logs/latest.log');

    const s = result.structuredContent as {
      server: string;
      path: string;
      size_bytes: number;
      content: string;
      lines_returned: number;
      truncated_to: string | null;
    };

    expect(s.server).toBe(SERVER);
    expect(s.path).toBe('logs/latest.log');
    expect(s.size_bytes).toBe(LOG.length);
    expect(s.content).toBe('four\nfive');
    expect(s.lines_returned).toBe(2);
    expect(s.truncated_to).toBe('last 2 of 5 lines');

    await h.close();
  });

  it('returns the whole file, and truncated_to null, when no trimming is asked for', async () => {
    const h = await harness((req) =>
      req.path.endsWith('/files/list')
        ? listing(fileObject({ name: 'eula.txt', size: LOG.length }))
        : LOG,
    );

    const result = await h.client.callTool({ name: 'ptero_read_file', arguments: { path: 'eula.txt' } });
    const s = result.structuredContent as { content: string; truncated_to: string | null; lines_returned: number };
    expect(s.content).toBe(LOG);
    expect(s.truncated_to).toBeNull();
    expect(s.lines_returned).toBe(5);
    expect(h.requests[0]!.query.get('directory')).toBe('/');
    await h.close();
  });

  it('applies head_lines, and refuses head_lines together with tail_lines', async () => {
    const h = await harness((req) =>
      req.path.endsWith('/files/list')
        ? listing(fileObject({ name: 'latest.log', size: LOG.length }))
        : LOG,
    );

    const head = await h.client.callTool({
      name: 'ptero_read_file',
      arguments: { path: 'logs/latest.log', head_lines: 2 },
    });
    expect((head.structuredContent as { content: string }).content).toBe('one\ntwo');

    const both = await h.client.callTool({
      name: 'ptero_read_file',
      arguments: { path: 'logs/latest.log', head_lines: 2, tail_lines: 2 },
    });
    expect(both.isError).toBe(true);
    expect(textOf(both)).toMatch(/mutually exclusive/i);

    await h.close();
  });

  it('refuses a file over max_bytes WITHOUT fetching its contents', async () => {
    const h = await harness(
      (req) => {
        if (req.path.endsWith('/files/list')) {
          return listing(fileObject({ name: 'latest.log', size: 50 * 1024 * 1024 }));
        }
        throw new Error('contents must not be fetched');
      },
      { PTERODACTYL_MAX_READ_BYTES: '524288' },
    );

    const result = await h.client.callTool({
      name: 'ptero_read_file',
      arguments: { path: 'logs/latest.log' },
    });

    expect(result.isError).toBe(true);
    // The whole point of the guard: nothing was downloaded.
    expect(h.requests.some((r) => r.path.endsWith('/files/contents'))).toBe(false);
    expect(h.requests).toHaveLength(1);

    const text = textOf(result);
    expect(text).toContain('52428800');           // the actual size, in bytes
    expect(text).toContain('524288');             // the limit, in bytes
    expect(text).toMatch(/will NOT help/);
    expect(text).toMatch(/no range-read endpoint/);
    expect(text).toContain('4194304');            // the hard cap
    expect(text).toContain('ptero_get_file_download_url');
    expect(text).toMatch(/does not exist/);
    expect(text).toMatch(/panel UI/);

    await h.close();
  });

  it('respects an explicit max_bytes above the configured default', async () => {
    const h = await harness(
      (req) =>
        req.path.endsWith('/files/list')
          ? listing(fileObject({ name: 'big.log', size: 900_000 }))
          : 'contents',
      { PTERODACTYL_MAX_READ_BYTES: '1024' },
    );

    const refused = await h.client.callTool({ name: 'ptero_read_file', arguments: { path: 'big.log' } });
    expect(refused.isError).toBe(true);

    const allowed = await h.client.callTool({
      name: 'ptero_read_file',
      arguments: { path: 'big.log', max_bytes: 1_000_000 },
    });
    expect(allowed.isError).toBeFalsy();
    expect((allowed.structuredContent as { content: string }).content).toBe('contents');

    await h.close();
  });

  it('gives an actionable error for a file that is not in the listing', async () => {
    const h = await harness(() => listing(fileObject({ name: 'latest.log' })));

    const result = await h.client.callTool({
      name: 'ptero_read_file',
      arguments: { path: 'logs/nope.log' },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('nope.log');
    expect(text).toContain('/logs');
    expect(text).toContain('ptero_list_files');
    expect(h.requests.some((r) => r.path.endsWith('/files/contents'))).toBe(false);

    await h.close();
  });

  it('says so plainly when the path is a directory', async () => {
    const h = await harness(() => listing(fileObject({ name: 'logs', is_file: false })));

    const result = await h.client.callTool({ name: 'ptero_read_file', arguments: { path: 'logs' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/is a directory/);
    expect(textOf(result)).toContain('ptero_list_files');

    await h.close();
  });

  it('refuses a `..` traversal before it reaches the panel', async () => {
    const h = await harness(() => listing());
    const result = await h.client.callTool({
      name: 'ptero_read_file',
      arguments: { path: '../../etc/passwd' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/\.\./);
    expect(h.requests).toHaveLength(0);
    await h.close();
  });
});

/* -------------------------------------------------------------------------- */
/* ptero_write_file                                                           */
/* -------------------------------------------------------------------------- */

describe('ptero_write_file', () => {
  it('creates a new file without asking for confirmation', async () => {
    const h = await harness((req) => {
      if (req.path.endsWith('/files/list')) return listing(fileObject({ name: 'other.yml' }));
      return undefined; // 204 for the write
    });

    const result = await h.client.callTool({
      name: 'ptero_write_file',
      arguments: { path: 'plugins/new.yml', content: 'hello: world\n' },
    });

    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as Record<string, unknown>;
    expect(s['status']).toBe('success');
    expect(s['action']).toBe('create');
    expect(s['path']).toBe('plugins/new.yml');
    expect(s['bytes_written']).toBe(13);
    expect(s['confirmed_via']).toBe('none');
    expect((s['preview'] as Record<string, unknown>)['exists']).toBe(false);

    const write = h.requests.find((r) => r.path.endsWith('/files/write'))!;
    expect(write.method).toBe('POST');
    expect(write.query.get('file')).toBe('/plugins/new.yml');
    expect(write.body).toBe('hello: world\n');

    await h.close();
  });

  it('requires confirmation to overwrite, then writes and reports the auto-backup', async () => {
    const h = await harness((req) => {
      if (req.path.endsWith('/files/list')) {
        return listing(fileObject({ name: 'config.yml', size: 400 }));
      }
      return undefined;
    });

    const first = await h.client.callTool({
      name: 'ptero_write_file',
      arguments: { path: 'plugins/Geyser-Spigot/config.yml', content: 'bedrock:\n  port: 19132\n' },
    });

    expect(first.isError).toBeFalsy();
    const p = first.structuredContent as Record<string, unknown>;
    expect(p['status']).toBe('needs_confirmation');
    expect(p['expires_in_s']).toBe(120);
    expect(p['preview']).toMatchObject({
      path: 'plugins/Geyser-Spigot/config.yml',
      exists: true,
      current_size_bytes: 400,
      new_size_bytes: 23,
      action: 'overwrite',
    });
    const token = p['confirmation_token'] as string;
    expect(typeof token).toBe('string');

    // Nothing was written on the first call.
    expect(h.requests.some((r) => r.path.endsWith('/files/write'))).toBe(false);
    expect(h.backups).toHaveLength(0);

    const second = await h.client.callTool({
      name: 'ptero_write_file',
      arguments: {
        path: 'plugins/Geyser-Spigot/config.yml',
        content: 'bedrock:\n  port: 19132\n',
        confirmation_token: token,
      },
    });

    expect(second.isError).toBeFalsy();
    const s = second.structuredContent as Record<string, unknown>;
    expect(s['status']).toBe('success');
    expect(s['action']).toBe('overwrite');
    expect(s['confirmed_via']).toBe('token');
    expect(s['backup_id']).toBe('backup-uuid-1');
    expect(h.backups).toHaveLength(1);
    expect(h.backups[0]!.name).toMatch(/^pre-ptero_write_file-/);

    const write = h.requests.find((r) => r.path.endsWith('/files/write'))!;
    expect(write.body).toBe('bedrock:\n  port: 19132\n');
    expect(textOf(second)).toContain('backup-uuid-1');

    await h.close();
  });

  it('changes nothing on dry_run', async () => {
    const h = await harness((req) =>
      req.path.endsWith('/files/list') ? listing(fileObject({ name: 'config.yml', size: 400 })) : undefined,
    );

    const result = await h.client.callTool({
      name: 'ptero_write_file',
      arguments: { path: 'plugins/config.yml', content: 'x: 1\n', dry_run: true },
    });

    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as Record<string, unknown>;
    expect(s['status']).toBe('dry_run');
    expect(s['preview']).toMatchObject({ action: 'overwrite', exists: true, new_size_bytes: 5 });
    expect(s['confirmation_token']).toBeUndefined();

    expect(h.requests.some((r) => r.path.endsWith('/files/write'))).toBe(false);
    expect(h.backups).toHaveLength(0);
    expect(textOf(result)).toMatch(/DRY RUN/);

    await h.close();
  });

  it('never puts file content in the audit log — only its sha256 and length', async () => {
    const SECRET = 'rcon.password=hunter2\nmotd=A Minecraft Server\n';
    const h = await harness((req) =>
      req.path.endsWith('/files/list') ? listing(fileObject({ name: 'other.txt' })) : undefined,
    );

    const result = await h.client.callTool({
      name: 'ptero_write_file',
      arguments: { path: 'plugins/secret.properties', content: SECRET },
    });
    expect(result.isError).toBeFalsy();

    const sha = (result.structuredContent as Record<string, unknown>)['content_sha256'] as string;
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(sha).toBe(createHash('sha256').update(SECRET, 'utf8').digest('hex'));

    const serialised = JSON.stringify(h.audit);
    expect(h.audit.length).toBeGreaterThan(0);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain(SECRET);
    expect(serialised).toContain(sha);

    for (const entry of h.audit) {
      const args = entry['args'] as Record<string, unknown>;
      expect(args).not.toHaveProperty('content');
      expect(args['content_sha256']).toBe(sha);
      expect(args['content_length']).toBe(Buffer.byteLength(SECRET, 'utf8'));
    }

    await h.close();
  });

  it('refuses a write to a protected path and never calls the panel write endpoint', async () => {
    const h = await harness((req) =>
      req.path.endsWith('/files/list') ? listing(fileObject({ name: 'server.properties', size: 900 })) : undefined,
    );

    const result = await h.client.callTool({
      name: 'ptero_write_file',
      arguments: { path: 'server.properties', content: 'motd=nope\n' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('PTERODACTYL_PROTECTED_PATHS');
    expect(h.requests.some((r) => r.path.endsWith('/files/write'))).toBe(false);

    await h.close();
  });
});

/* -------------------------------------------------------------------------- */
/* ptero_upload_file                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The upload flow is two hops: `GET /files/upload` at the panel for a single-use signed
 * URL, then a multipart POST straight to the Wings node named by that URL. The field name
 * (`files`), the part's filename and the `directory` query parameter are the contract
 * `postServerUploadFiles` (wings, `router/router_server_files.go`) actually reads, so the
 * tests below decode the real multipart body rather than trusting the FormData object.
 */
const SIGNED_UPLOAD_URL = 'https://node.example.com:8080/upload/file?token=mock.upload.jwt';

const LOCAL_DIR = mkdtempSync(join(tmpdir(), 'ptero-upload-test-'));
/** Bytes that are NOT valid UTF-8 — the whole reason this tool exists alongside write_file. */
const JAR_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80, 0x41]);
const LOCAL_JAR = join(LOCAL_DIR, 'MyPlugin-1.2.0.jar');
writeFileSync(LOCAL_JAR, JAR_BYTES);
const JAR_SHA256 = createHash('sha256').update(JAR_BYTES).digest('hex');

/** A file over the 64 MiB cap, made sparse so the test stays instant. */
const LOCAL_HUGE = join(LOCAL_DIR, 'huge.zip');
writeFileSync(LOCAL_HUGE, '');
truncateSync(LOCAL_HUGE, 64 * 1024 * 1024 + 1);

/** Answers both hops. `remote` is what `/files/list` reports for the destination dir. */
function uploadResponder(remote: ReturnType<typeof fileObject>[] = []) {
  return (req: Recorded) => {
    if (req.path.endsWith('/files/list')) return listing(...remote);
    if (req.path.endsWith('/files/upload')) {
      return { object: 'signed_url', attributes: { url: SIGNED_UPLOAD_URL } };
    }
    if (req.url.startsWith('https://node.example.com')) return new Response(null, { status: 200 });
    return undefined;
  };
}

/** Decode a recorded multipart request back into its parts, exactly as Wings would. */
async function decodeMultipart(record: Recorded): Promise<{
  contentType: string;
  raw: string;
  parts: Array<{ name: string; filename: string | undefined; bytes: Buffer }>;
}> {
  const request = new Request(record.url, record.init as RequestInit);
  const contentType = request.headers.get('content-type') ?? '';
  const raw = Buffer.from(await request.arrayBuffer()).toString('latin1');

  const form = await new Request(record.url, record.init as RequestInit).formData();
  const parts: Array<{ name: string; filename: string | undefined; bytes: Buffer }> = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      parts.push({ name, filename: undefined, bytes: Buffer.from(value, 'utf8') });
    } else {
      parts.push({
        name,
        filename: value.name,
        bytes: Buffer.from(new Uint8Array(await value.arrayBuffer())),
      });
    }
  }
  return { contentType, raw, parts };
}

describe('ptero_upload_file', () => {
  it('asks the panel for a signed URL, then POSTs the bytes to the node as multipart/form-data', async () => {
    const h = await harness(uploadResponder([fileObject({ name: 'other.jar' })]));

    const result = await h.client.callTool({
      name: 'ptero_upload_file',
      arguments: { local_path: LOCAL_JAR, remote_dir: 'plugins' },
    });

    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as Record<string, unknown>;
    expect(s['status']).toBe('success');
    expect(s['action']).toBe('create');
    expect(s['path']).toBe('plugins/MyPlugin-1.2.0.jar');
    expect(s['bytes']).toBe(JAR_BYTES.length);
    expect(s['sha256']).toBe(JAR_SHA256);
    expect(s['confirmed_via']).toBe('none');

    // Step 1: the panel, with the API key, and no `directory` (the panel never reads one).
    const signed = h.requests.find((r) => r.path.endsWith('/files/upload'))!;
    expect(signed.method).toBe('GET');
    expect(signed.url.startsWith(PANEL)).toBe(true);
    expect(signed.query.get('directory')).toBeNull();

    // Step 2: the node, at the signed URL, with `directory` appended and the token intact.
    const post = h.requests.find((r) => r.url.startsWith('https://node.example.com'))!;
    expect(post.method).toBe('POST');
    expect(new URL(post.url).pathname).toBe('/upload/file');
    expect(post.query.get('token')).toBe('mock.upload.jwt');
    expect(post.query.get('directory')).toBe('/plugins');
    // The panel key must never be handed to the node.
    expect(new Headers((post.init as RequestInit).headers ?? {}).get('authorization')).toBeNull();

    const { contentType, raw, parts } = await decodeMultipart(post);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(raw).toContain('name="files"');
    expect(raw).toContain('filename="MyPlugin-1.2.0.jar"');
    expect(parts).toHaveLength(1);
    expect(parts[0]!.name).toBe('files');
    expect(parts[0]!.filename).toBe('MyPlugin-1.2.0.jar');
    // Byte-for-byte, including the bytes that are not valid UTF-8.
    expect(parts[0]!.bytes.equals(JAR_BYTES)).toBe(true);

    // Ordering: the signed URL is single-use, so it is minted per upload, after the guard.
    expect(h.requests.indexOf(signed)).toBeLessThan(h.requests.indexOf(post));

    expect(textOf(result)).toContain('ptero_list_files');
    await h.close();
  });

  it('honours remote_name and defaults remote_dir to the server root', async () => {
    const h = await harness(uploadResponder());

    const result = await h.client.callTool({
      name: 'ptero_upload_file',
      arguments: { local_path: LOCAL_JAR, remote_name: 'renamed.jar' },
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Record<string, unknown>)['path']).toBe('renamed.jar');

    const post = h.requests.find((r) => r.url.startsWith('https://node.example.com'))!;
    expect(post.query.get('directory')).toBe('/');
    const { parts } = await decodeMultipart(post);
    expect(parts[0]!.filename).toBe('renamed.jar');

    await h.close();
  });

  it('refuses a file over 64 MiB without reading it or contacting the panel', async () => {
    const h = await harness(uploadResponder());

    const result = await h.client.callTool({
      name: 'ptero_upload_file',
      arguments: { local_path: LOCAL_HUGE, remote_dir: 'plugins' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/64 MiB|67108864/);
    expect(textOf(result)).toContain('Nothing was read and nothing was sent');
    expect(h.requests).toHaveLength(0);
    expect(h.audit).toHaveLength(0);

    await h.close();
  });

  it('refuses a relative path, a missing file, a directory and a remote_name with a separator', async () => {
    const h = await harness(uploadResponder());

    const relative = await h.client.callTool({
      name: 'ptero_upload_file',
      arguments: { local_path: 'MyPlugin-1.2.0.jar' },
    });
    expect(relative.isError).toBe(true);
    expect(textOf(relative)).toContain('absolute path');

    const missing = await h.client.callTool({
      name: 'ptero_upload_file',
      arguments: { local_path: join(LOCAL_DIR, 'does-not-exist.jar') },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('Cannot read');

    const directory = await h.client.callTool({
      name: 'ptero_upload_file',
      arguments: { local_path: LOCAL_DIR },
    });
    expect(directory.isError).toBe(true);
    expect(textOf(directory)).toContain('not a regular file');

    const nested = await h.client.callTool({
      name: 'ptero_upload_file',
      arguments: { local_path: LOCAL_JAR, remote_dir: 'plugins', remote_name: 'sub/dir.jar' },
    });
    expect(nested.isError).toBe(true);
    expect(textOf(nested)).toContain('single file name');

    // None of these reached the panel, let alone the node.
    expect(h.requests).toHaveLength(0);

    await h.close();
  });

  it('changes nothing on dry_run', async () => {
    const h = await harness(uploadResponder([fileObject({ name: 'MyPlugin-1.2.0.jar', size: 4096 })]));

    const result = await h.client.callTool({
      name: 'ptero_upload_file',
      arguments: { local_path: LOCAL_JAR, remote_dir: 'plugins', dry_run: true },
    });

    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as Record<string, unknown>;
    expect(s['status']).toBe('dry_run');
    expect(s['preview']).toMatchObject({
      path: 'plugins/MyPlugin-1.2.0.jar',
      exists: true,
      current_size_bytes: 4096,
      new_size_bytes: JAR_BYTES.length,
      action: 'overwrite',
      sha256: JAR_SHA256,
    });
    expect(s['confirmation_token']).toBeUndefined();

    expect(h.requests.some((r) => r.path.endsWith('/files/upload'))).toBe(false);
    expect(h.requests.some((r) => r.url.startsWith('https://node.example.com'))).toBe(false);
    expect(h.backups).toHaveLength(0);

    await h.close();
  });

  it('requires confirmation to overwrite an existing remote file, then uploads with an auto-backup', async () => {
    const h = await harness(uploadResponder([fileObject({ name: 'MyPlugin-1.2.0.jar', size: 4096 })]));

    const first = await h.client.callTool({
      name: 'ptero_upload_file',
      arguments: { local_path: LOCAL_JAR, remote_dir: 'plugins' },
    });

    const p = first.structuredContent as Record<string, unknown>;
    expect(p['status']).toBe('needs_confirmation');
    expect(p['expires_in_s']).toBe(120);
    expect(p['preview']).toMatchObject({ action: 'overwrite', exists: true, current_size_bytes: 4096 });
    const token = p['confirmation_token'] as string;

    // Nothing was uploaded and no backup was taken on the first call.
    expect(h.requests.some((r) => r.url.startsWith('https://node.example.com'))).toBe(false);
    expect(h.backups).toHaveLength(0);

    const second = await h.client.callTool({
      name: 'ptero_upload_file',
      arguments: { local_path: LOCAL_JAR, remote_dir: 'plugins', confirmation_token: token },
    });

    expect(second.isError).toBeFalsy();
    const s = second.structuredContent as Record<string, unknown>;
    expect(s['status']).toBe('success');
    expect(s['action']).toBe('overwrite');
    expect(s['confirmed_via']).toBe('token');
    expect(s['backup_id']).toBe('backup-uuid-1');
    expect(h.backups).toHaveLength(1);
    expect(h.backups[0]!.name).toMatch(/^pre-ptero_upload_file-/);

    const post = h.requests.find((r) => r.url.startsWith('https://node.example.com'))!;
    const { parts } = await decodeMultipart(post);
    expect(parts[0]!.bytes.equals(JAR_BYTES)).toBe(true);

    await h.close();
  });

  it('refuses an upload into a protected path and never asks for a signed URL', async () => {
    const h = await harness(uploadResponder());

    const result = await h.client.callTool({
      name: 'ptero_upload_file',
      arguments: { local_path: LOCAL_JAR, remote_dir: 'world', remote_name: 'level.dat' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('PTERODACTYL_PROTECTED_PATHS');
    expect(h.requests.some((r) => r.path.endsWith('/files/upload'))).toBe(false);
    expect(h.requests.some((r) => r.url.startsWith('https://node.example.com'))).toBe(false);

    await h.close();
  });

  it('audits the sha256 and length but never the bytes or the signed URL', async () => {
    const h = await harness(uploadResponder([fileObject({ name: 'other.jar' })]));

    const result = await h.client.callTool({
      name: 'ptero_upload_file',
      arguments: { local_path: LOCAL_JAR, remote_dir: 'plugins' },
    });
    expect(result.isError).toBeFalsy();

    const serialised = JSON.stringify(h.audit);
    expect(h.audit.length).toBeGreaterThan(0);
    expect(serialised).toContain(JAR_SHA256);
    expect(serialised).not.toContain('mock.upload.jwt');
    expect(serialised).not.toContain(JAR_BYTES.toString('base64'));
    for (const entry of h.audit) {
      const args = entry['args'] as Record<string, unknown>;
      expect(args).not.toHaveProperty('content');
      expect(args).not.toHaveProperty('bytes');
      expect(args['content_sha256']).toBe(JAR_SHA256);
      expect(args['content_length']).toBe(JAR_BYTES.length);
    }

    await h.close();
  });

  it('treats an unlistable destination directory as a possible overwrite', async () => {
    const h = await harness((req) => {
      if (req.path.endsWith('/files/list')) {
        return new Response(
          JSON.stringify({ errors: [{ code: 'DaemonConnectionException', detail: 'no such directory' }] }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }
      if (req.path.endsWith('/files/upload')) {
        return { object: 'signed_url', attributes: { url: SIGNED_UPLOAD_URL } };
      }
      return new Response(null, { status: 200 });
    });

    const result = await h.client.callTool({
      name: 'ptero_upload_file',
      arguments: { local_path: LOCAL_JAR, remote_dir: 'new-folder' },
    });

    const s = result.structuredContent as Record<string, unknown>;
    expect(s['status']).toBe('needs_confirmation');
    expect(s['preview']).toMatchObject({ action: 'unknown', exists: false });
    expect((s['preview'] as Record<string, unknown>)['parent_listing_failed']).toBeTruthy();

    await h.close();
  });
});

/* -------------------------------------------------------------------------- */
/* ptero_rename_file / ptero_copy_file                                        */
/* -------------------------------------------------------------------------- */

describe('ptero_rename_file', () => {
  it('renames without confirmation and sends root + a single from/to pair', async () => {
    const h = await harness(() => undefined);

    const result = await h.client.callTool({
      name: 'ptero_rename_file',
      arguments: { root: '/', from: 'plugins/old.jar', to: 'plugins/disabled/old.jar' },
    });

    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as Record<string, unknown>;
    expect(s['status']).toBe('success');
    expect(s['from_path']).toBe('plugins/old.jar');
    expect(s['to_path']).toBe('plugins/disabled/old.jar');
    expect(s['backup_id']).toBeUndefined();

    const req = h.requests.find((r) => r.path.endsWith('/files/rename'))!;
    expect(req.method).toBe('PUT');
    expect(JSON.parse(req.body!)).toEqual({
      root: '/',
      files: [{ from: 'plugins/old.jar', to: 'plugins/disabled/old.jar' }],
    });

    await h.close();
  });

  it('checks the destination against protected paths too', async () => {
    const h = await harness(() => undefined);

    const result = await h.client.callTool({
      name: 'ptero_rename_file',
      arguments: { root: '/', from: 'backup.dat', to: 'world/level.dat' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('PTERODACTYL_PROTECTED_PATHS');
    expect(h.requests).toHaveLength(0);

    await h.close();
  });
});

describe('ptero_copy_file', () => {
  it('copies without confirmation and warns that the panel names the copy', async () => {
    const h = await harness(() => undefined);

    const result = await h.client.callTool({
      name: 'ptero_copy_file',
      arguments: { path: 'plugins/Geyser-Spigot/config.yml' },
    });

    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as Record<string, unknown>;
    expect(s['status']).toBe('success');
    expect(s['path']).toBe('plugins/Geyser-Spigot/config.yml');
    expect(s['backup_id']).toBeUndefined();
    expect(textOf(result)).toMatch(/copy\.txt/);

    const req = h.requests.find((r) => r.path.endsWith('/files/copy'))!;
    expect(req.method).toBe('POST');
    expect(JSON.parse(req.body!)).toEqual({ location: '/plugins/Geyser-Spigot/config.yml' });

    await h.close();
  });
});

/* -------------------------------------------------------------------------- */
/* ptero_delete_file                                                          */
/* -------------------------------------------------------------------------- */

describe('ptero_delete_file', () => {
  const ALLOW = { PTERODACTYL_ALLOW_DELETE: 'true' };

  it('refuses a protected path, names the variable, and never calls the panel', async () => {
    const h = await harness(() => undefined, ALLOW);

    const result = await h.client.callTool({
      name: 'ptero_delete_file',
      arguments: { root: '/', files: ['world/level.dat'] },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('PTERODACTYL_PROTECTED_PATHS');
    expect(text).toContain('world/level.dat');
    expect(h.requests.some((r) => r.path.endsWith('/files/delete'))).toBe(false);
    expect(h.requests).toHaveLength(0);

    await h.close();
  });

  it('refuses when PTERODACTYL_ALLOW_DELETE is false', async () => {
    const h = await harness(() => undefined, { PTERODACTYL_ALLOW_DELETE: 'false' });

    const result = await h.client.callTool({
      name: 'ptero_delete_file',
      arguments: { root: '/plugins', files: ['foo.jar'] },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('PTERODACTYL_ALLOW_DELETE');
    expect(h.requests).toHaveLength(0);

    await h.close();
  });

  it('refuses a bulk delete of more than 10 files', async () => {
    const h = await harness(() => undefined, ALLOW);

    const files = Array.from({ length: 11 }, (_, i) => `plugin-${i}.jar`);
    const result = await h.client.callTool({
      name: 'ptero_delete_file',
      arguments: { root: '/plugins', files },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/11 files/);
    expect(text).toMatch(/10/);
    expect(h.requests).toHaveLength(0);

    await h.close();
  });

  it('previews first, then deletes with the token, sending root and bare file names', async () => {
    const h = await harness(() => undefined, ALLOW);

    const args = { root: '/plugins', files: ['foo.jar'] };

    const first = await h.client.callTool({ name: 'ptero_delete_file', arguments: args });
    expect(first.isError).toBeFalsy();
    const p = first.structuredContent as Record<string, unknown>;
    expect(p['status']).toBe('needs_confirmation');
    expect(p['preview']).toEqual({ root: '/plugins', files: ['foo.jar'], count: 1 });
    expect(p['expires_in_s']).toBe(120);
    const token = p['confirmation_token'] as string;
    expect(typeof token).toBe('string');
    expect(h.requests).toHaveLength(0);
    expect(h.backups).toHaveLength(0);
    // The message must tell the model the preview belongs to the human.
    expect(p['message']).toMatch(/human/i);

    const second = await h.client.callTool({
      name: 'ptero_delete_file',
      arguments: { ...args, confirmation_token: token },
    });

    expect(second.isError).toBeFalsy();
    const s = second.structuredContent as Record<string, unknown>;
    expect(s['status']).toBe('success');
    expect(s['confirmed_via']).toBe('token');
    expect(s['backup_id']).toBe('backup-uuid-1');
    expect(s['deleted_count']).toBe(1);
    expect(h.backups).toHaveLength(1);

    const req = h.requests.find((r) => r.path.endsWith('/files/delete'))!;
    expect(req.method).toBe('POST');
    expect(JSON.parse(req.body!)).toEqual({ root: '/plugins', files: ['foo.jar'] });

    await h.close();
  });

  it('rejects a token replayed with different arguments', async () => {
    const h = await harness(() => undefined, ALLOW);

    const first = await h.client.callTool({
      name: 'ptero_delete_file',
      arguments: { root: '/plugins', files: ['foo.jar'] },
    });
    const token = (first.structuredContent as Record<string, unknown>)['confirmation_token'] as string;

    const swapped = await h.client.callTool({
      name: 'ptero_delete_file',
      arguments: { root: '/plugins', files: ['bar.jar'], confirmation_token: token },
    });

    expect(swapped.isError).toBe(true);
    expect(textOf(swapped)).toMatch(/arguments differ from preview/);
    expect(h.requests).toHaveLength(0);

    await h.close();
  });

  it('changes nothing on dry_run', async () => {
    const h = await harness(() => undefined, ALLOW);

    const result = await h.client.callTool({
      name: 'ptero_delete_file',
      arguments: { root: '/plugins', files: ['foo.jar'], dry_run: true },
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Record<string, unknown>)['status']).toBe('dry_run');
    expect(h.requests).toHaveLength(0);
    expect(h.backups).toHaveLength(0);

    await h.close();
  });
});
