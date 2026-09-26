/**
 * Adversarial tests — attacking the five safety layers of SPEC §7.
 *
 * The threat model is NOT a hostile operator (anyone with the API key can do all of
 * this through the panel UI). It is a *confidently wrong* language model: sloppy with
 * argument shapes, and willing to satisfy "delete the world folder" via whatever
 * spelling of the path gets past the guard.
 *
 * Every `it` asserts the SAFE behaviour. A failing test is a real hole.
 *
 * Documented judgement calls (asserted below, stated here so the reasoning is reviewable):
 *
 *  - CASE SENSITIVITY. `WORLD/level.dat` must NOT match `world/**`. Pterodactyl's Wings
 *    runs the game server in a Linux container, where `WORLD` and `world` are different
 *    directories. Matching case-insensitively would refuse a legitimate, unrelated file;
 *    matching case-sensitively refuses exactly the path that exists. Case-sensitive is
 *    correct, and it is what minimatch does by default.
 *
 *  - PERCENT-ENCODING. `world%2Flevel.dat` must be refused. It is not a path a human
 *    types; it is a model that URL-encoded an argument it should have passed raw. Both
 *    readings are unsafe to allow: if the panel decodes it, it is `world/level.dat`; if
 *    it does not, we deleted a file the caller did not mean. Refuse (over-refusal here
 *    costs nothing).
 *
 *  - EMPTY / ROOT PATH. `''` and `/` normalise to the empty string, i.e. the server
 *    root. No write or delete legitimately targets the root, and "delete the server
 *    root" is the worst outcome this server can produce. Refuse.
 *
 *  - `PTERODACTYL_PROTECTED_PATHS=""`. An empty string means the defaults stay. The
 *    variable is documented as an override, and an override to "nothing at all" is far
 *    more likely to be an unset-variable accident (an empty shell expansion, a blank
 *    field in an MCP client config) than a deliberate "unprotect my worlds". Deliberate
 *    disabling is still possible — set it to a pattern that matches nothing.
 *
 *  - POWER COOLDOWN IS PER PROCESS, NOT PER SERVER. §7 Layer 4 says "reject a second
 *    one within 30 seconds" and "(Counted per process.)". Restart loops are the failure
 *    mode; a loop that alternates servers is still a loop.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Guard,
  normalisePath,
  matchProtected,
  joinServerPath,
  type AuditSink,
  type BackupCreator,
  type ConfirmationLike,
  type GuardConfig,
  type GuardDecision,
  type MutationRequest,
} from '../src/guard.js';
import {
  Confirmation,
  type ElicitCapableServer,
  type ElicitInputResult,
  type ElicitPreview,
} from '../src/confirm.js';
import { AuditLog } from '../src/audit.js';
import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { runMutation, type ToolContext } from '../src/tools/_shared.js';

const DEFAULT_PROTECTED = [
  'world/**',
  'world_nether/**',
  'world_the_end/**',
  'server.properties',
  'ops.json',
  'whitelist.json',
  'banned-*.json',
];

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  guard: Guard;
  audit: Record<string, unknown>[];
  advance(ms: number): void;
  enableElicitation(): void;
  setElicitResponse(r: ElicitInputResult | (() => Promise<ElicitInputResult>)): void;
  mints: string[];
  backups: { server: string; name: string }[];
  setBackup(fn: BackupCreator): void;
  confirmation: Confirmation;
}

function harness(
  cfg: Partial<GuardConfig> = {},
  opts: { backupTimeoutMs?: number } = {},
): Harness {
  const auditEntries: Record<string, unknown>[] = [];
  const sink: AuditSink = {
    append: async (entry) => {
      auditEntries.push(entry);
    },
  };

  let clock = 1_700_000_000_000;
  const now = () => clock;

  let caps: Record<string, unknown> | undefined = {}; // token flow by default
  let elicitResponse: ElicitInputResult | (() => Promise<ElicitInputResult>) = {
    action: 'accept',
    content: { confirm: true },
  };
  const stub: ElicitCapableServer = {
    server: {
      getClientCapabilities: () => caps,
      elicitInput: async () =>
        typeof elicitResponse === 'function' ? elicitResponse() : elicitResponse,
    },
  };

  let counter = 0;
  const real = new Confirmation({ server: stub, now, random: () => `tok-${++counter}` });
  const mints: string[] = [];
  const confirm: ConfirmationLike = {
    clientSupportsElicitation: () => real.clientSupportsElicitation(),
    elicit: (preview, extra) => real.elicit(preview, extra),
    mint: (hash) => {
      const minted = real.mint(hash);
      mints.push(minted.token);
      return minted;
    },
    consume: (token, hash) => real.consume(token, hash),
  };

  const backups: { server: string; name: string }[] = [];
  let backupImpl: BackupCreator = async (server, name) => {
    backups.push({ server, name });
    return { uuid: 'backup-uuid-1' };
  };
  const createBackup: BackupCreator = (server, name) => {
    backups.push({ server, name });
    return backupImpl(server, name);
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

  const guard = new Guard({
    config,
    audit: sink,
    confirm,
    createBackup,
    now,
    ...(opts.backupTimeoutMs !== undefined ? { backupTimeoutMs: opts.backupTimeoutMs } : {}),
  });

  return {
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
    mints,
    backups,
    setBackup: (fn) => {
      backupImpl = async (server, name) => fn(server, name);
    },
    confirmation: real,
  };
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

/** A delete of `path`, the shape a "delete the world folder" instruction produces. */
function del(path: string, over: Partial<MutationRequest> = {}): MutationRequest {
  return req({
    tool: 'ptero_delete_file',
    kind: 'delete',
    args: { path },
    paths: [path],
    preview: { path },
    fileCount: 1,
    ...over,
  });
}

