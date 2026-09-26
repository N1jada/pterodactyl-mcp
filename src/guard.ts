/**
 * Guard — every safety layer from SPEC §7, in one module.
 *
 * Every mutating tool calls `guard.check()` exactly once and acts only on a
 * `proceed` decision. There are no per-tool safety checks anywhere else.
 *
 * None of this is a security boundary — anyone holding the API key can do the same
 * things through the panel UI. It is protection against *mistakes*: an agent acting
 * on a stale assumption, over-interpreting a vague instruction, or looping.
 *
 * Layer order (SPEC §7 / ARCHITECTURE.md), first refusal wins:
 *   1. config boundaries      readOnly, allowlist, allowDelete, allowKill,
 *                             protected paths (+ `..` traversal), MAX_MUTATIONS
 *   4. blast radius           bulk-file cap, power cooldown
 *   -  dry_run                preview, no side effects
 *   2. confirmation           elicitation, else two-phase bound token
 *   3. pre-flight backup      abort on failure
 *   -  commit                 counter, power clock, audit
 */
import { minimatch } from 'minimatch';
import { Confirmation, type ElicitPreview, type RequestExtra } from './confirm.js';

export type { RequestExtra };

/**
 * The slice of the app config the guard needs. The real `Config` from
 * `src/config.ts` structurally satisfies this — do not import it here.
 */
export interface GuardConfig {
  readOnly: boolean;
  allowedServers: string[];
  allowDelete: boolean;
  allowKill: boolean;
  protectedPaths: string[];
  /** Globs exempted from `protectedPaths` (see config). Optional. */
  unprotectedPaths?: string[];
  maxMutations: number;
  autoBackup: boolean;
  defaultServer?: string;
}

/** The slice of `AuditLog` the guard needs. */
export interface AuditSink {
  append(entry: Record<string, unknown>): Promise<void>;
}

/**
 * What the constructor accepts for `audit`. An implementation typed to its own entry
 * interface — `AuditLog.append(entry: AuditEntry)` — is fine at runtime but is not
 * assignable to `AuditSink`, because a TypeScript `interface` never gets an implicit
 * index signature. This widening keeps the published contract honest without forcing
 * `audit.ts` to change shape.
 */
export type AuditSinkInput = AuditSink | { append(entry: never): Promise<void> };

/** Layer 3 hook: create a backup and resolve once it is registered. */
export type BackupCreator = (server: string, name: string) => Promise<{ uuid: string }>;

/** The confirmation surface the guard needs (the real `Confirmation` satisfies it). */
export interface ConfirmationLike {
  clientSupportsElicitation(): boolean;
  elicit(preview: ElicitPreview, extra?: RequestExtra): Promise<'accepted' | 'declined' | 'cancelled'>;
  mint(bindingHash: string): { token: string; expiresAt: number };
  consume(token: string, bindingHash: string): { ok: true } | { ok: false; reason: 'unknown' | 'expired' | 'used' | 'mismatch' };
}

export type MutationKind = 'write' | 'delete' | 'power' | 'command' | 'backup_create' | 'backup_delete';
export type PowerSignal = 'start' | 'stop' | 'restart' | 'kill';

export interface MutationRequest {
  tool: string;
  server: string;
  /** Normalised arguments — exactly what will be executed. Bound into the token hash. */
  args: Record<string, unknown>;
  kind: MutationKind;
  /** File paths touched, relative to the server root. */
  paths?: string[];
  powerSignal?: PowerSignal;
  /** Number of files a bulk operation resolves to, for the blast-radius cap. */
  fileCount?: number;
  dryRun: boolean;
  confirmationToken?: string;
  /** What will change; shown to the human. */
  preview: Record<string, unknown>;
  /** Needs explicit human confirmation before running. */
  destructive: boolean;
  /** Wants a pre-flight backup (write/delete/kill). */
  wantsAutoBackup: boolean;
}

export type GuardDecision =
  | { action: 'refused'; reason: string; variable?: string }
  | { action: 'dry_run'; preview: Record<string, unknown> }
  | {
      action: 'needs_confirmation';
      preview: Record<string, unknown>;
      confirmation_token: string;
      expires_in_s: 120;
      message: string;
    }
  | {
      action: 'proceed';
      backupId?: string;
      confirmedVia: 'elicitation' | 'token' | 'none';
      commit(outcome: 'success' | 'error', extra?: Record<string, unknown>): Promise<void>;
    };

