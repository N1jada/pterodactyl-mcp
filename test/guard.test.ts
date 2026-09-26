import { describe, it, expect } from 'vitest';
import {
  Guard,
  normalisePath,
  matchProtected,
  redactArgs,
  type AuditSink,
  type BackupCreator,
  type ConfirmationLike,
  type GuardConfig,
  type GuardDecision,
  type MutationKind,
  type MutationRequest,
} from '../src/guard.js';
import {
  Confirmation,
  type ElicitCapableServer,
  type ElicitInputResult,
  type ElicitPreview,
} from '../src/confirm.js';

const DEFAULT_PROTECTED = [
  'world/**',
  'world_nether/**',
  'world_the_end/**',
  'server.properties',
  'ops.json',
  'whitelist.json',
  'banned-*.json',
];

const ALL_KINDS: MutationKind[] = ['write', 'delete', 'power', 'command', 'backup_create', 'backup_delete'];

interface Harness {
  guard: Guard;
  audit: Record<string, unknown>[];
  advance(ms: number): void;
  enableElicitation(): void;
  setElicitResponse(r: ElicitInputResult): void;
  elicitCalls: ElicitPreview[];
  elicitInputCalls: number;
  mints: string[];
  backups: { server: string; name: string }[];
  failBackup(err?: Error): void;
}

function harness(cfg: Partial<GuardConfig> = {}): Harness {
  const auditEntries: Record<string, unknown>[] = [];
  const sink: AuditSink = {
    append: async (entry) => {
      auditEntries.push(entry);
    },
  };

  let clock = 1_700_000_000_000;
  const now = () => clock;

  let caps: Record<string, unknown> | undefined = {}; // no elicitation by default → token flow
  let elicitResponse: ElicitInputResult = { action: 'accept', content: { confirm: true } };
  const state = { elicitInputCalls: 0 };
  const stub: ElicitCapableServer = {
    server: {
      getClientCapabilities: () => caps,
      elicitInput: async () => {
        state.elicitInputCalls += 1;
        return elicitResponse;
      },
    },
  };

  let counter = 0;
  const real = new Confirmation({ server: stub, now, random: () => `tok-${++counter}` });
  const mints: string[] = [];
  const elicitCalls: ElicitPreview[] = [];
  const confirm: ConfirmationLike = {
    clientSupportsElicitation: () => real.clientSupportsElicitation(),
    elicit: (preview, extra) => {
      elicitCalls.push(preview);
      return real.elicit(preview, extra);
    },
    mint: (hash) => {
      const minted = real.mint(hash);
      mints.push(minted.token);
      return minted;
    },
    consume: (token, hash) => real.consume(token, hash),
  };

  const backups: { server: string; name: string }[] = [];
  let backupError: Error | undefined;
  const createBackup: BackupCreator = async (server, name) => {
    backups.push({ server, name });
    if (backupError) throw backupError;
    return { uuid: 'backup-uuid-1' };
  };

  const config: GuardConfig = {
    readOnly: false,
    allowedServers: ['srv1'],
    allowDelete: true,
    allowKill: true,
    protectedPaths: DEFAULT_PROTECTED,
    maxMutations: 20,
    autoBackup: false,
    ...cfg,
  };

  const guard = new Guard({ config, audit: sink, confirm, createBackup, now });

  const h: Harness = {
    guard,
    audit: auditEntries,
    advance: (ms) => {
      clock += ms;
    },
    enableElicitation: () => {
      caps = { elicitation: {} };
    },
    setElicitResponse: (r) => {
      elicitResponse = r;
    },
    elicitCalls,
    get elicitInputCalls() {
      return state.elicitInputCalls;
    },
    mints,
    backups,
    failBackup: (err) => {
      backupError = err ?? new Error('panel returned 500');
    },
  } as Harness;
  return h;
}

