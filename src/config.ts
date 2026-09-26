import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';

import { ConfigError } from './errors.js';

/**
 * Resolved, frozen server configuration. Built once at startup by `loadConfig`.
 *
 * `apiKey` is the only secret here. It is never logged, never audited, and never
 * included in an error message.
 */
export interface Config {
  /** PTERODACTYL_PANEL_URL, trailing slashes stripped. */
  panelUrl: string;
  /** PTERODACTYL_API_KEY. Never logged, never in error messages. */
  apiKey: string;
  /** PTERODACTYL_DEFAULT_SERVER — short identifier used when a tool call omits one. */
  defaultServer?: string;
  /** PTERODACTYL_READ_ONLY — when true every mutating tool refuses. Default false. */
  readOnly: boolean;
  /** PTERODACTYL_ALLOWED_SERVERS — allowlist. Defaults to `[defaultServer]` if set, else `[]`. */
  allowedServers: string[];
  /** PTERODACTYL_ALLOW_DELETE — file/backup deletion. Default false. */
  allowDelete: boolean;
  /** PTERODACTYL_ALLOW_KILL — the `kill` power signal. Default false. */
  allowKill: boolean;
  /** PTERODACTYL_PROTECTED_PATHS — globs write/delete tools refuse to touch. */
  protectedPaths: string[];
  /**
   * PTERODACTYL_UNPROTECTED_PATHS — globs carved back out of `protectedPaths`, e.g.
   * `world/datapacks/mypack/**` so a deploy profile can write one datapack without
   * unprotecting the world. Traversal and root refusals still apply. Default: none.
   */
  unprotectedPaths: string[];
  /** PTERODACTYL_MAX_MUTATIONS — mutating calls per process lifetime. Default 20. */
  maxMutations: number;
  /** PTERODACTYL_AUTO_BACKUP — back up before write/delete/kill. Default true. */
  autoBackup: boolean;
  /** PTERODACTYL_AUDIT_LOG — JSONL audit trail. Default `~/.pterodactyl-mcp/audit.jsonl`. */
  auditLog: string;
  /** PTERODACTYL_MAX_READ_BYTES — file-read size guard. Default 512 KiB. */
  maxReadBytes: number;
}

/**
 * Default `PTERODACTYL_PROTECTED_PATHS` (SPEC §7 Layer 1). A world directory
 * deleted through a file tool is unrecoverable without a backup — that is the single
 * worst outcome this server could produce, so the worlds are protected by default.
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = Object.freeze([
  'world/**',
  'world_nether/**',
  'world_the_end/**',
  'server.properties',
  'ops.json',
  'whitelist.json',
  'banned-*.json',
]);

/** Default audit log location, relative to the user's home directory. */
export const DEFAULT_AUDIT_LOG = '~/.pterodactyl-mcp/audit.jsonl';

/** Default file-read size guard: 512 KiB. */
export const DEFAULT_MAX_READ_BYTES = 512 * 1024;

/** Default mutating-call budget per process lifetime. */
export const DEFAULT_MAX_MUTATIONS = 20;

