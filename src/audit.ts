import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Outcome recorded for one mutating tool call. */
export type AuditOutcome =
  | 'attempted'
  | 'refused'
  | 'dry_run'
  | 'needs_confirmation'
  | 'declined'
  | 'success'
  | 'error';

/** One line of the append-only JSONL audit trail. */
export interface AuditEntry {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Tool name, e.g. `ptero_delete_file`. */
  tool: string;
  /** Server short identifier the call targeted. */
  server: string;
  /** Normalised arguments, already passed through `AuditLog.redact`. */
  args: Record<string, unknown>;
  /** Guard mutation kind: write | delete | power | command | backup_create | backup_delete. */
  kind?: string;
  outcome: AuditOutcome;
  /** Why a call was refused/declined. */
  reason?: string;
  /** Env var the operator would change to allow a refused call. */
  variable?: string;
  /** How the human confirmed: `elicitation`, `token`, or `none`. */
  confirmed_via?: string;
  /** Auto-backup taken before the change, for the rollback path. */
  backup_id?: string;
  /** Error message when `outcome` is `error`. Never contains secrets. */
  error?: string;
  /** Normalised file paths the call touched (relative to the server root). */
  paths?: string[];
  /** Power signal for `kind: 'power'` calls. */
  power_signal?: string;
  /** Effective file count for bulk operations. */
  file_count?: number;
  /** Per-tool result fields merged in on commit (e.g. deleted_count, bytes_written). */
  [extra: string]: unknown;
}

/**
 * Keys whose values are redacted before anything is written. `url` is deliberate: signed
 * backup and file download URLs carry a bearer-equivalent token in the query string.
 */
const SECRET_KEY_PATTERN =
  /token|key|secret|password|passwd|jwt|url|auth|bearer|credential|cookie|session/i;

const REDACTED = '[REDACTED]';

/** Shortest string worth scrubbing by value; below this, false positives dominate. */
const MIN_SECRET_LENGTH = 8;

export interface AuditLogOptions {
  /**
   * Literal secret values to scrub wherever they appear, whatever the key is called.
   * Key-shaped redaction cannot catch an API key pasted into a console command; this can.
   * Defaults to the API key from the environment.
   */
  secrets?: ReadonlyArray<string | undefined>;
}

/** Append-only JSONL audit trail (SPEC §7 Layer 5). */
export class AuditLog {
  /** Absolute path of the log file. */
  readonly path: string;

  private ensuredDir = false;
  private readonly secrets: string[];

  constructor(path: string, options: AuditLogOptions = {}) {
    this.path = path;
    const candidates = options.secrets ?? [process.env['PTERODACTYL_API_KEY']];
    this.secrets = [
      ...new Set(
        candidates.filter(
          (s): s is string => typeof s === 'string' && s.trim().length >= MIN_SECRET_LENGTH,
        ),
      ),
    ];
  }

  /**
   * Append one entry as a single JSON line.
   *
   * Never throws: a broken audit log must not break a tool call. It does, however,
   * always report the failure on stderr — a silently-missing audit trail would be
   * worse than a noisy one.
   */
  async append(entry: AuditEntry): Promise<void> {
    try {
      const redacted: AuditEntry = {
        ...entry,
        args: AuditLog.redact(entry.args) as Record<string, unknown>,
      };
      // Last line of defence: scrub known secret *values* out of the serialised line, so a
      // key pasted into a console command (or echoed back in an error) never lands on disk.
      let serialised = JSON.stringify(redacted);
      for (const secret of this.secrets) serialised = serialised.split(secret).join(REDACTED);
      const line = `${serialised}\n`;

      if (!this.ensuredDir) {
        await mkdir(dirname(this.path), { recursive: true });
        this.ensuredDir = true;
      }

      await appendFile(this.path, line, 'utf8');
    } catch (err) {
      // stderr only — stdout is the MCP transport.
      console.error(
        `[pterodactyl-mcp] AUDIT WRITE FAILED for ${entry.tool} (${entry.outcome}) -> ${this.path}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Deep-redact any value whose key looks like a secret. Recurses through plain objects
   * and arrays; leaves primitives alone.
   */
  static redact(args: unknown): unknown {
    return redactValue(args, new WeakSet<object>());
  }
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    return value.map((item) => redactValue(item, seen));
  }

  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    // Non-plain objects (Date, Error, Map, ...) are stringified rather than walked, so a
    // secret can't hide in an exotic shape we failed to traverse.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return String(value);
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(child, seen);
    }
    return out;
  }

  return value;
}
