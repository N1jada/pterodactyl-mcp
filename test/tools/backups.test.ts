import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuditLog, type AuditEntry } from '../../src/audit.js';
import { PteroClient } from '../../src/client.js';
import { loadConfig } from '../../src/config.js';
import { Confirmation, type ElicitCapableServer } from '../../src/confirm.js';
import { Guard, type ConfirmationLike } from '../../src/guard.js';
import { registerBackupTools } from '../../src/tools/backups.js';
import type { ToolContext } from '../../src/tools/_shared.js';

const PANEL = 'https://panel.example.com';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function backupAttributes(over: Record<string, unknown> = {}) {
  return {
    uuid: 'bk-1111',
    is_successful: true,
    is_locked: false,
    name: 'pre-change',
    ignored_files: [],
    checksum: 'sha1:abc123',
    bytes: 1_048_576,
    created_at: '2024-01-01T00:00:00+00:00',
    completed_at: '2024-01-01T00:00:05+00:00',
    ...over,
  };
}

function backupItem(over: Record<string, unknown> = {}) {
  return { object: 'backup', attributes: backupAttributes(over) };
}

/* -------------------------------------------------------------------------- */
/* Harness — real McpServer/Client/InMemoryTransport, real PteroClient with a  */
/* fake fetch, real Guard wired the way test/guard.test.ts does (a real       */
/* Confirmation behind a stub ElicitCapableServer, so the token flow runs     */
/* end to end without any real elicitation).                                 */
/* -------------------------------------------------------------------------- */