export const POWER_COOLDOWN_MS = 30_000;
export const BULK_FILE_LIMIT = 10;
export const CONFIRMATION_TTL_S = 120;
/** Longest the pre-flight backup may take before it counts as failed (Layer 3). */
// Deliberately longer than createBackupAndWait's own 120 s so the inner, uuid-bearing
// timeout message is the one that surfaces; this is only a backstop.
export const BACKUP_TIMEOUT_MS = 180_000;

/**
 * Argument keys whose values must never reach the audit log. `auth`/`bearer`/`cookie`
 * are here because a header-shaped argument (`Authorization: Bearer …`) carries the API
 * key itself, and nothing named that way is worth reading back later.
 */
const SECRETISH_KEY = /token|key|secret|password|passwd|jwt|url|auth|bearer|credential|cookie|session/i;

/** Belt-and-braces redaction; `audit.ts` redacts too. */
export function redactArgs(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((v) => redactArgs(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRETISH_KEY.test(key) ? '[REDACTED]' : redactArgs(v, depth + 1);
    }
    return out;
  }
  return value;
}

const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;

/**
 * Every spelling of `raw` that could name the same file: the string itself plus its
 * percent-decodings. A model that URL-encoded an argument it should have passed raw
 * (`world%2Flevel.dat`) must not thereby escape the protected-path list — and if the
 * panel does *not* decode it, refusing costs nothing but a re-ask.
 */
function decodeVariants(raw: string): string[] {
  const out = [raw];
  let current = raw;
  for (let i = 0; i < 4 && PERCENT_ESCAPE.test(current); i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break; // malformed escape (`100%_config.yml`) — the literal name is the only reading
    }
    if (next === current) break;
    current = next;
    out.push(current);
  }
  return out;
}

/** Single-spelling normalisation: the mechanical part of `normalisePath`. */
function normaliseOne(input: string): { path: string; traversal: boolean } {
  const raw = String(input ?? '').replace(/\\/g, '/');
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  return { path: segments.join('/'), traversal: segments.includes('..') };
}

/**
 * Normalise a server-relative path: strip leading `/` and `./`, collapse `//`,
 * drop `.` segments and any trailing slash. A `..` segment is reported, never resolved —
 * including one that only appears once percent-escapes are decoded. An empty result
 * means the path named the server root.
 */
export function normalisePath(input: string): { path: string; traversal: boolean } {
  const variants = decodeVariants(String(input ?? '')).map(normaliseOne);
  const primary = variants[0] ?? { path: '', traversal: false };
  return { path: primary.path, traversal: variants.some((v) => v.traversal) };
}

/**
 * Join a Pterodactyl `root` + `file` pair the way the panel resolves them, and normalise
 * the result. File tools must hand the guard the *joined* path, never just the file part:
 * `root: '/', files: ['world']` is a world-directory delete.
 */
export function joinServerPath(root: string, file: string): string {
  const base = normaliseOne(String(root ?? '')).path;
  return normalisePath(`${base}/${String(file ?? '')}`).path;
}

const GLOB_MAGIC = /[*?[\]{}!+@()]/;

/** `world/**` also names the directory `world` itself — return that prefix. */
function directoryPrefix(glob: string): string | undefined {
  let g = glob;
  let stripped = false;
  while (g.endsWith('/**') || g.endsWith('/*')) {
    g = g.endsWith('/**') ? g.slice(0, -3) : g.slice(0, -2);
    stripped = true;
  }
  return stripped && g.length > 0 ? g : undefined;
}

/**
 * The first protected glob that covers `path` (already normalised), if any. Every
 * percent-decoding of the path is tested, so an encoded separator cannot hide the match.
 */
export function matchProtected(
  path: string,
  protectedPaths: readonly string[],
  unprotectedPaths: readonly string[] = [],
): string | undefined {
  if (!path) return undefined;
  const variants = decodeVariants(path).map(normaliseOne);
  // A `..` in any spelling disables exceptions outright: the guard refuses traversal
  // before it gets here, but the matcher must not report such a path as excepted either.
  const traverses = variants.some((v) => v.traversal);
  for (const { path: normalised } of variants) {
    const hit = matchOneProtected(normalised, protectedPaths);
    if (!hit) continue;
    // An exception only lifts the refusal for the variant it actually covers; any
    // decoding that lands outside the exception is still refused.
    if (traverses || !matchOneProtected(normalised, unprotectedPaths)) return hit;
  }
  return undefined;
}