function asRefused(d: GuardDecision): Extract<GuardDecision, { action: 'refused' }> {
  if (d.action !== 'refused') throw new Error(`expected refused, got ${d.action}`);
  return d;
}
function asProceed(d: GuardDecision): Extract<GuardDecision, { action: 'proceed' }> {
  if (d.action !== 'proceed') {
    throw new Error(`expected proceed, got ${d.action}: ${JSON.stringify(d)}`);
  }
  return d;
}
function asNeeds(d: GuardDecision): Extract<GuardDecision, { action: 'needs_confirmation' }> {
  if (d.action !== 'needs_confirmation') throw new Error(`expected needs_confirmation, got ${d.action}`);
  return d;
}

/* ========================================================================== */
/* 1. Path tricks against PTERODACTYL_PROTECTED_PATHS                         */
/* ========================================================================== */

describe('adversarial: protected-path evasion', () => {
  const mustRefuse: Array<[label: string, path: string]> = [
    ['a `..` that cancels out', 'world/../world/level.dat'],
    ['a leading `./`', './world/level.dat'],
    ['doubled separators', '//world//level.dat'],
    ['a Windows backslash separator', 'world\\level.dat'],
    ['a percent-encoded separator', 'world%2Flevel.dat'],
    ['a double percent-encoded separator', 'world%252Flevel.dat'],
    ['a percent-encoded dot', 'server%2Eproperties'],
    ['a trailing slash on the world directory', 'world/'],
    ['a `..` escaping into a protected file', 'plugins/../ops.json'],
    ['the banned-players list', 'banned-players.json'],
    ['an uppercase-extension banned list', 'banned-ips.json'],
  ];

  for (const [label, path] of mustRefuse) {
    it(`refuses \`${path}\` (${label})`, async () => {
      const h = harness();
      const d = asRefused(await h.guard.check(del(path)));
      expect(d.reason).toMatch(/protected path|server root|\.\./);
      expect(h.guard.mutationCount).toBe(0);
      expect(h.audit).toHaveLength(1);
      expect(h.audit[0]!['outcome']).toBe('refused');
    });
  }

  it('refuses the empty path — it resolves to the server root', async () => {
    const h = harness();
    const d = asRefused(await h.guard.check(del('')));
    expect(d.reason).toContain('server root');
    expect(h.guard.mutationCount).toBe(0);
  });

  it('refuses `/` — deleting the server root is the worst possible outcome', async () => {
    const h = harness();
    const d = asRefused(await h.guard.check(del('/')));
    expect(d.reason).toContain('server root');
  });

  it('refuses `.` and `./` as the whole path', async () => {
    for (const p of ['.', './', './.']) {
      const h = harness();
      expect(asRefused(await h.guard.check(del(p))).reason).toContain('server root');
    }
  });

  // DOCUMENTED DECISION: Linux is case-sensitive, so `WORLD` is a different directory.
  it('does NOT protect `WORLD/level.dat` — on Linux that is a different directory', async () => {
    const h = harness();
    const d = await h.guard.check(del('WORLD/level.dat'));
    expect(d.action).toBe('proceed');
    expect(matchProtected('WORLD/level.dat', DEFAULT_PROTECTED)).toBeUndefined();
  });

  it('is not over-broad: `server.properties.bak` and neighbours are allowed', async () => {
    for (const p of [
      'server.properties.bak',
      'server.properties.d/extra.yml',
      'worlds/backup.zip',
      'plugins/WorldEdit/config.yml',
      'logs/latest.log',
      'plugins/Geyser-Spigot/config.yml',
      'ops.json.bak',
      'not-banned-players.json',
    ]) {
      expect(matchProtected(normalisePath(p).path, DEFAULT_PROTECTED), p).toBeUndefined();
      const h = harness();
      expect((await h.guard.check(del(p))).action, p).toBe('proceed');
    }
  });

  it('treats unicode lookalikes as ordinary, unprotected names — cleanly, without throwing', async () => {
    const lookalikes = [
      'wörld/level.dat',
      'шorld/level.dat', // Cyrillic ш
      'аorld/level.dat', // Cyrillic а
      'world／level.dat', // fullwidth solidus, NOT a path separator
      'wor​ld/level.dat', // zero-width space
    ];
    for (const p of lookalikes) {
      expect(() => matchProtected(normalisePath(p).path, DEFAULT_PROTECTED)).not.toThrow();
      const h = harness();
      const d = await h.guard.check(del(p));
      expect(['proceed', 'refused'], p).toContain(d.action);
    }
  });

  it('does not crash on glob metacharacters or absurd inputs in the *path*', () => {
    const nasty = [
      '[a-z]world/x',
      '{world,ops.json}',
      '!(world)/x',
      '+(a|b)',
      'a'.repeat(5000),
      '**/*',
      'world/**',
    ];
    for (const p of nasty) {
      expect(() => matchProtected(normalisePath(p).path, DEFAULT_PROTECTED), p).not.toThrow();
    }
  });

  it('does not crash on a malformed percent escape', () => {
    for (const p of ['world%2', 'world%zz/level.dat', '100%_done.txt', '%']) {
      expect(() => matchProtected(normalisePath(p).path, DEFAULT_PROTECTED), p).not.toThrow();
    }
    // A real filename containing a literal `%` is still usable.
    expect(matchProtected(normalisePath('plugins/100%_config.yml').path, DEFAULT_PROTECTED)).toBeUndefined();
  });
});

