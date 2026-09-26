import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AuditLog } from '../audit.js';
import type { PteroClient } from '../client.js';
import type { Config } from '../config.js';
import type { Guard } from '../guard.js';
import { ConfigError, toActionableMessage } from '../errors.js';

/** Everything a `registerXxxTools` function needs. Built once in `src/index.ts`. */
export interface ToolContext {
  server: McpServer;
  client: PteroClient;
  guard: Guard;
  config: Config;
  audit: AuditLog;
}

/* -------------------------------------------------------------------------- */
/* Common Zod fragments — import these, never redefine them                   */
/* -------------------------------------------------------------------------- */

export const serverIdSchema = z
  .string()
  .optional()
  .describe(
    'Server short identifier (e.g. 1a2b3c4d). Omit to use PTERODACTYL_DEFAULT_SERVER. ' +
      'Call ptero_list_servers to discover valid identifiers.',
  );

export const dryRunSchema = z
  .boolean()
  .default(false)
  .describe(
    'When true, validate and preview the change without performing it. Nothing is ' +
      'modified and no confirmation token is issued. Use this to reason about an ' +
      'operation before committing to it.',
  );

export const confirmationTokenSchema = z
  .string()
  .optional()
  .describe(
    'Two-phase confirmation token. Leave this out on the first call: the tool will ' +
      'refuse to act and instead return a preview of exactly what would change, plus a ' +
      'single-use token that expires in 120 seconds. THE PREVIEW IS FOR THE HUMAN — show ' +
      'it to the user in your reply and let them decide. Do not silently round-trip the ' +
      'token back in an immediate second call. Only call again with the token once the ' +
      'user has seen the preview and approved it. The token is bound to a hash of these ' +
      'exact arguments, so changing any argument invalidates it.',
  );

/* -------------------------------------------------------------------------- */
/* Server resolution                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the target server: the explicit argument if given, otherwise
 * `PTERODACTYL_DEFAULT_SERVER`. Throws an actionable `ConfigError` if neither exists.
 */
export function resolveServer(ctx: ToolContext, server?: string): string {
  const explicit = server?.trim();
  if (explicit) return explicit;

  const fallback = ctx.config.defaultServer?.trim();
  if (fallback) return fallback;

  throw new ConfigError(
    'No server specified and PTERODACTYL_DEFAULT_SERVER is not set. ' +
      'Pass the `server` argument with a server short identifier, or ask the user to set ' +
      'PTERODACTYL_DEFAULT_SERVER. Call ptero_list_servers to see the identifiers this API key can access.',
    'PTERODACTYL_DEFAULT_SERVER',
  );
}

/* -------------------------------------------------------------------------- */
/* Result builders                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Shape the SDK accepts back from a tool handler. The index signature is what the SDK's
 * `CallToolResult` requires (`_meta` and friends), not a licence to add ad-hoc fields.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Successful result: structured payload plus a human-readable summary. When no summary
 * is given the structured payload is serialised, per the spec's backwards-compatibility
 * guidance that structured results should also appear as text.
 */
export function ok<T extends Record<string, unknown>>(structured: T, text?: string): ToolResult {
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/**
 * Tool-execution error: `isError: true` with a message the calling model can act on.
 * Handlers must return this rather than throwing.
 */
export function fail(err: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: toActionableMessage(err) }],
    isError: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers                                                         */
/* -------------------------------------------------------------------------- */

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** `1610612736` -> `"1.5 GiB"`. Binary units, matching how the panel presents limits. */
export function bytesToHuman(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown';
  const negative = bytes < 0;
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value < 10 ? 2 : 1);
  return `${negative ? '-' : ''}${rounded} ${BYTE_UNITS[unit]}`;
}