/** Captures audit entries in memory instead of touching disk. */
class RecordingAuditLog extends AuditLog {
  entries: AuditEntry[] = [];
  override async append(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

type Responder = (method: string, url: string) => unknown;

async function harness(respond: Responder, env: Record<string, string> = {}) {
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = respond(method, url);
    if (body instanceof Response) return body;
    if (body === undefined) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const config = loadConfig({
    PTERODACTYL_PANEL_URL: PANEL,
    PTERODACTYL_API_KEY: 'ptlc_test',
    PTERODACTYL_DEFAULT_SERVER: '1a2b3c4d',
    PTERODACTYL_ALLOW_DELETE: 'true',
    ...env,
  });

  const mcp = new McpServer({ name: 'pterodactyl-mcp-test', version: '0.0.0' });
  const pteroClient = new PteroClient({ panelUrl: config.panelUrl, apiKey: config.apiKey, fetch: fakeFetch });
  const audit = new RecordingAuditLog('/dev/null');

  // No elicitation capability declared -> Guard falls back to the two-phase token flow.
  const stub: ElicitCapableServer = {
    server: {
      getClientCapabilities: () => ({}),
      elicitInput: async () => ({ action: 'cancel' }),
    },
  };
  const real = new Confirmation({ server: stub });
  const confirm: ConfirmationLike = {
    clientSupportsElicitation: () => real.clientSupportsElicitation(),
    elicit: (preview, extra) => real.elicit(preview, extra),
    mint: (hash) => real.mint(hash),
    consume: (token, hash) => real.consume(token, hash),
  };

  const guard = new Guard({
    config,
    audit,
    confirm,
    createBackup: async () => {
      throw new Error('unexpected auto-backup: backup tools must not trigger Layer 3');
    },
  });

  const ctx: ToolContext = { server: mcp, client: pteroClient, guard, config, audit };
  registerBackupTools(ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);

  return { client, audit, close: async () => client.close() };
}

/* -------------------------------------------------------------------------- */
/* ptero_list_backups                                                         */
/* -------------------------------------------------------------------------- */

describe('ptero_list_backups', () => {
  it('returns backup rows plus backup_count from meta', async () => {
    const h = await harness((_method, url) => {
      expect(url).toContain('/servers/1a2b3c4d/backups');
      return {
        object: 'list',
        data: [backupItem(), backupItem({ uuid: 'bk-2222', is_successful: false, completed_at: null })],
        meta: { backup_count: 2 },
      };
    });

    const result = await h.client.callTool({ name: 'ptero_list_backups', arguments: {} });
    expect(result.isError).toBeFalsy();

    const s = result.structuredContent as Record<string, unknown>;
    expect(s['server']).toBe('1a2b3c4d');
    expect(s['count']).toBe(2);
    expect(s['backup_count']).toBe(2);

    const backups = s['backups'] as Array<Record<string, unknown>>;
    expect(backups[0]).toMatchObject({
      uuid: 'bk-1111',
      name: 'pre-change',
      bytes: 1_048_576,
      bytes_human: '1.00 MiB',
      is_successful: true,
      is_locked: false,
      checksum: 'sha1:abc123',
    });
    expect(backups[1]).toMatchObject({ uuid: 'bk-2222', is_successful: false, completed_at: null });

    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('bk-1111');
    expect(text).toContain('in progress');

    await h.close();
  });
});

/* -------------------------------------------------------------------------- */
/* ptero_create_backup                                                        */
/* -------------------------------------------------------------------------- */

describe('ptero_create_backup', () => {
  it('waits for completion by default and returns completed_at / is_successful', async () => {
    const h = await harness((method, url) => {
      if (method === 'POST' && url.endsWith('/servers/1a2b3c4d/backups')) {
        // Already complete on creation -> createBackupAndWait resolves without polling.
        return backupItem({ uuid: 'bk-new', bytes: 2048, completed_at: '2024-01-01T00:00:00+00:00', is_successful: true });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const result = await h.client.callTool({ name: 'ptero_create_backup', arguments: {} });
    expect(result.isError).toBeFalsy();

    const s = result.structuredContent as Record<string, unknown>;
    expect(s['status']).toBe('success');
    expect(s['uuid']).toBe('bk-new');
    expect(s['completed']).toBe(true);
    expect(s['completed_at']).toBe('2024-01-01T00:00:00+00:00');
    expect(s['is_successful']).toBe(true);
    expect(s['bytes_human']).toBe('2.00 KiB');

    await h.close();
  });

  it('with wait:false returns immediately with just the uuid and completed:false', async () => {
    const h = await harness((method, url) => {
      if (method === 'POST' && url.endsWith('/servers/1a2b3c4d/backups')) {
        return backupItem({ uuid: 'bk-async', completed_at: null, is_successful: false });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const result = await h.client.callTool({
      name: 'ptero_create_backup',
      arguments: { wait: false },
    });
    expect(result.isError).toBeFalsy();

    const s = result.structuredContent as Record<string, unknown>;
    expect(s['status']).toBe('success');
    expect(s['uuid']).toBe('bk-async');
    expect(s['completed']).toBe(false);
    expect(s['completed_at']).toBeNull();

    await h.close();
  });

  it('maps a full backup-limit 400 to an actionable error naming ptero_delete_backup', async () => {
    const h = await harness((method, url) => {
      if (method === 'POST' && url.endsWith('/servers/1a2b3c4d/backups')) {
        return new Response(
          JSON.stringify({
            errors: [{ code: 'DisplayException', status: '400', detail: 'Cannot create backup, backup limit reached.' }],
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const result = await h.client.callTool({ name: 'ptero_create_backup', arguments: {} });
    expect(result.isError).toBe(true);

    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text.toLowerCase()).toContain('limit');
    expect(text).toContain('ptero_delete_backup');

    await h.close();
  });

  it('supports dry_run without calling the panel', async () => {
    const h = await harness((method, url) => {
      throw new Error(`unexpected call in dry_run: ${method} ${url}`);
    });

    const result = await h.client.callTool({
      name: 'ptero_create_backup',
      arguments: { dry_run: true, name: 'test' },
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Record<string, unknown>)['status']).toBe('dry_run');

    await h.close();
  });
});

/* -------------------------------------------------------------------------- */
/* ptero_delete_backup                                                        */
/* -------------------------------------------------------------------------- */

describe('ptero_delete_backup', () => {
  it('returns needs_confirmation, then deletes once the token is supplied', async () => {
    let deleted = false;
    const h = await harness((method, url) => {
      if (method === 'GET' && url.includes('/backups/bk-1111') && !url.endsWith('/download')) {
        return backupItem({ uuid: 'bk-1111', is_locked: false });
      }
      if (method === 'DELETE' && url.endsWith('/backups/bk-1111')) {
        deleted = true;
        return undefined; // 204
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const first = await h.client.callTool({
      name: 'ptero_delete_backup',
      arguments: { backup_uuid: 'bk-1111' },
    });
    expect(first.isError).toBeFalsy();
    const firstStructured = first.structuredContent as Record<string, unknown>;
    expect(firstStructured['status']).toBe('needs_confirmation');
    const token = firstStructured['confirmation_token'] as string;
    expect(token).toBeTruthy();
    expect(deleted).toBe(false);

    const second = await h.client.callTool({
      name: 'ptero_delete_backup',
      arguments: { backup_uuid: 'bk-1111', confirmation_token: token },
    });
    expect(second.isError).toBeFalsy();
    expect((second.structuredContent as Record<string, unknown>)['status']).toBe('success');
    expect(deleted).toBe(true);

    // needs_confirmation, attempted and success/commit lines should all have been audited.
    expect(h.audit.entries.length).toBeGreaterThanOrEqual(3);

    await h.close();
  });

  it('refuses a locked backup without ever consulting the guard (no audit line)', async () => {
    const h = await harness((method, url) => {
      if (method === 'GET' && url.includes('/backups/bk-locked')) {
        return backupItem({ uuid: 'bk-locked', is_locked: true });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });

    const result = await h.client.callTool({
      name: 'ptero_delete_backup',
      arguments: { backup_uuid: 'bk-locked' },
    });
    expect(result.isError).toBe(true);

    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text.toLowerCase()).toContain('locked');
    expect(text).toContain('ptero_delete_backup');

    expect(h.audit.entries).toHaveLength(0);

    await h.close();
  });

  it('is refused naming PTERODACTYL_ALLOW_DELETE when deletion is disabled', async () => {
    const h = await harness(
      (method, url) => {
        if (method === 'GET' && url.includes('/backups/bk-1111')) {
          return backupItem({ uuid: 'bk-1111', is_locked: false });
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
      { PTERODACTYL_ALLOW_DELETE: 'false' },
    );

    const result = await h.client.callTool({
      name: 'ptero_delete_backup',
      arguments: { backup_uuid: 'bk-1111' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('PTERODACTYL_ALLOW_DELETE');

    await h.close();
  });
});

/* -------------------------------------------------------------------------- */
/* ptero_get_backup_download_url                                             */
/* -------------------------------------------------------------------------- */

describe('ptero_get_backup_download_url', () => {
  it('returns the signed url, uuid, and a do-not-store note', async () => {
    const h = await harness((method, url) => {
      expect(method).toBe('GET');
      expect(url).toContain('/backups/bk-1111/download');
      return { object: 'signed_url', attributes: { url: 'https://cdn.example.com/signed?token=abc' } };
    });

    const result = await h.client.callTool({
      name: 'ptero_get_backup_download_url',
      arguments: { backup_uuid: 'bk-1111' },
    });
    expect(result.isError).toBeFalsy();

    const s = result.structuredContent as Record<string, unknown>;
    expect(s['uuid']).toBe('bk-1111');
    expect(s['url']).toBe('https://cdn.example.com/signed?token=abc');
    expect(s['note']).toMatch(/short-lived/i);

    await h.close();
  });
});