function matchOneProtected(path: string, protectedPaths: readonly string[]): string | undefined {
  if (!path) return undefined;
  for (const raw of protectedPaths) {
    const glob = normalisePath(raw).path;
    if (!glob) continue;
    const opts = { dot: true, matchBase: false } as const;
    if (minimatch(path, glob, opts)) return raw;
    // A glob naming a directory protects the directory itself, not only its contents.
    const prefix = directoryPrefix(glob);
    if (prefix && (path === prefix || minimatch(path, prefix, opts))) return raw;
    // A literal directory entry protects everything beneath it.
    if (!GLOB_MAGIC.test(glob) && path.startsWith(`${glob}/`)) return raw;
  }
  return undefined;
}

export class Guard {
  private readonly config: GuardConfig;
  private readonly audit: AuditSink;
  private readonly confirm: ConfirmationLike;
  private readonly createBackup: BackupCreator;
  private readonly now: () => number;
  private readonly backupTimeoutMs: number;

  /** Mutating calls that actually proceeded, this process. */
  private mutations = 0;
  /** Timestamp of the last power action that proceeded. */
  private lastPowerAt: number | undefined;

  constructor(deps: {
    config: GuardConfig;
    audit: AuditSinkInput;
    confirm: ConfirmationLike;
    createBackup: BackupCreator;
    now?: () => number;
    /** How long to wait for the pre-flight backup before treating it as failed. */
    backupTimeoutMs?: number;
  }) {
    this.config = deps.config;
    this.audit = deps.audit as AuditSink;
    this.confirm = deps.confirm;
    this.createBackup = deps.createBackup;
    this.now = deps.now ?? (() => Date.now());
    this.backupTimeoutMs = deps.backupTimeoutMs ?? BACKUP_TIMEOUT_MS;
  }

  /** Mutations that have proceeded so far this process. */
  get mutationCount(): number {
    return this.mutations;
  }