/* ========================================================================== */
/* 1b. root + files combinations (Pterodactyl's delete/rename payload shape)   */
/* ========================================================================== */

describe('adversarial: root + files path composition', () => {
  it('joins root and file the way the panel resolves them', () => {
    expect(joinServerPath('/', 'world')).toBe('world');
    expect(joinServerPath('/world', '.')).toBe('world');
    expect(joinServerPath('/wor', 'ld/level.dat')).toBe('wor/ld/level.dat');
    expect(joinServerPath('plugins/', '/config.yml')).toBe('plugins/config.yml');
    expect(joinServerPath('', 'ops.json')).toBe('ops.json');
  });

  it('refuses root `/` + file `world` — a directory delete of the world', async () => {
    const h = harness();
    const path = joinServerPath('/', 'world');
    const d = asRefused(await h.guard.check(del(path)));
    expect(d.reason).toContain('protected path');
    expect(d.variable).toBe('PTERODACTYL_PROTECTED_PATHS');
  });

  it('refuses root `/world` + file `.` — the same directory by another spelling', async () => {
    const h = harness();
    const d = asRefused(await h.guard.check(del(joinServerPath('/world', '.'))));
    expect(d.reason).toContain('protected path');
  });

  it('root `/wor` + file `ld/level.dat` is a genuinely different path and is allowed', async () => {
    // The panel joins on the separator, so this is `/wor/ld/level.dat`, not the world.
    const h = harness();
    expect((await h.guard.check(del(joinServerPath('/wor', 'ld/level.dat')))).action).toBe('proceed');
    // But a tool that concatenated without a separator produces the world path — and is
    // refused, so the mistake fails closed either way.
    const h2 = harness();
    expect(asRefused(await h2.guard.check(del('/wor' + 'ld/level.dat'))).reason).toContain(
      'protected path',
    );
  });
});

/* ========================================================================== */
/* 2. Confirmation-token binding                                              */
/* ========================================================================== */