export type EnvLike = Record<string, string | undefined>;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function trimmed(env: EnvLike, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

/** Parse `1/true/yes/on` (case-insensitive) as true, `0/false/no/off` as false. */
export function parseBoolean(env: EnvLike, key: string, fallback: boolean): boolean {
  const value = trimmed(env, key);
  if (value === undefined) return fallback;
  const lower = value.toLowerCase();
  if (TRUE_VALUES.has(lower)) return true;
  if (FALSE_VALUES.has(lower)) return false;
  throw new ConfigError(
    `${key} must be one of 1/true/yes/on or 0/false/no/off (got "${value}"). ` +
      `Fix it in your MCP server env block or .env file.`,
    key,
  );
}

function parseInteger(env: EnvLike, key: string, fallback: number, min: number): number {
  const value = trimmed(env, key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min) {
    throw new ConfigError(
      `${key} must be an integer >= ${min} (got "${value}"). ` +
        `Remove it to use the default of ${fallback}.`,
      key,
    );
  }
  return parsed;
}

function parseList(env: EnvLike, key: string): string[] | undefined {
  const value = trimmed(env, key);
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Expand a leading `~` / `~/` to the current user's home directory. */
export function expandTilde(inputPath: string, home: string = homedir()): string {
  if (inputPath === '~') return home;
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return join(home, inputPath.slice(2));
  }
  return inputPath;
}

/**
 * Build the `Config` from environment variables. Pure — pass an `env` object in tests.
 * Throws `ConfigError` with an actionable message for anything missing or malformed;
 * `src/index.ts` treats that as fatal.
 */
export function loadConfig(env: EnvLike = process.env): Readonly<Config> {
  const panelUrlRaw = trimmed(env, 'PTERODACTYL_PANEL_URL');
  if (panelUrlRaw === undefined) {
    throw new ConfigError(
      'PTERODACTYL_PANEL_URL is not set. Set it to your Pterodactyl panel base URL, ' +
        'e.g. PTERODACTYL_PANEL_URL=https://panel.example.com (no trailing slash, no /api/client suffix). ' +
        'Add it to the `env` block of this server\'s entry in your MCP client config, or to a .env file.',
      'PTERODACTYL_PANEL_URL',
    );
  }

  const panelUrl = panelUrlRaw.replace(/\/+$/, '');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(panelUrl);
  } catch {
    throw new ConfigError(
      `PTERODACTYL_PANEL_URL is not a valid URL (got "${panelUrlRaw}"). ` +
        'It must include the scheme, e.g. https://panel.example.com',
      'PTERODACTYL_PANEL_URL',
    );
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new ConfigError(
      `PTERODACTYL_PANEL_URL must use http:// or https:// (got "${parsedUrl.protocol}//"). ` +
        'e.g. PTERODACTYL_PANEL_URL=https://panel.example.com',
      'PTERODACTYL_PANEL_URL',
    );
  }

  const apiKey = trimmed(env, 'PTERODACTYL_API_KEY');
  if (apiKey === undefined) {
    throw new ConfigError(
      'PTERODACTYL_API_KEY is not set. Generate a *Client* API key in the panel under ' +
        'Account -> API Credentials (it starts with `ptlc_`) and set PTERODACTYL_API_KEY to it. ' +
        'Application/admin keys are rejected on client routes. Never commit the key.',
      'PTERODACTYL_API_KEY',
    );
  }

  const defaultServer = trimmed(env, 'PTERODACTYL_DEFAULT_SERVER');

  // Unset allowlist means "the default server only" — an unset allowlist must never mean
  // "everything", or the guard's server boundary would be open by default.
  const allowedServers =
    parseList(env, 'PTERODACTYL_ALLOWED_SERVERS') ?? (defaultServer ? [defaultServer] : []);

  const protectedPaths =
    parseList(env, 'PTERODACTYL_PROTECTED_PATHS') ?? [...DEFAULT_PROTECTED_PATHS];
  const unprotectedPaths = parseList(env, 'PTERODACTYL_UNPROTECTED_PATHS') ?? [];

  const auditLogRaw = trimmed(env, 'PTERODACTYL_AUDIT_LOG') ?? DEFAULT_AUDIT_LOG;
  // A relative audit path is legal but surprising under a stdio server, whose cwd is
  // whatever the MCP client happened to launch it from — resolve it so the recorded
  // location is unambiguous.
  const expandedAuditLog = expandTilde(auditLogRaw);
  const auditLog = isAbsolute(expandedAuditLog)
    ? expandedAuditLog
    : resolve(process.cwd(), expandedAuditLog);

  const config: Config = {
    panelUrl,
    apiKey,
    ...(defaultServer !== undefined ? { defaultServer } : {}),
    readOnly: parseBoolean(env, 'PTERODACTYL_READ_ONLY', false),
    allowedServers,
    allowDelete: parseBoolean(env, 'PTERODACTYL_ALLOW_DELETE', false),
    allowKill: parseBoolean(env, 'PTERODACTYL_ALLOW_KILL', false),
    protectedPaths,
    unprotectedPaths,
    maxMutations: parseInteger(env, 'PTERODACTYL_MAX_MUTATIONS', DEFAULT_MAX_MUTATIONS, 0),
    autoBackup: parseBoolean(env, 'PTERODACTYL_AUTO_BACKUP', true),
    auditLog,
    maxReadBytes: parseInteger(env, 'PTERODACTYL_MAX_READ_BYTES', DEFAULT_MAX_READ_BYTES, 1),
  };

  return Object.freeze(config);
}