/** `93784000` -> `"1d 2h 3m 4s"`. Input is milliseconds (Wings reports uptime in ms). */
export function formatUptime(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0s';
  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

/* -------------------------------------------------------------------------- */
/* Mutation runner — the ONE way a mutating tool talks to the guard           */
/* -------------------------------------------------------------------------- */

import type { GuardDecision, MutationRequest, RequestExtra } from '../guard.js';

export type ProceedDecision = Extract<GuardDecision, { action: 'proceed' }>;

/**
 * Zod output shape shared by every mutating tool. Spread it into the tool's own
 * `outputSchema` and add tool-specific fields (they are only present on `status: 'success'`).
 */
export const mutationOutputShape = {
  status: z
    .enum(['success', 'refused', 'dry_run', 'needs_confirmation'])
    .describe(
      'success = the change was made. refused = a guardrail blocked it (see reason/variable). ' +
        'dry_run = nothing changed; preview shows what would. needs_confirmation = nothing changed; ' +
        'SHOW the preview to the human and, only if they agree, call again with confirmation_token.',
    ),
  server: z.string(),
  preview: z.record(z.unknown()).optional().describe('What would / did change.'),
  reason: z.string().optional().describe('Why the call was refused.'),
  variable: z.string().optional().describe('Environment variable that caused the refusal.'),
  confirmation_token: z.string().optional(),
  expires_in_s: z.number().optional(),
  message: z.string().optional(),
  backup_id: z.string().optional().describe('UUID of the automatic pre-change backup, if one was taken.'),
  confirmed_via: z.enum(['elicitation', 'token', 'none']).optional(),
};

/**
 * Runs a mutation through the guard and maps every decision to a tool result.
 *
 * - refused            -> isError:true, text names the reason and the variable to change
 * - dry_run            -> structured preview, nothing executed
 * - needs_confirmation -> structured preview + token; text tells the model to surface it to the human
 * - proceed            -> `execute` runs, guard.commit records the outcome, result merged into structured
 *
 * `execute` must NOT catch errors itself; a throw is recorded as `outcome: 'error'` and returned
 * as an actionable tool error.
 */
export async function runMutation<T extends Record<string, unknown>>(
  ctx: ToolContext,
  req: MutationRequest,
  extra: RequestExtra | undefined,
  execute: (decision: ProceedDecision) => Promise<T>,
  summarise?: (result: T, decision: ProceedDecision) => string,
): Promise<ToolResult> {
  const decision = await ctx.guard.check(req, extra);
  switch (decision.action) {
    case 'refused': {
      const text = decision.variable
        ? `${decision.reason} (variable: ${decision.variable})`
        : decision.reason;
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          status: 'refused',
          server: req.server,
          reason: decision.reason,
          ...(decision.variable ? { variable: decision.variable } : {}),
          preview: req.preview,
        },
        isError: true,
      };
    }
    case 'dry_run':
      return ok(
        { status: 'dry_run', server: req.server, preview: decision.preview },
        `DRY RUN — nothing changed. ${req.tool} on ${req.server} would do:\n` +
          JSON.stringify(decision.preview, null, 2),
      );
    case 'needs_confirmation':
      return ok(
        {
          status: 'needs_confirmation',
          server: req.server,
          preview: decision.preview,
          confirmation_token: decision.confirmation_token,
          expires_in_s: decision.expires_in_s,
          message: decision.message,
        },
        decision.message,
      );
    case 'proceed': {
      try {
        const result = await execute(decision);
        await decision.commit('success', result);
        // Guard-owned fields are spread LAST: a tool result carrying its own `status`,
        // `server` or `backup_id` must not be able to relabel what the guard decided.
        const structured = {
          ...result,
          status: 'success' as const,
          server: req.server,
          preview: req.preview,
          confirmed_via: decision.confirmedVia,
          ...(decision.backupId ? { backup_id: decision.backupId } : {}),
        };
        const summary = summarise ? summarise(result, decision) : `${req.tool} succeeded on ${req.server}.`;
        const backupNote = decision.backupId ? `\nPre-change backup: ${decision.backupId}` : '';
        return ok(structured, summary + backupNote);
      } catch (err) {
        await decision.commit('error', { error: toActionableMessage(err) });
        return fail(err);
      }
    }
  }
}