describe('adversarial: confirmation-token binding', () => {
  const destructive = (over: Partial<MutationRequest> = {}) =>
    del('plugins/old.jar', { destructive: true, ...over });

  async function mint(h: Harness, r: MutationRequest): Promise<string> {
    const d = asNeeds(await h.guard.check(r));
    return d.confirmation_token;
  }

  it('accepts the token when only the key ORDER of the arguments changed', async () => {
    const h = harness();
    const first = destructive({ args: { path: 'plugins/old.jar', root: '/', force: false } });
    const token = await mint(h, first);
    const second = destructive({
      args: { force: false, root: '/', path: 'plugins/old.jar' },
      confirmationToken: token,
    });
    expect((await h.guard.check(second)).action).toBe('proceed');
  });

  it('accepts the token when an extra explicitly-undefined argument appears', async () => {
    const h = harness();
    const token = await mint(h, destructive({ args: { path: 'plugins/old.jar' } }));
    const second = destructive({
      args: { path: 'plugins/old.jar', note: undefined },
      confirmationToken: token,
    });
    expect((await h.guard.check(second)).action).toBe('proceed');
  });

  it('accepts the token when dry_run flips between preview and confirm', async () => {
    const h = harness();
    const token = await mint(h, destructive({ args: { path: 'plugins/old.jar', dry_run: false } }));
    const second = destructive({
      args: { path: 'plugins/old.jar', dry_run: true },
      confirmationToken: token,
    });
    expect((await h.guard.check(second)).action).toBe('proceed');
  });

  it('rejects the token when a DEEP nested key differs', async () => {
    const h = harness();
    const token = await mint(
      h,
      destructive({ args: { path: 'plugins/old.jar', opts: { a: { b: { c: 1 } } } } }),
    );
    const second = destructive({
      args: { path: 'plugins/old.jar', opts: { a: { b: { c: 2 } } } },
      confirmationToken: token,
    });
    const d = asRefused(await h.guard.check(second));
    expect(d.reason).toContain('arguments differ from preview');
    expect(h.guard.mutationCount).toBe(0);
  });

  it('rejects the token when only an array ELEMENT ORDER differs', async () => {
    const h = harness();
    const token = await mint(h, destructive({ args: { files: ['a.txt', 'b.txt'] } }));
    const second = destructive({
      args: { files: ['b.txt', 'a.txt'] },
      confirmationToken: token,
    });
    expect(asRefused(await h.guard.check(second)).reason).toContain('arguments differ');
  });

  it('rejects the token when the server changed', async () => {
    const h = harness({ allowedServers: ['srv1', 'srv2'] });
    const token = await mint(h, destructive({ server: 'srv1' }));
    const d = asRefused(await h.guard.check(destructive({ server: 'srv2', confirmationToken: token })));
    expect(d.reason).toContain('arguments differ from preview');
  });

  it('rejects the token when the tool changed but the arguments are identical', async () => {
    const h = harness();
    const token = await mint(h, destructive({ tool: 'ptero_delete_file' }));
    const d = asRefused(
      await h.guard.check(destructive({ tool: 'ptero_delete_backup', kind: 'backup_delete', confirmationToken: token })),
    );
    expect(d.reason).toContain('arguments differ from preview');
  });

  it('rejects a token minted for a harmless path when replayed against the world', async () => {
    // The exact attack §7 names: preview something safe, confirm something else.
    const h = harness();
    const token = await mint(h, destructive({ args: { path: 'plugins/old.jar' } }));
    const swap = destructive({
      args: { path: 'plugins/old.jar' },
      paths: ['world/level.dat'],
      confirmationToken: token,
    });
    // Protected paths refuse first; the token must never make it past them either.
    const d = asRefused(await h.guard.check(swap));
    expect(d.reason).toContain('protected path');
  });

  it('binds the token to the paths/effect, not just the argument bag', async () => {
    const h = harness();
    const token = await mint(h, destructive({ args: { path: 'a.jar' }, paths: ['plugins/a.jar'] }));
    const swap = destructive({
      args: { path: 'a.jar' },
      paths: ['plugins/b.jar'], // same args, different file actually touched
      confirmationToken: token,
    });
    expect(asRefused(await h.guard.check(swap)).reason).toContain('arguments differ from preview');
  });

  it('rejects a token replayed after one successful use', async () => {
    const h = harness();
    const r = destructive();
    const token = await mint(h, r);
    expect((await h.guard.check({ ...r, confirmationToken: token })).action).toBe('proceed');
    const d = asRefused(await h.guard.check({ ...r, confirmationToken: token }));
    expect(d.reason).toContain('already used');
    expect(h.guard.mutationCount).toBe(1);
  });

  it('still refuses in read-only mode even with a token minted before the flip', async () => {
    // Config is frozen at startup, so this cannot happen in production — the assertion
    // is that Layer 1 runs before Layer 2 and cannot be unlocked by a valid token.
    const cfg: GuardConfig = {
      readOnly: false,
      allowedServers: ['srv1'],
      allowDelete: true,
      allowKill: true,
      protectedPaths: DEFAULT_PROTECTED,
      maxMutations: 20,
      autoBackup: false,
    };
    const entries: Record<string, unknown>[] = [];
    const stub: ElicitCapableServer = {
      server: { getClientCapabilities: () => ({}), elicitInput: async () => ({ action: 'cancel' }) },
    };
    const confirmation = new Confirmation({ server: stub });
    const guard = new Guard({
      config: cfg,
      audit: { append: async (e) => void entries.push(e) },
      confirm: confirmation,
      createBackup: async () => ({ uuid: 'u' }),
    });
    const r = del('plugins/old.jar', { destructive: true });
    const token = asNeeds(await guard.check(r)).confirmation_token;

    cfg.readOnly = true;
    const d = asRefused(await guard.check({ ...r, confirmationToken: token }));
    expect(d.variable).toBe('PTERODACTYL_READ_ONLY');
    expect(guard.mutationCount).toBe(0);
  });

  it('accepts at 119.999 s and rejects at exactly 120.000 s', async () => {
    const near = harness();
    const r = destructive();
    const t1 = await mint(near, r);
    near.advance(119_999);
    expect((await near.guard.check({ ...r, confirmationToken: t1 })).action).toBe('proceed');

    const at = harness();
    const t2 = await mint(at, r);
    at.advance(120_000);
    const d = asRefused(await at.guard.check({ ...r, confirmationToken: t2 }));
    expect(d.reason).toContain('expired');
  });

  it('rejects a token the guard never minted, including an empty-ish one', async () => {
    const h = harness();
    for (const bogus of ['not-a-token', ' ', 'tok-1']) {
      const d = asRefused(await h.guard.check(destructive({ confirmationToken: bogus })));
      expect(d.reason, bogus).toContain('unknown token');
    }
  });

  it('never leaks a token value into the audit trail', async () => {
    const h = harness();
    const d = asNeeds(await h.guard.check(destructive({ args: { path: 'x.jar', confirmation_token: 'leaky' } })));
    const serialised = JSON.stringify(h.audit);
    expect(serialised).not.toContain(d.confirmation_token);
    expect(serialised).not.toContain('leaky');
    expect(h.audit[0]!['outcome']).toBe('needs_confirmation');
  });
});

/* ========================================================================== */
/* 3. Elicitation                                                             */
/* ========================================================================== */

