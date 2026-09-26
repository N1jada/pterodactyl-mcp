/**
 * Confirmation — Layer 2 of the safety model (SPEC §7).
 *
 * Two mechanisms, selected at runtime:
 *  - MCP elicitation when the connected client declared the capability;
 *  - a two-phase, call-bound, single-use, 120 s confirmation token otherwise.
 *
 * Tokens live in memory only and are never persisted. The binding hash covers the
 * tool name, the server id and the normalised arguments, so a preview of one
 * operation cannot be used to confirm a different one.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Minimal structural view of the MCP server we need. Keeps this module decoupled. */
export interface ElicitCapableServer {
  server: {
    getClientCapabilities(): { elicitation?: unknown } | undefined;
    elicitInput(params: ElicitInputParams): Promise<ElicitInputResult>;
  };
}

export interface ElicitInputParams {
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, { type: 'boolean'; title?: string; description?: string }>;
    required?: string[];
  };
}

export interface ElicitInputResult {
  action: string;
  content?: Record<string, unknown>;
}

/** Passed through from the tool handler; only used for diagnostics/cancellation. */
export interface RequestExtra {
  signal?: AbortSignal;
  sessionId?: string;
  requestId?: string | number;
}

/** What the human is asked to approve. Rendered as readable text in the elicitation. */
export interface ElicitPreview {
  tool: string;
  server: string;
  /** The per-tool preview fields ("what will change"). */
  fields: Record<string, unknown>;
  /** True when Layer 3 will take an automatic backup first. */
  autoBackup?: boolean;
}

export type ElicitOutcome = 'accepted' | 'declined' | 'cancelled';

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' | 'mismatch' };

export const CONFIRMATION_TTL_MS = 120_000;

interface TokenEntry {
  bindingHash: string;
  expiresAt: number;
  used: boolean;
}

/** Recursively sort object keys and drop `undefined` values, so JSON is canonical. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const v = src[key];
      if (v === undefined) continue;
      out[key] = canonicalise(v);
    }
    return out;
  }
  return value;
}

function renderValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '(none)';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? '(none)' : value.map((v) => renderValue(v)).join(', ');
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Render an ElicitPreview as plain text a human can read in a confirmation dialog. */
export function renderPreview(preview: ElicitPreview): string {
  const lines: string[] = [];
  lines.push('Confirm this operation on your Pterodactyl server.');
  lines.push('');
  lines.push(`Tool:   ${preview.tool}`);
  lines.push(`Server: ${preview.server}`);
  const entries = Object.entries(preview.fields ?? {});
  if (entries.length > 0) {
    lines.push('');
    for (const [key, value] of entries) {
      lines.push(`${key}: ${renderValue(value)}`);
    }
  }
  if (preview.autoBackup) {
    lines.push('');
    lines.push('A backup will be taken automatically before this runs; if the backup fails the operation is aborted.');
  }
  lines.push('');
  lines.push('Proceed?');
  return lines.join('\n');
}

export class Confirmation {
  private readonly srv: ElicitCapableServer;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly random: () => string;
  private readonly tokens = new Map<string, TokenEntry>();

  constructor(opts: {
    server: ElicitCapableServer;
    now?: () => number;
    ttlMs?: number;
    random?: () => string;
  }) {
    this.srv = opts.server;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? CONFIRMATION_TTL_MS;
    this.random = opts.random ?? (() => randomBytes(24).toString('base64url'));
  }

  /** True when the connected client declared the elicitation capability. */
  clientSupportsElicitation(): boolean {
    try {
      const caps = this.srv.server.getClientCapabilities();
      return Boolean(caps && caps.elicitation);
    } catch {
      return false;
    }
  }

  /**
   * Ask the human, via the client, to approve `preview`.
   * Any transport/protocol failure is treated as 'cancelled' — never as approval.
   */
  async elicit(preview: ElicitPreview, extra?: RequestExtra): Promise<ElicitOutcome> {
    let result: ElicitInputResult;
    // A client that opens the dialog and never answers must not hang the tool call
    // forever: bound the wait to the same TTL as a confirmation token, and honour the
    // caller's abort signal. Either resolves as 'cancelled', never as approval.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`elicitation timed out after ${this.ttlMs} ms`)),
        this.ttlMs,
      );
      timer.unref?.();
      if (extra?.signal) {
        if (extra.signal.aborted) reject(new Error('elicitation aborted'));
        extra.signal.addEventListener('abort', () => reject(new Error('elicitation aborted')), {
          once: true,
        });
      }
    });
    try {
      result = await Promise.race([
        this.srv.server.elicitInput({
        message: renderPreview(preview),
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              title: 'Confirm',
              description: 'Tick to run this operation. Leave unticked to cancel it.',
            },
          },
          required: ['confirm'],
          },
        }),
        bounded,
      ]);
    } catch {
      return 'cancelled';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    switch (result?.action) {
      case 'accept':
        return result.content?.confirm === true ? 'accepted' : 'declined';
      case 'decline':
        return 'declined';
      case 'cancel':
        return 'cancelled';
      default:
        return 'cancelled';
    }
  }

  /** Mint a single-use token bound to `bindingHash`. Sweeps expired entries first. */
  mint(bindingHash: string): { token: string; expiresAt: number } {
    this.sweep();
    const token = this.random();
    const expiresAt = this.now() + this.ttlMs;
    this.tokens.set(token, { bindingHash, expiresAt, used: false });
    return { token, expiresAt };
  }

  /** Verify and consume a token. Rejects unknown, expired, reused, or rebound tokens. */
  consume(token: string, bindingHash: string): ConsumeResult {
    const entry = this.tokens.get(token);
    if (!entry) return { ok: false, reason: 'unknown' };
    if (this.now() >= entry.expiresAt) {
      this.tokens.delete(token);
      return { ok: false, reason: 'expired' };
    }
    if (entry.used) return { ok: false, reason: 'used' };
    if (entry.bindingHash !== bindingHash) return { ok: false, reason: 'mismatch' };
    entry.used = true;
    return { ok: true };
  }

  /** Number of live (unswept) tokens — for tests and diagnostics. */
  get size(): number {
    return this.tokens.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) {
      if (now >= entry.expiresAt) this.tokens.delete(token);
    }
  }

  /**
   * sha256 hex of the canonical JSON of the call: tool + server + normalised args,
   * with `confirmation_token` and `dry_run` stripped and `undefined` values dropped.
   */
  static bindingHash(tool: string, server: string, args: Record<string, unknown>): string {
    const stripped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args ?? {})) {
      if (key === 'confirmation_token' || key === 'dry_run') continue;
      if (value === undefined) continue;
      stripped[key] = value;
    }
    const payload = JSON.stringify(canonicalise({ tool, server, args: stripped }));
    return createHash('sha256').update(payload, 'utf8').digest('hex');
  }
}