function req(over: Partial<MutationRequest> = {}): MutationRequest {
  return {
    tool: 'ptero_write_file',
    server: 'srv1',
    args: { path: 'plugins/notes.txt' },
    kind: 'write',
    dryRun: false,
    preview: { path: 'plugins/notes.txt' },
    destructive: false,
    wantsAutoBackup: false,
    ...over,
  };
}

function requestForKind(kind: MutationKind): MutationRequest {
  switch (kind) {
    case 'write':
      return req({ tool: 'ptero_write_file', kind, paths: ['plugins/notes.txt'] });
    case 'delete':
      return req({ tool: 'ptero_delete_file', kind, paths: ['plugins/old.jar'], fileCount: 1 });
    case 'power':
      return req({ tool: 'ptero_set_power_state', kind, powerSignal: 'start', args: { signal: 'start' } });
    case 'command':
      return req({ tool: 'ptero_send_console_command', kind, args: { command: 'say hi' } });
    case 'backup_create':
      return req({ tool: 'ptero_create_backup', kind, args: {} });
    case 'backup_delete':
      return req({ tool: 'ptero_delete_backup', kind, args: { backup: 'uuid' } });
  }
}

function asProceed(d: GuardDecision): Extract<GuardDecision, { action: 'proceed' }> {
  if (d.action !== 'proceed') throw new Error(`expected proceed, got ${d.action}: ${JSON.stringify(d)}`);
  return d;
}
function asRefused(d: GuardDecision): Extract<GuardDecision, { action: 'refused' }> {
  if (d.action !== 'refused') throw new Error(`expected refused, got ${d.action}`);
  return d;
}
function asNeedsConfirmation(d: GuardDecision): Extract<GuardDecision, { action: 'needs_confirmation' }> {
  if (d.action !== 'needs_confirmation') throw new Error(`expected needs_confirmation, got ${d.action}`);
  return d;
}

// ---------------------------------------------------------------------------
// 1. Read-only mode
// ---------------------------------------------------------------------------