describe('adversarial: elicitation responses', () => {
  const destructive = del('plugins/old.jar', { destructive: true });

  it('treats `accept` with no `confirm` key as DECLINED', async () => {
    const h = harness();
    h.enableElicitation();
    h.setElicitResponse({ action: 'accept', content: {} });
    const d = asRefused(await h.guard.check(destructive));
    expect(d.reason).toContain('declined');
    expect(h.guard.mutationCount).toBe(0);
    expect(h.audit.at(-1)!['outcome']).toBe('declined');
  });

  it('treats `accept` with the STRING "true" as DECLINED', async () => {
    const h = harness();
    h.enableElicitation();
    h.setElicitResponse({ action: 'accept', content: { confirm: 'true' } });
    expect(asRefused(await h.guard.check(destructive)).reason).toContain('declined');
  });

  it('treats `accept` with a truthy non-boolean (1, "yes", {}) as DECLINED', async () => {
    for (const value of [1, 'yes', {}, [], 'TRUE']) {
      const h = harness();
      h.enableElicitation();
      h.setElicitResponse({ action: 'accept', content: { confirm: value } });
      expect(asRefused(await h.guard.check(destructive)).reason, String(value)).toContain('declined');
    }
  });

  it('treats a missing/undefined content object as DECLINED', async () => {
    const h = harness();
    h.enableElicitation();
    h.setElicitResponse({ action: 'accept' });
    expect(asRefused(await h.guard.check(destructive)).reason).toContain('declined');
  });

  it('treats a thrown elicitInput as cancelled — never as approval', async () => {
    const h = harness();
    h.enableElicitation();
    h.setElicitResponse(async () => {
      throw new Error('transport closed');
    });
    const d = asRefused(await h.guard.check(destructive));
    expect(d.reason).toContain('dismissed');
    expect(h.guard.mutationCount).toBe(0);
    expect(h.audit.at(-1)!['outcome']).toBe('declined');
  });

  it('treats an unknown action verb as cancelled', async () => {
    const h = harness();
    h.enableElicitation();
    h.setElicitResponse({ action: 'accepted-ish' });
    expect(asRefused(await h.guard.check(destructive)).reason).toContain('dismissed');
  });

  it('mints no token when elicitation is in play, so there is nothing to replay', async () => {
    const h = harness();
    h.enableElicitation();
    h.setElicitResponse({ action: 'accept', content: { confirm: false } });
    await h.guard.check(destructive);
    expect(h.mints).toHaveLength(0);
    expect(h.confirmation.size).toBe(0);
  });
});

/* ========================================================================== */
/* 4. Blast radius: budget, cooldown, bulk cap                                */
/* ========================================================================== */

describe('adversarial: mutation budget', () => {
  it('refuses the 21st rapid mutation when maxMutations is 20', async () => {
    const h = harness({ maxMutations: 20 });
    for (let i = 0; i < 20; i += 1) {
      expect((await h.guard.check(req({ args: { path: `plugins/f${i}.txt` } }))).action, `#${i}`).toBe(
        'proceed',
      );
    }
    const d = asRefused(await h.guard.check(req()));
    expect(d.variable).toBe('PTERODACTYL_MAX_MUTATIONS');
    expect(h.guard.mutationCount).toBe(20);
  });

  it('does not let refusals, previews, declines or dry runs consume the budget', async () => {
    const h = harness({ maxMutations: 1, autoBackup: true });
    await h.guard.check(del('world/level.dat')); // refused: protected
    await h.guard.check(req({ dryRun: true })); // dry run
    await h.guard.check(del('plugins/a.jar', { destructive: true })); // needs_confirmation
    h.setBackup(async () => {
      throw new Error('panel 500');
    });
    await h.guard.check(req({ wantsAutoBackup: true })); // refused: backup failed
    expect(h.guard.mutationCount).toBe(0);

    h.setBackup(async () => ({ uuid: 'ok' }));
    expect((await h.guard.check(req({ wantsAutoBackup: true }))).action).toBe('proceed');
    expect(h.guard.mutationCount).toBe(1);
  });

  it('treats PTERODACTYL_MAX_MUTATIONS=0 as "no mutations at all", not as unlimited', async () => {
    const h = harness({ maxMutations: 0 });
    const d = asRefused(await h.guard.check(req()));
    expect(d.variable).toBe('PTERODACTYL_MAX_MUTATIONS');
  });
});

describe('adversarial: power cooldown', () => {
  const power = (over: Partial<MutationRequest> = {}) =>
    req({
      tool: 'ptero_set_power_state',
      kind: 'power',
      powerSignal: 'restart',
      args: { signal: 'restart' },
      destructive: false,
      ...over,
    });

  it('refuses at 29.999 s and allows at exactly 30.000 s', async () => {
    const early = harness();
    expect((await early.guard.check(power())).action).toBe('proceed');
    early.advance(29_999);
    expect(asRefused(await early.guard.check(power())).reason).toContain('power actions are limited');

    const late = harness();
    expect((await late.guard.check(power())).action).toBe('proceed');
    late.advance(30_000);
    expect((await late.guard.check(power())).action).toBe('proceed');
  });

  // DOCUMENTED DECISION: per process, not per server. A restart loop that alternates
  // servers is still a restart loop, and §7 Layer 4 says "(Counted per process.)".
  it('is not bypassed by switching to a different server id', async () => {
    const h = harness({ allowedServers: ['srv1', 'srv2'] });
    expect((await h.guard.check(power({ server: 'srv1' }))).action).toBe('proceed');
    h.advance(1_000);
    const d = asRefused(await h.guard.check(power({ server: 'srv2' })));
    expect(d.reason).toContain('power actions are limited');
  });

  it('is not bypassed by changing the signal', async () => {
    const h = harness();
    expect((await h.guard.check(power({ powerSignal: 'stop' }))).action).toBe('proceed');
    h.advance(2_000);
    expect(asRefused(await h.guard.check(power({ powerSignal: 'start' }))).reason).toContain(
      'power actions are limited',
    );
  });
});

