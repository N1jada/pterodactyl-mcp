import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuditLog, type AuditEntry } from '../src/audit.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ptero-audit-'));
}

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: new Date('2026-01-01T12:00:00.000Z').toISOString(),
    tool: 'ptero_delete_file',
    server: '1a2b3c4d',
    args: { path: 'logs/old.log' },
    outcome: 'success',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuditLog.append', () => {
  it('creates the parent directory and writes one JSON line per entry', async () => {
    const dir = await tempDir();
    const path = join(dir, 'nested', 'deeper', 'audit.jsonl');
    const log = new AuditLog(path);

    await log.append(entry({ outcome: 'attempted' }));
    await log.append(entry({ outcome: 'success', backup_id: 'backup-uuid-1' }));

    const contents = await readFile(path, 'utf8');
    expect(contents.endsWith('\n')).toBe(true);

    const lines = contents.trimEnd().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    expect(first.tool).toBe('ptero_delete_file');
    expect(first.server).toBe('1a2b3c4d');
    expect(first.outcome).toBe('attempted');
    expect(first.args).toEqual({ path: 'logs/old.log' });

    const second = JSON.parse(lines[1]!);
    expect(second.outcome).toBe('success');
    expect(second.backup_id).toBe('backup-uuid-1');
  });

  it('appends rather than truncating across separate AuditLog instances', async () => {
    const dir = await tempDir();
    const path = join(dir, 'audit.jsonl');

    await new AuditLog(path).append(entry({ outcome: 'refused', reason: 'read-only mode' }));
    await new AuditLog(path).append(entry({ outcome: 'dry_run' }));

    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).reason).toBe('read-only mode');
  });

  it('records every outcome kind the guard can produce', async () => {
    const dir = await tempDir();
    const path = join(dir, 'audit.jsonl');
    const log = new AuditLog(path);

    const outcomes: AuditEntry['outcome'][] = [
      'attempted',
      'refused',
      'dry_run',
      'needs_confirmation',
      'declined',
      'success',
      'error',
    ];
    for (const outcome of outcomes) {
      await log.append(entry({ outcome }));
    }

    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
    expect(lines.map((l) => JSON.parse(l).outcome)).toEqual(outcomes);
  });

  it('never throws when the write fails, but reports it on stderr', async () => {
    const dir = await tempDir();
    // Occupy the parent path with a file so mkdir -p of `<file>/audit.jsonl` must fail.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');

    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = new AuditLog(join(blocker, 'audit.jsonl'));

    await expect(log.append(entry())).resolves.toBeUndefined();

    expect(stderr).toHaveBeenCalledOnce();
    const message = String(stderr.mock.calls[0]![0]);
    expect(message).toContain('AUDIT WRITE FAILED');
    expect(message).toContain('ptero_delete_file');
  });

  it('redacts secrets on the way to disk, not just in the helper', async () => {
    const dir = await tempDir();
    const path = join(dir, 'audit.jsonl');

    await new AuditLog(path).append(
      entry({
        args: {
          path: 'server.properties',
          confirmation_token: 'zzz-secret-token',
          download_url: 'https://node/download?token=leak',
        },
      }),
    );

    const contents = await readFile(path, 'utf8');
    expect(contents).not.toContain('zzz-secret-token');
    expect(contents).not.toContain('token=leak');

    const parsed = JSON.parse(contents.trim());
    expect(parsed.args.confirmation_token).toBe('[REDACTED]');
    expect(parsed.args.download_url).toBe('[REDACTED]');
    expect(parsed.args.path).toBe('server.properties');
  });

  it('creates the directory only once across many appends', async () => {
    const dir = await tempDir();
    const path = join(dir, 'sub', 'audit.jsonl');
    await mkdir(join(dir, 'sub'), { recursive: true });

    const log = new AuditLog(path);
    for (let i = 0; i < 5; i += 1) {
      await log.append(entry({ args: { i } }));
    }

    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(5);
  });
});

describe('AuditLog.redact', () => {
  it('redacts top-level keys matching the secret pattern', () => {
    const out = AuditLog.redact({
      apiKey: 'ptlc_secret',
      token: 'jwt',
      Secret: 's',
      PASSWORD: 'p',
      jwt: 'j',
      url: 'https://node/download?token=abc',
      path: 'server.properties',
      count: 3,
    }) as Record<string, unknown>;

    expect(out['apiKey']).toBe('[REDACTED]');
    expect(out['token']).toBe('[REDACTED]');
    expect(out['Secret']).toBe('[REDACTED]');
    expect(out['PASSWORD']).toBe('[REDACTED]');
    expect(out['jwt']).toBe('[REDACTED]');
    expect(out['url']).toBe('[REDACTED]');
    expect(out['path']).toBe('server.properties');
    expect(out['count']).toBe(3);
  });

  it('redacts nested keys at any depth', () => {
    const out = AuditLog.redact({
      outer: {
        inner: {
          apiKey: 'ptlc_secret',
          confirmation_token: 'tok',
          harmless: 'value',
        },
      },
      list: [{ download_url: 'https://node/x?token=abc' }, { name: 'ok' }],
    }) as Record<string, unknown>;

    const inner = (out['outer'] as Record<string, Record<string, unknown>>)['inner']!;
    expect(inner['apiKey']).toBe('[REDACTED]');
    expect(inner['confirmation_token']).toBe('[REDACTED]');
    expect(inner['harmless']).toBe('value');

    const list = out['list'] as Array<Record<string, unknown>>;
    expect(list[0]!['download_url']).toBe('[REDACTED]');
    expect(list[1]!['name']).toBe('ok');
  });

  it('leaves primitives, null and arrays of scalars intact', () => {
    expect(AuditLog.redact('plain')).toBe('plain');
    expect(AuditLog.redact(42)).toBe(42);
    expect(AuditLog.redact(null)).toBe(null);
    expect(AuditLog.redact({ files: ['a.txt', 'b.txt'] })).toEqual({ files: ['a.txt', 'b.txt'] });
  });

  it('does not mutate the input object', () => {
    const input = { apiKey: 'ptlc_secret', nested: { token: 't' } };
    AuditLog.redact(input);
    expect(input.apiKey).toBe('ptlc_secret');
    expect(input.nested.token).toBe('t');
  });

  it('survives circular references', () => {
    const circular: Record<string, unknown> = { name: 'x' };
    circular['self'] = circular;

    const out = AuditLog.redact(circular) as Record<string, unknown>;
    expect(out['name']).toBe('x');
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});