  async check(req: MutationRequest, extra?: RequestExtra): Promise<GuardDecision> {
    const normalised = (req.paths ?? []).map((p) => normalisePath(p));
    const paths = normalised.map((n) => n.path);

    const emit = async (outcome: string, fields?: Record<string, unknown>): Promise<void> => {
      const entry: Record<string, unknown> = {
        ts: new Date(this.now()).toISOString(),
        tool: req.tool,
        server: req.server,
        kind: req.kind,
        args: redactArgs(req.args ?? {}),
        dry_run: req.dryRun === true,
        outcome,
      };
      if (paths.length > 0) entry['paths'] = paths;
      if (req.powerSignal) entry['power_signal'] = req.powerSignal;
      if (typeof req.fileCount === 'number') entry['file_count'] = req.fileCount;
      if (fields) Object.assign(entry, fields);
      await this.audit.append(entry);
    };

    const refuse = async (reason: string, variable?: string): Promise<GuardDecision> => {
      const message = variable
        ? `Refused: ${reason}. Set \`${variable}\` to override.`
        : `Refused: ${reason}.`;
      await emit('refused', variable ? { reason: message, variable } : { reason: message });
      return variable
        ? { action: 'refused', reason: message, variable }
        : { action: 'refused', reason: message };
    };

    // ---- Layer 1: configuration boundaries -------------------------------------
    if (this.config.readOnly) {
      return refuse(
        `\`${req.tool}\` is a mutating tool and this server is in read-only mode`,
        'PTERODACTYL_READ_ONLY',
      );
    }

    if (!this.serverAllowed(req.server)) {
      const hasBoundary =
        (this.config.allowedServers?.length ?? 0) > 0 || Boolean(this.config.defaultServer);
      return refuse(
        hasBoundary
          ? `server \`${req.server}\` is not in the allowed-servers list`
          : 'no server allowlist is configured and there is no default server, so no server may ' +
            'be modified; name the server you mean in PTERODACTYL_ALLOWED_SERVERS (or set ' +
            'PTERODACTYL_DEFAULT_SERVER)',
        'PTERODACTYL_ALLOWED_SERVERS',
      );
    }

    if ((req.kind === 'delete' || req.kind === 'backup_delete') && !this.config.allowDelete) {
      const what = req.kind === 'backup_delete' ? 'backup deletion' : 'file deletion';
      return refuse(`${what} is disabled`, 'PTERODACTYL_ALLOW_DELETE');
    }

    if (req.powerSignal === 'kill' && !this.config.allowKill) {
      return refuse(
        'the `kill` power signal is disabled (it stops the process without saving)',
        'PTERODACTYL_ALLOW_KILL',
      );
    }

    for (let i = 0; i < normalised.length; i += 1) {
      const n = normalised[i]!;
      const original = req.paths?.[i] ?? n.path;
      if (n.path === '') {
        // `''`, `/`, `.`, `./` all name the server root. Nothing this server writes or
        // deletes legitimately targets the root, and "delete the root" is the worst
        // outcome it could produce.
        return refuse(
          `\`${original}\` resolves to the server root; name the file or directory explicitly`,
        );
      }
      if (n.traversal) {
        return refuse(
          `\`${original}\` contains a \`..\` segment; paths must stay inside the server root`,
        );
      }
      const glob = matchProtected(n.path, this.config.protectedPaths, this.config.unprotectedPaths ?? []);
      if (glob) {
        const message =
          `Refused: \`${n.path}\` matches a protected path (\`${glob}\`). ` +
          'Set `PTERODACTYL_PROTECTED_PATHS` to override.';
        await emit('refused', { reason: message, variable: 'PTERODACTYL_PROTECTED_PATHS' });
        return { action: 'refused', reason: message, variable: 'PTERODACTYL_PROTECTED_PATHS' };
      }
    }

    if (this.mutations >= this.config.maxMutations) {
      return refuse(
        `this process has already made ${this.mutations} mutating calls, the configured maximum ` +
          `(${this.config.maxMutations}); restart the server to reset the budget`,
        'PTERODACTYL_MAX_MUTATIONS',
      );
    }

    // ---- Layer 4: blast radius --------------------------------------------------
    // A caller that forgets `fileCount`, or under-reports it, must not shrink the blast
    // radius: the number of paths actually touched is a floor on the file count.
    const effectiveFileCount = Math.max(req.fileCount ?? 0, paths.length);
    if (effectiveFileCount > BULK_FILE_LIMIT) {
      return refuse(
        `this call resolves to ${effectiveFileCount} files, above the bulk limit of ${BULK_FILE_LIMIT}; ` +
          'narrow the pattern and work in smaller batches',
      );
    }

    if (req.kind === 'power' && this.lastPowerAt !== undefined) {
      const elapsed = this.now() - this.lastPowerAt;
      if (elapsed < POWER_COOLDOWN_MS) {
        const remaining = Math.ceil((POWER_COOLDOWN_MS - elapsed) / 1000);
        return refuse(
          `another power action ran ${Math.floor(elapsed / 1000)}s ago; power actions are limited to ` +
            `one per ${POWER_COOLDOWN_MS / 1000}s — wait ${remaining}s and retry`,
        );
      }
    }

    // ---- dry run: full preview, no side effects ---------------------------------
    if (req.dryRun) {
      await emit('dry_run', { preview: redactArgs(req.preview ?? {}) });
      return { action: 'dry_run', preview: req.preview };
    }

    const wantsBackup =
      this.config.autoBackup &&
      req.wantsAutoBackup === true &&
      (req.kind === 'write' || req.kind === 'delete' || req.powerSignal === 'kill');

    // ---- Layer 2: human confirmation --------------------------------------------
    let confirmedVia: 'elicitation' | 'token' | 'none' = 'none';

    if (req.destructive) {
      if (this.confirm.clientSupportsElicitation()) {
        const preview: ElicitPreview = {
          tool: req.tool,
          server: req.server,
          fields: req.preview ?? {},
          autoBackup: wantsBackup,
        };
        const outcome = await this.confirm.elicit(preview, extra);
        if (outcome !== 'accepted') {
          const reason =
            outcome === 'declined'
              ? `Refused: the operation was declined in the confirmation prompt.`
              : `Refused: the confirmation prompt was dismissed without an answer.`;
          await emit('declined', { reason, confirmed_via: 'elicitation' });
          return { action: 'refused', reason };
        }
        confirmedVia = 'elicitation';
      } else {
        // Bound to the *effect*, not only the argument bag: two calls with identical
        // arguments that touch different files are different operations.
        const hash = Confirmation.bindingHash(req.tool, req.server, {
          ...(req.args ?? {}),
          __guard_effect: {
            kind: req.kind,
            paths,
            ...(req.powerSignal ? { power_signal: req.powerSignal } : {}),
            ...(effectiveFileCount > 0 ? { file_count: effectiveFileCount } : {}),
          },
        });
        if (!req.confirmationToken) {
          const { token } = this.confirm.mint(hash);
          const message = this.confirmationMessage(req, token, wantsBackup);
          await emit('needs_confirmation', { preview: redactArgs(req.preview ?? {}) });
          return {
            action: 'needs_confirmation',
            preview: req.preview,
            confirmation_token: token,
            expires_in_s: CONFIRMATION_TTL_S,
            message,
          };
        }
        const result = this.confirm.consume(req.confirmationToken, hash);
        if (!result.ok) {
          const detail = {
            unknown: 'unknown token',
            expired: 'expired',
            used: 'already used',
            mismatch: 'arguments differ from preview',
          }[result.reason];
          return refuse(
            `the confirmation token was rejected (${detail}); call \`${req.tool}\` again without a ` +
              'token to get a fresh preview',
          );
        }
        confirmedVia = 'token';
      }
    }

    // ---- Layer 3: pre-flight automatic backup -----------------------------------
    let backupId: string | undefined;
    if (wantsBackup) {
      try {
        const stamp = new Date(this.now()).toISOString();
        backupId = await this.awaitBackup(req.server, `pre-${req.tool}-${stamp}`, extra?.signal);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const message =
          `Refused: auto-backup failed: ${detail}. Set \`PTERODACTYL_AUTO_BACKUP=false\` to ` +
          'proceed without one (not recommended).';
        await emit('refused', { reason: message, variable: 'PTERODACTYL_AUTO_BACKUP', confirmed_via: confirmedVia });
        return { action: 'refused', reason: message, variable: 'PTERODACTYL_AUTO_BACKUP' };
      }
    }

    // ---- proceed -----------------------------------------------------------------
    this.mutations += 1;
    if (req.kind === 'power') this.lastPowerAt = this.now();

    const committed = { done: false };
    await emit('attempted', {
      confirmed_via: confirmedVia,
      ...(backupId ? { backup_id: backupId } : {}),
    });

    const decision: GuardDecision = {
      action: 'proceed',
      confirmedVia,
      commit: async (outcome: 'success' | 'error', extraFields?: Record<string, unknown>) => {
        if (committed.done) return;
        committed.done = true;
        await emit(outcome, {
          confirmed_via: confirmedVia,
          ...(backupId ? { backup_id: backupId } : {}),
          ...(extraFields ? { ...redactArgs(extraFields) as Record<string, unknown> } : {}),
        });
      },
    };
    if (backupId) decision.backupId = backupId;
    return decision;
  }