describe('adversarial: bulk cap', () => {
  it('falls back to paths.length when fileCount is omitted', async () => {
    const h = harness();
    const paths = Array.from({ length: 11 }, (_, i) => `plugins/junk/f${i}.txt`);
    const d = asRefused(
      await h.guard.check(req({ tool: 'ptero_delete_file', kind: 'delete', paths, fileCount: undefined })),
    );
    expect(d.reason).toContain('11 files');
    expect(d.reason).toContain('narrow the pattern');
    expect(h.guard.mutationCount).toBe(0);
  });

  it('allows exactly 10 paths with no fileCount', async () => {
    const h = harness();
    const paths = Array.from({ length: 10 }, (_, i) => `plugins/junk/f${i}.txt`);
    expect((await h.guard.check(req({ tool: 'ptero_delete_file', kind: 'delete', paths }))).action).toBe(
      'proceed',
    );
  });

  it('uses the larger of fileCount and paths.length', async () => {
    const h = harness();
    const paths = Array.from({ length: 11 }, (_, i) => `plugins/junk/f${i}.txt`);
    // A tool under-reporting fileCount must not shrink the blast radius.
    const d = asRefused(
      await h.guard.check(req({ tool: 'ptero_delete_file', kind: 'delete', paths, fileCount: 1 })),
    );
    expect(d.reason).toContain('11 files');
  });
});

/* ========================================================================== */
/* 5. Auto-backup (Layer 3)                                                   */
/* ========================================================================== */

describe('adversarial: pre-flight auto backup', () => {
  const write = req({ wantsAutoBackup: true, args: { path: 'plugins/notes.txt' }, paths: ['plugins/notes.txt'] });

  it('aborts when the backup resolves with an empty uuid — there is no rollback path', async () => {
    const h = harness({ autoBackup: true });
    h.setBackup(async () => ({ uuid: '' }));
    const d = asRefused(await h.guard.check(write));
    expect(d.reason).toContain('auto-backup');
    expect(d.variable).toBe('PTERODACTYL_AUTO_BACKUP');
    expect(h.guard.mutationCount).toBe(0);
  });

  it('aborts when the backup resolves with no object / no uuid at all', async () => {
    for (const bad of [undefined, null, {}, { uuid: null }, { uuid: 42 }]) {
      const h = harness({ autoBackup: true });
      h.setBackup(async () => bad as { uuid: string });
      const d = asRefused(await h.guard.check(write));
      expect(d.reason, JSON.stringify(bad)).toContain('auto-backup');
      expect(h.guard.mutationCount).toBe(0);
    }
  });

  it('aborts when the backup throws, and the confirmation token is burned (fail closed)', async () => {
    const h = harness({ autoBackup: true });
    const r = del('plugins/old.jar', { destructive: true, wantsAutoBackup: true });
    const token = asNeeds(await h.guard.check(r)).confirmation_token;
    h.setBackup(async () => {
      throw new Error('panel returned 500');
    });
    const d = asRefused(await h.guard.check({ ...r, confirmationToken: token }));
    expect(d.reason).toContain('auto-backup failed');
    // Retrying with the same token must not sneak past: a fresh preview is required.
    h.setBackup(async () => ({ uuid: 'now-it-works' }));
    expect(asRefused(await h.guard.check({ ...r, confirmationToken: token })).reason).toContain(
      'already used',
    );
  });

  it('aborts rather than hanging when the backup never resolves', async () => {
    const h = harness({ autoBackup: true }, { backupTimeoutMs: 25 });
    h.setBackup(() => new Promise<{ uuid: string }>(() => {}));
    const d = asRefused(await h.guard.check(write));
    expect(d.reason).toContain('auto-backup');
    expect(d.reason).toMatch(/timed out|did not/i);
    expect(h.guard.mutationCount).toBe(0);
  });

  it('aborts when the caller cancels while the backup is in flight', async () => {
    const h = harness({ autoBackup: true }, { backupTimeoutMs: 60_000 });
    const controller = new AbortController();
    h.setBackup(() => new Promise<{ uuid: string }>(() => {}));
    setTimeout(() => controller.abort(), 10);
    const d = asRefused(await h.guard.check(write, { signal: controller.signal }));
    expect(d.reason).toContain('auto-backup');
    expect(h.guard.mutationCount).toBe(0);
  });

  it('with autoBackup=false, proceeds without a backup and the audit line has no backup_id', async () => {
    const h = harness({ autoBackup: false });
    const d = asProceed(await h.guard.check(write));
    expect(d.backupId).toBeUndefined();
    expect(h.backups).toHaveLength(0);
    await d.commit('success');
    for (const entry of h.audit) expect(entry).not.toHaveProperty('backup_id');
  });

  it('with autoBackup=true, the backup happens BEFORE the mutation is counted', async () => {
    const h = harness({ autoBackup: true });
    const order: string[] = [];
    h.setBackup(async () => {
      order.push(`backup@count=${h.guard.mutationCount}`);
      return { uuid: 'b1' };
    });
    const d = asProceed(await h.guard.check(write));
    expect(order).toEqual(['backup@count=0']);
    expect(d.backupId).toBe('b1');
  });
});