describe('Layer 1 — read-only mode', () => {
  it('refuses every mutation kind and names PTERODACTYL_READ_ONLY', async () => {
    for (const kind of ALL_KINDS) {
      const h = harness({ readOnly: true });
      const decision = asRefused(await h.guard.check(requestForKind(kind)));
      expect(decision.reason, kind).toContain('PTERODACTYL_READ_ONLY');
      expect(decision.variable).toBe('PTERODACTYL_READ_ONLY');
      expect(h.audit).toHaveLength(1);
      expect(h.audit[0]!['outcome']).toBe('refused');
      expect(h.guard.mutationCount).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Protected paths
// ---------------------------------------------------------------------------

describe('Layer 1 — protected paths', () => {
  const cases: Array<[string, string]> = [
    ['world/region/r.0.0.mca', 'world/**'],
    ['./world', 'world/**'],
    ['/server.properties', 'server.properties'],
    ['banned-ips.json', 'banned-*.json'],
  ];

  for (const [path, glob] of cases) {
    it(`refuses \`${path}\` naming the path and PTERODACTYL_PROTECTED_PATHS`, async () => {
      const h = harness();
      const normalised = normalisePath(path).path;
      const decision = asRefused(
        await h.guard.check(req({ tool: 'ptero_delete_file', kind: 'delete', paths: [path] })),
      );
      expect(decision.reason).toBe(
        `Refused: \`${normalised}\` matches a protected path (\`${glob}\`). ` +
          'Set `PTERODACTYL_PROTECTED_PATHS` to override.',
      );
      expect(decision.variable).toBe('PTERODACTYL_PROTECTED_PATHS');
      expect(h.audit).toHaveLength(1);
    });
  }

  it('lets an unprotected plugin config through', async () => {
    const h = harness();
    const decision = await h.guard.check(
      req({ paths: ['plugins/Geyser-Spigot/config.yml'], args: { path: 'plugins/Geyser-Spigot/config.yml' } }),
    );
    expect(decision.action).toBe('proceed');
    expect(h.guard.mutationCount).toBe(1);
  });

  it('matches directory globs against the directory itself and its contents', () => {
    expect(matchProtected('world', DEFAULT_PROTECTED)).toBe('world/**');
    expect(matchProtected('world/region/r.0.0.mca', DEFAULT_PROTECTED)).toBe('world/**');
    expect(matchProtected('world_nether/level.dat', DEFAULT_PROTECTED)).toBe('world_nether/**');
    expect(matchProtected('plugins/Geyser-Spigot/config.yml', DEFAULT_PROTECTED)).toBeUndefined();
    expect(matchProtected('worlds/backup.zip', DEFAULT_PROTECTED)).toBeUndefined();
  });

  it('matches dotfiles inside a protected directory', () => {
    expect(matchProtected('world/.hidden', DEFAULT_PROTECTED)).toBe('world/**');
  });

  describe('PTERODACTYL_UNPROTECTED_PATHS carves an exception out of a protected glob', () => {
    const exceptions = ['world/datapacks/mypack/**'];

    it('lets the excepted subtree through and nothing else', () => {
      expect(matchProtected('world/datapacks/mypack/pack.mcmeta', DEFAULT_PROTECTED, exceptions)).toBeUndefined();
      expect(matchProtected('world/datapacks/mypack/data/mypack/function/build.mcfunction', DEFAULT_PROTECTED, exceptions)).toBeUndefined();
      expect(matchProtected('world/datapacks/other/pack.mcmeta', DEFAULT_PROTECTED, exceptions)).toBe('world/**');
      expect(matchProtected('world/datapacks', DEFAULT_PROTECTED, exceptions)).toBe('world/**');
      expect(matchProtected('world/level.dat', DEFAULT_PROTECTED, exceptions)).toBe('world/**');
    });

    it('does not let an encoded path escape the world through the exception', () => {
      // decodes to world/datapacks/mypack/../level.dat — the traversal check refuses
      // this earlier, but the matcher on its own must not treat it as excepted either.
      expect(matchProtected('world/datapacks/mypack/%2e%2e/level.dat', DEFAULT_PROTECTED, exceptions)).toBe('world/**');
    });

    it('is honoured by the guard for writes', async () => {
      const h = harness({ unprotectedPaths: exceptions });
      const path = 'world/datapacks/mypack/pack.mcmeta';
      const ok = await h.guard.check(req({ paths: [path], args: { path } }));
      expect(ok.action).toBe('proceed');
      const other = 'world/datapacks/other/pack.mcmeta';
      const refused = asRefused(await h.guard.check(req({ paths: [other], args: { path: other } })));
      expect(refused.variable).toBe('PTERODACTYL_PROTECTED_PATHS');
    });
  });
});

// ---------------------------------------------------------------------------
// 3-5. Confirmation tokens
// ---------------------------------------------------------------------------

describe('Layer 2 — two-phase confirmation token', () => {
  const del = (over: Partial<MutationRequest> = {}) =>
    req({
      tool: 'ptero_delete_file',
      kind: 'delete',
      destructive: true,
      args: { path: 'plugins/old.jar' },
      preview: { path: 'plugins/old.jar', files: 1 },
      paths: ['plugins/old.jar'],
      ...over,
    });

  it('returns a preview plus a token on the first call, consuming no budget', async () => {
    const h = harness();
    const decision = asNeedsConfirmation(await h.guard.check(del()));
    expect(decision.confirmation_token).toBe('tok-1');
    expect(decision.expires_in_s).toBe(120);
    expect(decision.message).toContain('ptero_delete_file');
    expect(decision.preview).toEqual({ path: 'plugins/old.jar', files: 1 });
    expect(h.guard.mutationCount).toBe(0);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]!['outcome']).toBe('needs_confirmation');
  });

  it('rejects a token replayed with different arguments', async () => {
    const h = harness();
    const first = asNeedsConfirmation(await h.guard.check(del()));
    const decision = asRefused(
      await h.guard.check(
        del({ args: { path: 'plugins/other.jar' }, paths: ['plugins/other.jar'], confirmationToken: first.confirmation_token }),
      ),
    );
    expect(decision.reason).toContain('arguments differ from preview');
    expect(h.guard.mutationCount).toBe(0);
  });

  it('rejects a token on second use', async () => {
    const h = harness();
    const first = asNeedsConfirmation(await h.guard.check(del()));
    const ok = await h.guard.check(del({ confirmationToken: first.confirmation_token }));
    expect(asProceed(ok).confirmedVia).toBe('token');
    const replay = asRefused(await h.guard.check(del({ confirmationToken: first.confirmation_token })));
    expect(replay.reason).toContain('already used');
    expect(h.guard.mutationCount).toBe(1);
  });

  it('rejects a token after the 120 s expiry', async () => {
    const h = harness();
    const first = asNeedsConfirmation(await h.guard.check(del()));
    h.advance(120_001);
    const decision = asRefused(await h.guard.check(del({ confirmationToken: first.confirmation_token })));
    expect(decision.reason).toContain('expired');
    expect(h.guard.mutationCount).toBe(0);
  });

  it('rejects a token it never minted', async () => {
    const h = harness();
    const decision = asRefused(await h.guard.check(del({ confirmationToken: 'made-up' })));
    expect(decision.reason).toContain('unknown token');
  });

  it('does not require confirmation for a non-destructive mutation', async () => {
    const h = harness();
    const decision = asProceed(await h.guard.check(req({ kind: 'command', destructive: false })));
    expect(decision.confirmedVia).toBe('none');
    expect(h.mints).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6-7. Auto backup
// ---------------------------------------------------------------------------

describe('Layer 3 — pre-flight auto backup', () => {
  const delReq = req({
    tool: 'ptero_delete_file',
    kind: 'delete',
    destructive: true,
    wantsAutoBackup: true,
    args: { path: 'plugins/old.jar' },
    preview: { path: 'plugins/old.jar' },
    paths: ['plugins/old.jar'],
  });

  it('aborts the operation when the backup fails', async () => {
    const h = harness({ autoBackup: true });
    h.enableElicitation();
    h.failBackup(new Error('panel returned 500'));
    const decision = asRefused(await h.guard.check(delReq));
    expect(decision.reason).toContain('auto-backup failed');
    expect(decision.reason).toContain('panel returned 500');
    expect(decision.reason).toContain('PTERODACTYL_AUTO_BACKUP');
    expect(decision.variable).toBe('PTERODACTYL_AUTO_BACKUP');
    expect(h.guard.mutationCount).toBe(0);
    expect(h.backups).toHaveLength(1);
  });

  it('proceeds with a backupId and audits backup_id when the backup succeeds', async () => {
    const h = harness({ autoBackup: true });
    h.enableElicitation();
    const decision = asProceed(await h.guard.check(delReq));
    expect(decision.backupId).toBe('backup-uuid-1');
    expect(h.backups[0]!.server).toBe('srv1');
    expect(h.backups[0]!.name).toMatch(/^pre-ptero_delete_file-\d{4}-\d{2}-\d{2}T/);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]!['backup_id']).toBe('backup-uuid-1');
    await decision.commit('success');
    expect(h.audit).toHaveLength(2);
    expect(h.audit[1]!['outcome']).toBe('success');
    expect(h.audit[1]!['backup_id']).toBe('backup-uuid-1');
  });

  it('takes no backup for kinds outside write/delete/kill', async () => {
    const h = harness({ autoBackup: true });
    const decision = asProceed(
      await h.guard.check(req({ tool: 'ptero_send_console_command', kind: 'command', wantsAutoBackup: true })),
    );
    expect(decision.backupId).toBeUndefined();
    expect(h.backups).toHaveLength(0);
  });

  it('takes a backup before a kill', async () => {
    const h = harness({ autoBackup: true });
    await h.guard.check(
      req({ tool: 'ptero_set_power_state', kind: 'power', powerSignal: 'kill', wantsAutoBackup: true }),
    );
    expect(h.backups).toHaveLength(1);
  });

  it('skips the backup when PTERODACTYL_AUTO_BACKUP is off', async () => {
    const h = harness({ autoBackup: false });
    h.enableElicitation();
    const decision = asProceed(await h.guard.check(delReq));
    expect(decision.backupId).toBeUndefined();
    expect(h.backups).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Capability switches and the server allowlist
// ---------------------------------------------------------------------------

describe('Layer 1 — capability switches', () => {
  it('refuses delete and backup_delete when allowDelete is false', async () => {
    for (const kind of ['delete', 'backup_delete'] as const) {
      const h = harness({ allowDelete: false });
      const decision = asRefused(await h.guard.check(requestForKind(kind)));
      expect(decision.reason, kind).toContain('PTERODACTYL_ALLOW_DELETE');
      expect(decision.variable).toBe('PTERODACTYL_ALLOW_DELETE');
    }
  });

  it('refuses kill when allowKill is false but permits other power signals', async () => {
    const h = harness({ allowKill: false });
    const killed = asRefused(
      await h.guard.check(req({ tool: 'ptero_set_power_state', kind: 'power', powerSignal: 'kill' })),
    );
    expect(killed.reason).toContain('PTERODACTYL_ALLOW_KILL');
    expect(killed.variable).toBe('PTERODACTYL_ALLOW_KILL');

    const h2 = harness({ allowKill: false });
    const started = await h2.guard.check(
      req({ tool: 'ptero_set_power_state', kind: 'power', powerSignal: 'start' }),
    );
    expect(started.action).toBe('proceed');
  });

  it('refuses a server outside the allowlist', async () => {
    const h = harness({ allowedServers: ['srv1', 'srv2'] });
    const decision = asRefused(await h.guard.check(req({ server: 'other' })));
    expect(decision.reason).toContain('other');
    expect(decision.reason).toContain('PTERODACTYL_ALLOWED_SERVERS');
    expect(decision.variable).toBe('PTERODACTYL_ALLOWED_SERVERS');
    expect((await h.guard.check(req({ server: 'srv2' }))).action).toBe('proceed');
  });

  it('falls back to the default server when no allowlist is configured', async () => {
    const h = harness({ allowedServers: [], defaultServer: 'srv1' });
    expect((await h.guard.check(req({ server: 'srv1' }))).action).toBe('proceed');
    const h2 = harness({ allowedServers: [], defaultServer: 'srv1' });
    expect(asRefused(await h2.guard.check(req({ server: 'nope' }))).variable).toBe(
      'PTERODACTYL_ALLOWED_SERVERS',
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Path traversal
// ---------------------------------------------------------------------------

describe('Layer 1 — path traversal', () => {
  it('refuses any path containing a `..` segment', async () => {
    for (const path of ['../../etc/passwd', 'plugins/../../secret', '..']) {
      const h = harness();
      const decision = asRefused(await h.guard.check(req({ paths: [path] })));
      expect(decision.reason, path).toContain('..');
      expect(decision.reason).toContain('server root');
      expect(h.audit).toHaveLength(1);
    }
  });

  it('normalises leading slashes, `./` and doubled separators', () => {
    expect(normalisePath('/server.properties').path).toBe('server.properties');
    expect(normalisePath('./world').path).toBe('world');
    expect(normalisePath('.//plugins//a//b.yml').path).toBe('plugins/a/b.yml');
    expect(normalisePath('plugins/').path).toBe('plugins');
    expect(normalisePath('a/../b').traversal).toBe(true);
    expect(normalisePath('a/b').traversal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. Bulk cap
// ---------------------------------------------------------------------------

describe('Layer 4 — bulk delete cap', () => {
  it('refuses a delete resolving to 11 files', async () => {
    const h = harness();
    const decision = asRefused(
      await h.guard.check(req({ tool: 'ptero_delete_file', kind: 'delete', fileCount: 11 })),
    );
    expect(decision.reason).toContain('11 files');
    expect(decision.reason).toContain('narrow the pattern');
    expect(h.guard.mutationCount).toBe(0);
  });

  it('allows a delete resolving to 10 files', async () => {
    const h = harness();
    const decision = await h.guard.check(req({ tool: 'ptero_delete_file', kind: 'delete', fileCount: 10 }));
    expect(decision.action).toBe('proceed');
  });
});

// ---------------------------------------------------------------------------
// 11. Power cooldown
// ---------------------------------------------------------------------------

describe('Layer 4 — power cooldown', () => {
  const power = req({ tool: 'ptero_set_power_state', kind: 'power', powerSignal: 'start' });

  it('refuses a second power action within 30 s and allows it after', async () => {
    const h = harness();
    expect((await h.guard.check(power)).action).toBe('proceed');

    h.advance(5_000);
    const refused = asRefused(await h.guard.check(power));
    expect(refused.reason).toContain('power actions are limited');
    expect(refused.reason).toContain('25s');

    h.advance(26_000); // 31 s after the first
    expect((await h.guard.check(power)).action).toBe('proceed');
  });

  it('measures the cooldown from the last proceeded power action only', async () => {
    const h = harness();
    // A refused power action must not start the clock.
    const blocked = await harness({ readOnly: true }).guard.check(power);
    expect(blocked.action).toBe('refused');
    await h.guard.check(req({ ...power, dryRun: true }));
    expect((await h.guard.check(power)).action).toBe('proceed');
  });
});

// ---------------------------------------------------------------------------
// 12. Mutation budget
// ---------------------------------------------------------------------------

describe('Layer 1 — MAX_MUTATIONS budget', () => {
  it('refuses the (n+1)th proceed', async () => {
    const h = harness({ maxMutations: 2 });
    expect((await h.guard.check(req())).action).toBe('proceed');
    expect((await h.guard.check(req())).action).toBe('proceed');
    const decision = asRefused(await h.guard.check(req()));
    expect(decision.reason).toContain('PTERODACTYL_MAX_MUTATIONS');
    expect(decision.variable).toBe('PTERODACTYL_MAX_MUTATIONS');
  });

  it('does not let dry runs, refusals or previews consume budget', async () => {
    const h = harness({ maxMutations: 1 });
    await h.guard.check(req({ dryRun: true }));
    await h.guard.check(req({ dryRun: true }));
    await h.guard.check(req({ paths: ['world/level.dat'] })); // refused
    await h.guard.check(req({ destructive: true })); // needs_confirmation
    expect(h.guard.mutationCount).toBe(0);
    expect((await h.guard.check(req())).action).toBe('proceed');
    expect(h.guard.mutationCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 13. dry_run
// ---------------------------------------------------------------------------

describe('dry_run', () => {
  it('returns the preview and has no side effects', async () => {
    const h = harness({ autoBackup: true });
    const decision = await h.guard.check(
      req({
        tool: 'ptero_delete_file',
        kind: 'delete',
        destructive: true,
        wantsAutoBackup: true,
        dryRun: true,
        preview: { path: 'plugins/old.jar', files: 1 },
        paths: ['plugins/old.jar'],
      }),
    );
    expect(decision.action).toBe('dry_run');
    if (decision.action !== 'dry_run') throw new Error('unreachable');
    expect(decision.preview).toEqual({ path: 'plugins/old.jar', files: 1 });
    expect(h.backups).toHaveLength(0);
    expect(h.mints).toHaveLength(0);
    expect(h.elicitInputCalls).toBe(0);
    expect(h.guard.mutationCount).toBe(0);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]!['outcome']).toBe('dry_run');
  });
});

// ---------------------------------------------------------------------------
// 14. Elicitation
// ---------------------------------------------------------------------------

describe('Layer 2 — elicitation', () => {
  const delReq = req({
    tool: 'ptero_delete_file',
    kind: 'delete',
    destructive: true,
    args: { path: 'plugins/old.jar' },
    preview: { path: 'plugins/old.jar', files: 1 },
    paths: ['plugins/old.jar'],
  });

  it('elicits and proceeds when the user accepts, minting no token', async () => {
    const h = harness();
    h.enableElicitation();
    const decision = asProceed(await h.guard.check(delReq));
    expect(decision.confirmedVia).toBe('elicitation');
    expect(h.elicitInputCalls).toBe(1);
    expect(h.elicitCalls[0]).toMatchObject({ tool: 'ptero_delete_file', server: 'srv1' });
    expect(h.mints).toHaveLength(0);
    expect(h.audit[0]!['confirmed_via']).toBe('elicitation');
  });

  it('refuses with audit outcome "declined" when the user declines', async () => {
    const h = harness();
    h.enableElicitation();
    h.setElicitResponse({ action: 'decline' });
    const decision = asRefused(await h.guard.check(delReq));
    expect(decision.reason).toContain('declined');
    expect(h.mints).toHaveLength(0);
    expect(h.guard.mutationCount).toBe(0);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]!['outcome']).toBe('declined');
  });

  it('refuses when the dialog is cancelled', async () => {
    const h = harness();
    h.enableElicitation();
    h.setElicitResponse({ action: 'cancel' });
    const decision = asRefused(await h.guard.check(delReq));
    expect(decision.reason).toContain('dismissed');
    expect(h.audit[0]!['outcome']).toBe('declined');
  });
});

// ---------------------------------------------------------------------------
// 15. Audit redaction
// ---------------------------------------------------------------------------

describe('Layer 5 — audit trail', () => {
  it('redacts secret-shaped argument names', async () => {
    const h = harness();
    const decision = asProceed(
      await h.guard.check(
        req({
          args: {
            path: 'plugins/notes.txt',
            confirmation_token: 'tok-secret',
            download_url: 'https://panel/dl?signature=abc',
            api_key: 'ptlc_xyz',
            jwt: 'header.payload.sig',
            nested: { password: 'hunter2', keep: 'visible' },
          },
        }),
      ),
    );
    const args = h.audit[0]!['args'] as Record<string, unknown>;
    expect(args['confirmation_token']).toBe('[REDACTED]');
    expect(args['download_url']).toBe('[REDACTED]');
    expect(args['api_key']).toBe('[REDACTED]');
    expect(args['jwt']).toBe('[REDACTED]');
    expect((args['nested'] as Record<string, unknown>)['password']).toBe('[REDACTED]');
    expect((args['nested'] as Record<string, unknown>)['keep']).toBe('visible');
    expect(args['path']).toBe('plugins/notes.txt');
    expect(JSON.stringify(h.audit)).not.toContain('hunter2');
    await decision.commit('success');
  });

  it('redacts nested structures without touching innocent keys', () => {
    expect(redactArgs({ secretKey: 'a', list: [{ token: 'b' }, { name: 'c' }] })).toEqual({
      secretKey: '[REDACTED]',
      list: [{ token: '[REDACTED]' }, { name: 'c' }],
    });
  });

  it('records ts, tool, server, kind and outcome on every line', async () => {
    const h = harness();
    const decision = asProceed(await h.guard.check(req({ paths: ['plugins/notes.txt'] })));
    await decision.commit('error', { message: 'boom' });
    expect(h.audit).toHaveLength(2);
    for (const entry of h.audit) {
      expect(entry['ts']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry['tool']).toBe('ptero_write_file');
      expect(entry['server']).toBe('srv1');
      expect(entry['kind']).toBe('write');
      expect(entry['outcome']).toBeTypeOf('string');
    }
    expect(h.audit[0]!['outcome']).toBe('attempted');
    expect(h.audit[1]!['outcome']).toBe('error');
    expect(h.audit[1]!['message']).toBe('boom');
  });

  it('commit is idempotent — a second call writes nothing', async () => {
    const h = harness();
    const decision = asProceed(await h.guard.check(req()));
    await decision.commit('success');
    await decision.commit('success');
    expect(h.audit).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 16. Exactly one audit line per check()
// ---------------------------------------------------------------------------

describe('audit completeness', () => {
  it('writes exactly one audit line on every path through check()', async () => {
    const del = req({
      tool: 'ptero_delete_file',
      kind: 'delete',
      destructive: true,
      args: { path: 'plugins/old.jar' },
      preview: { path: 'plugins/old.jar' },
      paths: ['plugins/old.jar'],
    });

    const scenarios: Array<[string, () => Promise<{ audit: unknown[]; outcome: string }>]> = [
      ['read-only refusal', async () => {
        const h = harness({ readOnly: true });
        await h.guard.check(req());
        return { audit: h.audit, outcome: 'refused' };
      }],
      ['allowlist refusal', async () => {
        const h = harness();
        await h.guard.check(req({ server: 'nope' }));
        return { audit: h.audit, outcome: 'refused' };
      }],
      ['protected path refusal', async () => {
        const h = harness();
        await h.guard.check(req({ paths: ['world/level.dat'] }));
        return { audit: h.audit, outcome: 'refused' };
      }],
      ['traversal refusal', async () => {
        const h = harness();
        await h.guard.check(req({ paths: ['../escape'] }));
        return { audit: h.audit, outcome: 'refused' };
      }],
      ['budget refusal', async () => {
        const h = harness({ maxMutations: 0 });
        await h.guard.check(req());
        return { audit: h.audit, outcome: 'refused' };
      }],
      ['bulk refusal', async () => {
        const h = harness();
        await h.guard.check(req({ kind: 'delete', fileCount: 99 }));
        return { audit: h.audit, outcome: 'refused' };
      }],
      ['cooldown refusal', async () => {
        const h = harness();
        const power = req({ tool: 'ptero_set_power_state', kind: 'power', powerSignal: 'start' });
        await h.guard.check(power);
        h.audit.length = 0;
        await h.guard.check(power);
        return { audit: h.audit, outcome: 'refused' };
      }],
      ['dry run', async () => {
        const h = harness();
        await h.guard.check(req({ dryRun: true }));
        return { audit: h.audit, outcome: 'dry_run' };
      }],
      ['needs confirmation', async () => {
        const h = harness();
        await h.guard.check(del);
        return { audit: h.audit, outcome: 'needs_confirmation' };
      }],
      ['bad token refusal', async () => {
        const h = harness();
        await h.guard.check({ ...del, confirmationToken: 'bogus' });
        return { audit: h.audit, outcome: 'refused' };
      }],
      ['elicitation decline', async () => {
        const h = harness();
        h.enableElicitation();
        h.setElicitResponse({ action: 'decline' });
        await h.guard.check(del);
        return { audit: h.audit, outcome: 'declined' };
      }],
      ['backup failure refusal', async () => {
        const h = harness({ autoBackup: true });
        h.enableElicitation();
        h.failBackup();
        await h.guard.check({ ...del, wantsAutoBackup: true });
        return { audit: h.audit, outcome: 'refused' };
      }],
      ['proceed', async () => {
        const h = harness();
        h.enableElicitation();
        await h.guard.check(del);
        return { audit: h.audit, outcome: 'attempted' };
      }],
    ];

    for (const [name, run] of scenarios) {
      const { audit, outcome } = await run();
      expect(audit, name).toHaveLength(1);
      expect((audit[0] as Record<string, unknown>)['outcome'], name).toBe(outcome);
    }
  });
});