  /**
   * Layer 3, hardened: a backup that never registers is a failed backup. Bounded by
   * `backupTimeoutMs` and by the caller's abort signal so a stuck panel cannot leave the
   * tool call hanging, and rejected unless a usable backup id came back — without one
   * there is no rollback path, which is the entire point of the pre-flight backup.
   */
  private async awaitBackup(
    server: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      throw new Error('the request was cancelled before the backup started');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const created = await Promise.race([
        (async () => this.createBackup(server, name))(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `the panel did not confirm the backup within ${this.backupTimeoutMs}ms (timed out). Call ptero_list_backups: a backup may still be running and occupying a slot`,
              ),
            );
          }, this.backupTimeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
          if (signal) {
            onAbort = () =>
              reject(new Error('the request was cancelled while the backup was in flight'));
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }),
      ]);
      const uuid = (created as { uuid?: unknown } | null | undefined)?.uuid;
      if (typeof uuid !== 'string' || uuid.trim() === '') {
        throw new Error('the panel returned no backup id, so there would be no rollback path');
      }
      return uuid;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private serverAllowed(server: string): boolean {
    const list = this.config.allowedServers ?? [];
    if (list.length > 0) return list.includes(server);
    // No explicit allowlist: fall back to the default server when one is configured.
    if (this.config.defaultServer) return this.config.defaultServer === server;
    // Neither an allowlist nor a default server: fail closed. "Which servers may I
    // change?" has to be answered deliberately — an unanswered boundary is not an open one.
    return false;
  }

  private confirmationMessage(req: MutationRequest, token: string, wantsBackup: boolean): string {
    const lines: string[] = [];
    lines.push(`Confirmation required before \`${req.tool}\` runs on server \`${req.server}\`.`);
    lines.push('');
    lines.push('This preview is for the human, not for you to round-trip silently:');
    lines.push('show it, wait for a decision, then call the tool again with the same arguments');
    lines.push('plus `confirmation_token`.');
    lines.push('');
    for (const [key, value] of Object.entries(req.preview ?? {})) {
      lines.push(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    if (wantsBackup) {
      lines.push('');
      lines.push('A backup will be taken automatically first; if it fails the operation is aborted.');
    }
    lines.push('');
    lines.push(
      `Token \`${token}\` expires in ${CONFIRMATION_TTL_S}s, works once, and is bound to these exact ` +
        'arguments — changing any of them invalidates it.',
    );
    return lines.join('\n');
  }
}