/* ========================================================================== */
/* 6. Server allowlist                                                        */
/* ========================================================================== */

describe('adversarial: server boundary', () => {
  it('refuses every mutation when there is neither an allowlist nor a default server', async () => {
    // Fail closed: "which servers may I change?" must be answered explicitly.
    const h = harness({ allowedServers: [] });
    const d = asRefused(await h.guard.check(req({ server: 'someone-elses-server' })));
    expect(d.variable).toBe('PTERODACTYL_ALLOWED_SERVERS');
    expect(h.guard.mutationCount).toBe(0);
  });

  it('does not match an allowlist entry by prefix or whitespace padding', async () => {
    const h = harness({ allowedServers: ['1a2b3c4d'] });
    for (const bad of ['1a2b3c4', '1a2b3c4dx', ' 1a2b3c4d', '1a2b3c4d ', '1A2B3C4D']) {
      const d = asRefused(await h.guard.check(req({ server: bad })));
      expect(d.variable, bad).toBe('PTERODACTYL_ALLOWED_SERVERS');
    }
    expect((await h.guard.check(req({ server: '1a2b3c4d' }))).action).toBe('proceed');
  });
});

/* ========================================================================== */
/* 7. Audit trail (Layer 5)                                                   */
/* ========================================================================== */

describe('adversarial: audit redaction', () => {
  const API_KEY = 'ptlc_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';

  async function tempLog(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ptero-adv-'));
    return join(dir, 'audit.jsonl');
  }

  it('redacts a key named `Authorization`', () => {
    const out = AuditLog.redact({
      Authorization: `Bearer ${API_KEY}`,
      authorization: 'Bearer x',
      auth: 'x',
      bearer: 'x',
      cookie: 'session=1',
      credentials: 'x',
    }) as Record<string, unknown>;
    for (const key of Object.keys(out)) expect(out[key], key).toBe('[REDACTED]');
  });

  it('redacts apiKey (camelCase), signed_url and confirmation_token', () => {
    const out = AuditLog.redact({
      apiKey: API_KEY,
      signed_url: 'https://node/download?token=abc',
      confirmation_token: 'tok-1',
      innocent: 'server.properties',
    }) as Record<string, unknown>;
    expect(out['apiKey']).toBe('[REDACTED]');
    expect(out['signed_url']).toBe('[REDACTED]');
    expect(out['confirmation_token']).toBe('[REDACTED]');
    expect(out['innocent']).toBe('server.properties');
  });

  it('never writes the API key to disk even when it hides in a nested array under an innocent key', async () => {
    const path = await tempLog();
    const log = new AuditLog(path, { secrets: [API_KEY] });
    await log.append({
      ts: new Date().toISOString(),
      tool: 'ptero_send_console_command',
      server: 'srv1',
      outcome: 'attempted',
      args: {
        command: `curl -H "Authorization: Bearer ${API_KEY}" https://panel/api/client`,
        notes: [{ history: ['irrelevant', `key is ${API_KEY}`] }],
      },
    });
    const written = await readFile(path, 'utf8');
    expect(written).not.toContain(API_KEY);
    expect(written).toContain('[REDACTED]');
  });

  it('handles exotic values (Map, Set, Date, Error, class instance) without crashing or leaking', () => {
    const secret = new Map([['apiKey', API_KEY]]);
    const out = AuditLog.redact({
      map: secret,
      set: new Set([API_KEY]),
      when: new Date('2024-01-01T00:00:00.000Z'),
      err: new Error('boom'),
      bare: Object.assign(Object.create(null), { token: 't', name: 'n' }),
      big: 10n,
    }) as Record<string, unknown>;
    const serialised = JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    expect(serialised).not.toContain(API_KEY);
    expect(() => JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toThrow();
    expect((out['bare'] as Record<string, unknown>)['token']).toBe('[REDACTED]');
  });

  it('writes one JSON line per entry, and the line never contains a raw token value', async () => {
    const path = await tempLog();
    const log = new AuditLog(path, { secrets: [API_KEY] });
    await log.append({
      ts: new Date().toISOString(),
      tool: 'ptero_delete_file',
      server: 'srv1',
      outcome: 'needs_confirmation',
      args: { path: 'plugins/old.jar', confirmation_token: 'tok-secret-value' },
    });
    const written = await readFile(path, 'utf8');
    expect(written.trimEnd().split('\n')).toHaveLength(1);
    expect(written).not.toContain('tok-secret-value');
  });
});

/* ========================================================================== */
/* 8. runMutation                                                             */
/* ========================================================================== */

describe('adversarial: runMutation', () => {
  function ctxFor(h: Harness): ToolContext {
    return { guard: h.guard } as unknown as ToolContext;
  }

  it('records outcome "error" and returns isError when execute throws', async () => {
    const h = harness();
    const result = await runMutation(ctxFor(h), req(), undefined, async () => {
      throw new Error('wings said no');
    });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]!.text)).toContain('wings said no');
    expect(h.audit.map((e) => e['outcome'])).toContain('error');
    expect(h.audit.map((e) => e['outcome'])).not.toContain('success');
  });

  it('does not let the tool result overwrite guard-owned fields (status, server, backup_id)', async () => {
    const h = harness({ autoBackup: true });
    const result = await runMutation(
      ctxFor(h),
      req({ wantsAutoBackup: true }),
      undefined,
      async () =>
        ({
          status: 'refused',
          server: 'somewhere-else',
          backup_id: 'not-a-real-backup',
          confirmed_via: 'elicitation',
          deleted: 3,
        }) as Record<string, unknown>,
    );
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured['status']).toBe('success');
    expect(structured['server']).toBe('srv1');
    expect(structured['backup_id']).toBe('backup-uuid-1');
    expect(structured['confirmed_via']).toBe('none');
    expect(structured['deleted']).toBe(3);
  });

  it('never calls execute on a refusal, and surfaces the variable to turn', async () => {
    const h = harness({ readOnly: true });
    let called = false;
    const result = await runMutation(ctxFor(h), req(), undefined, async () => {
      called = true;
      return {};
    });
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(String(result.content[0]!.text)).toContain('PTERODACTYL_READ_ONLY');
  });

  it('never calls execute on needs_confirmation, and returns the preview as non-error', async () => {
    const h = harness();
    let called = false;
    const result = await runMutation(
      ctxFor(h),
      del('plugins/old.jar', { destructive: true }),
      undefined,
      async () => {
        called = true;
        return {};
      },
    );
    expect(called).toBe(false);
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as Record<string, unknown>)['status']).toBe('needs_confirmation');
  });
});

/* ========================================================================== */
/* 9. Config parsing                                                          */
/* ========================================================================== */

describe('adversarial: config', () => {
  const base = {
    PTERODACTYL_PANEL_URL: 'https://panel.example.com',
    PTERODACTYL_API_KEY: 'ptlc_key',
  } as const;

  // DOCUMENTED DECISION: empty string keeps the defaults. An empty value is far more
  // likely to be an unset variable / blank config field than a deliberate
  // "unprotect my world folder"; the fail-safe reading is the right one.
  it('PTERODACTYL_PROTECTED_PATHS="" does NOT disable protection', () => {
    const cfg = loadConfig({ ...base, PTERODACTYL_PROTECTED_PATHS: '' });
    expect(cfg.protectedPaths).toContain('world/**');
    expect(matchProtected('world/level.dat', cfg.protectedPaths)).toBe('world/**');
  });

  it('PTERODACTYL_PROTECTED_PATHS=" , , " does NOT disable protection either', () => {
    const cfg = loadConfig({ ...base, PTERODACTYL_PROTECTED_PATHS: ' , , ' });
    expect(cfg.protectedPaths).toContain('world/**');
  });

  it('an explicit non-empty override does replace the defaults', () => {
    const cfg = loadConfig({ ...base, PTERODACTYL_PROTECTED_PATHS: 'nothing-matches-this/**' });
    expect(cfg.protectedPaths).toEqual(['nothing-matches-this/**']);
  });

  it('PTERODACTYL_MAX_MUTATIONS=0 parses as zero (and blocks everything)', () => {
    expect(loadConfig({ ...base, PTERODACTYL_MAX_MUTATIONS: '0' }).maxMutations).toBe(0);
  });

  it('PTERODACTYL_MAX_MUTATIONS=-1 and =abc are fatal, actionable config errors', () => {
    for (const value of ['-1', 'abc', '1.5', 'Infinity', 'NaN', '1e3x']) {
      expect(() => loadConfig({ ...base, PTERODACTYL_MAX_MUTATIONS: value }), value).toThrow(
        ConfigError,
      );
    }
  });

  it('PTERODACTYL_ALLOWED_SERVERS trims whitespace around every entry', async () => {
    const cfg = loadConfig({ ...base, PTERODACTYL_ALLOWED_SERVERS: ' 1a2b3c4d , other ' });
    expect(cfg.allowedServers).toEqual(['1a2b3c4d', 'other']);

    const h = harness({ allowedServers: [...cfg.allowedServers] });
    expect((await h.guard.check(req({ server: '1a2b3c4d' }))).action).toBe('proceed');
    expect((await h.guard.check(req({ server: 'other' }))).action).toBe('proceed');
    expect(asRefused(await h.guard.check(req({ server: 'third' }))).variable).toBe(
      'PTERODACTYL_ALLOWED_SERVERS',
    );
  });

  it('a truthy-looking but invalid boolean is fatal rather than silently false', () => {
    for (const value of ['maybe', 'y', '2', 'TRUE!']) {
      expect(() => loadConfig({ ...base, PTERODACTYL_READ_ONLY: value }), value).toThrow(ConfigError);
    }
  });

  it('the config object is frozen, so no tool call can flip a boundary at runtime', () => {
    const cfg = loadConfig(base);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(() => {
      (cfg as { readOnly: boolean }).readOnly = false;
    }).toThrow();
  });
});
