# Architecture contract — pterodactyl-mcp

This is the shared contract all phases build against. Read it fully before touching code.
The design spec (`SPEC.md`) is the source of requirements; this
document fixes *how* they are laid out so parallel work merges cleanly.

## Layout

```
pterodactyl-mcp/
  package.json            ESM, "type": "module", bin: { "pterodactyl-mcp": "dist/index.js" }
  tsconfig.json           NodeNext, strict, target ES2022, outDir dist
  vitest.config.ts
  .env.example
  README.md
  src/
    index.ts              entrypoint: load config, build deps, register all tools, connect stdio
    config.ts             parse env → Config (frozen). Validation errors are fatal & actionable.
    client.ts             PteroClient: fetch wrapper for /api/client. Rate-limit + error mapping.
    errors.ts             PteroError hierarchy + toToolError() helper
    guard.ts              Guard: ALL safety layers (§7). Single module. No per-tool checks.
    audit.ts              AuditLog: append-only JSONL with secret redaction
    confirm.ts            Confirmation: elicitation-or-token two-phase flow (used by guard)
    console/
      websocket.ts        WingsSocket: connect, auth, re-auth, event stream, bounded collect
    tools/
      _shared.ts          registerTool helper, common Zod fragments (serverId, dry_run, confirmation_token), result builders
      servers.ts          Phase 1: ptero_list_servers, ptero_get_server, ptero_get_server_resources
      console.ts          Phase 2: ptero_get_console_log, ptero_send_console_command
      files.ts            Phase 3: ptero_list_files, ptero_read_file, ptero_write_file, ptero_upload_file, ptero_rename_file, ptero_copy_file, ptero_delete_file
      power.ts            Phase 4: ptero_set_power_state
      backups.ts          Phase 5: ptero_list_backups, ptero_create_backup, ptero_delete_backup, ptero_get_backup_download_url
      misc.ts             Phase 5: ptero_list_schedules, ptero_list_allocations, ptero_get_startup_variables
  test/
    guard.test.ts         the mandatory guard tests (§8.5)
    confirm.test.ts
    client.test.ts
    audit.test.ts
    tools/*.test.ts       per-phase tool tests with a mocked PteroClient
  evals/
    evaluation.xml        10 read-only eval questions against the mock panel (mcp-builder Phase 4 format)
```

One file per phase under `src/tools/`. Each exports exactly one function:

```ts
export function registerXxxTools(ctx: ToolContext): void
```

`src/index.ts` calls each in order. Nobody edits another phase's file.

## Shared types (`src/tools/_shared.ts`)

```ts
export interface ToolContext {
  server: McpServer;          // from @modelcontextprotocol/sdk
  client: PteroClient;
  guard: Guard;
  config: Config;
  audit: AuditLog;
}
```

Common Zod fragments (import, do not redefine):

- `serverIdSchema` — `z.string().optional()` described as "Server short identifier (e.g. 1a2b3c4d). Omit to use PTERODACTYL_DEFAULT_SERVER."
- `dryRunSchema` — `z.boolean().default(false)`
- `confirmationTokenSchema` — `z.string().optional()` with the description explaining the two-phase pattern is *for the human*: surface the preview, do not silently round-trip.
- `resolveServer(ctx, input.server)` → string. Throws actionable error if none configured.

Result helpers:

- `ok(structured: T, text?: string)` → `{ content: [{type:'text', text}], structuredContent: structured }`
- `fail(err: unknown)` → `{ content:[{type:'text', text: actionableMessage}], isError: true }`

Every tool handler: `try { ... return ok(...) } catch (e) { return fail(e) }`. Never throw out of a handler.

## Config (`src/config.ts`)

```ts
interface Config {
  panelUrl: string;              // PTERODACTYL_PANEL_URL, trailing slash stripped
  apiKey: string;                // PTERODACTYL_API_KEY — never logged, never in error messages
  defaultServer?: string;        // PTERODACTYL_DEFAULT_SERVER
  readOnly: boolean;             // PTERODACTYL_READ_ONLY        default false
  allowedServers: string[];      // PTERODACTYL_ALLOWED_SERVERS  default [defaultServer] if set, else []
  allowDelete: boolean;          // PTERODACTYL_ALLOW_DELETE     default false
  allowKill: boolean;            // PTERODACTYL_ALLOW_KILL       default false
  protectedPaths: string[];      // PTERODACTYL_PROTECTED_PATHS  default per spec §7 L1
  maxMutations: number;          // PTERODACTYL_MAX_MUTATIONS    default 20
  autoBackup: boolean;           // PTERODACTYL_AUTO_BACKUP      default true
  auditLog: string;              // PTERODACTYL_AUDIT_LOG        default ~/.pterodactyl-mcp/audit.jsonl
  maxReadBytes: number;          // PTERODACTYL_MAX_READ_BYTES   default 512*1024 (file read guard)
}
```

Booleans parse `1/true/yes/on` (case-insensitive) as true. `loadConfig(env = process.env)` is pure so tests can inject.

## Client (`src/client.ts`)

```ts
class PteroClient {
  constructor(opts: { panelUrl: string; apiKey: string; fetch?: typeof fetch })
  get<T>(path, query?)            // JSON
  post<T>(path, body?, query?)    // JSON body
  put<T>(path, body?)
  delete(path)
  getText(path, query?)           // raw text (file contents)
  postRaw(path, body: string, query?, contentType = 'text/plain')  // file write
  rateLimit(): { limit, remaining, resetAt } | undefined   // from last response headers
}
```

Rules:
- Base path `${panelUrl}/api/client`. Headers per spec §4.
- Non-2xx → throws `PteroApiError { status, code, detail, path }`. 404 message must suggest `ptero_list_servers`. 401/403 message must say the key may be wrong/insufficient and mention that some hosts restrict endpoints (§11). 429 message names the reset time from `X-RateLimit-Reset` and says do not retry before it. If the body is HTML (starts with `<` or content-type text/html) → `PteroHtmlResponseError` saying the key is wrong or the panel URL/path is off.
- `getText` for a 2xx returns the raw string; caller enforces size via `Content-Length` when present (do a HEAD-like check: files list gives `size` — read tool uses list first).
- Never log or include `apiKey` anywhere. Include `path` in errors.

## Guard (`src/guard.ts`) — the important one

Single entry point used by every mutating tool:

```ts
interface MutationRequest {
  tool: string;
  server: string;
  args: Record<string, unknown>;      // normalised, what will be executed
  kind: 'write' | 'delete' | 'power' | 'command' | 'backup_create' | 'backup_delete';
  paths?: string[];                    // file paths touched (relative to server root)
  powerSignal?: 'start'|'stop'|'restart'|'kill';
  fileCount?: number;                  // for bulk delete cap
  dryRun: boolean;
  confirmationToken?: string;
  preview: Record<string, unknown>;    // what will change; shown to the human
  destructive: boolean;                // needs confirmation (delete, kill, write to existing file? → see below)
  wantsAutoBackup: boolean;            // write/delete/kill → true
}

type GuardDecision =
  | { action: 'refused'; reason: string; variable?: string }
  | { action: 'dry_run'; preview }
  | { action: 'needs_confirmation'; preview; confirmation_token: string; expires_in_s: 120; message }
  | { action: 'proceed'; backupId?: string; confirmedVia: 'elicitation'|'token'|'none'; commit(outcome, extra?): Promise<void> }

class Guard {
  constructor(deps: { config; audit; confirm: Confirmation; createBackup: (server, name) => Promise<{uuid}>; now?: () => number })
  check(req: MutationRequest, extra: RequestHandlerExtra): Promise<GuardDecision>
}
```

`check()` runs the layers **in this order** and returns on first refusal:

1. **Layer 1 – config boundaries**: readOnly → refuse (`PTERODACTYL_READ_ONLY`). server not in allowedServers → refuse (`PTERODACTYL_ALLOWED_SERVERS`). kind delete/backup_delete && !allowDelete → refuse (`PTERODACTYL_ALLOW_DELETE`). powerSignal kill && !allowKill → refuse (`PTERODACTYL_ALLOW_KILL`). any path matches protectedPaths (minimatch, after normalising `./`, leading `/`, and `..` — a path containing `..` is refused outright) → refuse naming the path and `PTERODACTYL_PROTECTED_PATHS`. mutation count ≥ maxMutations → refuse (`PTERODACTYL_MAX_MUTATIONS`).
2. **Layer 4 – blast radius**: fileCount > 10 → refuse. kind power && last power action < 30 s ago → refuse naming seconds remaining. (Counted per process.)
3. **dry_run** → return `{action:'dry_run', preview}` with no side effects, no count increment, still audited with outcome `dry_run`.
4. **Layer 2 – confirmation** (only if `destructive`): if client supports elicitation → elicit yes/no with the preview; decline/cancel → refused (audited `outcome:'declined'`). Else token flow: no token → mint token bound to `sha256(tool + server + canonicalJSON(args))`, return `needs_confirmation`. Token present → verify (exists, not expired, not used, hash matches) else refuse with a specific reason (`expired`, `already used`, `arguments differ from preview`, `unknown token`); consume it.
5. **Layer 3 – auto backup** (only if `wantsAutoBackup && config.autoBackup`): call `createBackup(server, "pre-<tool>-<ISO ts>")`. Failure → refuse with "auto-backup failed: … Set PTERODACTYL_AUTO_BACKUP=false to proceed without one (not recommended)". Success → carry `backupId`.
6. Increment mutation counter, record power timestamp if kind power, return `proceed` with `commit()` which appends the audit line (`outcome: 'success' | 'error'`).

Every path through `check()` writes exactly one audit line (`attempted/refused/dry_run/needs_confirmation/declined`), and `commit()` writes the final one. Redact args whose key matches `/token|key|secret|password|jwt|url/i` (url covers signed download URLs).

Refusal text template: ``Refused: <reason>. Set `<VARIABLE>` to override.``

Which mutations are `destructive` (need confirmation): `ptero_delete_file`, `ptero_delete_backup`, `ptero_set_power_state` with `kill` or `stop`/`restart` (stop/restart drop players — confirm), `ptero_write_file` / `ptero_upload_file` when overwriting an existing file. `ptero_send_console_command`, `ptero_create_backup`, `ptero_rename_file`, `ptero_copy_file`, `ptero_write_file` / `ptero_upload_file` to a new path, and `start` are mutations (counted, audited, dry_run-able) but do not require confirmation.

## Confirmation (`src/confirm.ts`)

```ts
class Confirmation {
  constructor(opts: { server: McpServer; now?: () => number; ttlMs?: number /* 120_000 */; random?: () => string })
  clientSupportsElicitation(): boolean
  elicit(preview, extra): Promise<'accepted'|'declined'|'cancelled'>
  mint(bindingHash: string): { token: string; expiresAt: number }
  consume(token: string, bindingHash: string): { ok: true } | { ok: false; reason: 'unknown'|'expired'|'used'|'mismatch' }
  static bindingHash(tool: string, server: string, args: Record<string, unknown>): string   // sha256 of canonical JSON (sorted keys, confirmation_token & dry_run stripped)
}
```

Tokens: `crypto.randomBytes(24).toString('base64url')`. In-memory `Map`. Sweep expired on each mint.

## Console (`src/console/websocket.ts`)

```ts
class WingsSocket {
  constructor(deps: { client: PteroClient; server: string; WebSocketImpl?: typeof WebSocket })
  collectLogs(opts: { windowMs: number; maxLines: number }): Promise<{ lines: string[]; truncated: boolean; state?: string }>
  sendCommand(cmd: string): Promise<void>       // auth → send command → close
}
```

Uses Node 22's global `WebSocket`. Strip ANSI codes from console lines. Handle `token expiring`/`token expired` by fetching a fresh token and re-sending `auth` on the same socket. Per-call connection; nothing long-lived.

## Tool annotations (all tools)

| tool | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|
| ptero_list_servers, ptero_get_server, ptero_get_server_resources, ptero_get_console_log, ptero_list_files, ptero_read_file, ptero_list_backups, ptero_get_backup_download_url, ptero_list_schedules, ptero_list_allocations, ptero_get_startup_variables | true | false | true | false |
| ptero_send_console_command | false | true | false | false |
| ptero_write_file, ptero_upload_file | false | true | true | false |
| ptero_rename_file, ptero_copy_file | false | false | false | false |
| ptero_delete_file, ptero_delete_backup | false | true | true | false |
| ptero_set_power_state | false | true | false | false |
| ptero_create_backup | false | false | false | false |

`openWorldHint: false` everywhere — the panel is a closed, known system.

## Conventions

- Tool descriptions are written for the calling model: say what it does, when to use it, what it does *not* do, and name the alternative (e.g. console buffer vs `logs/latest.log`).
- Every structured tool defines `outputSchema` and returns `structuredContent` plus a human-readable text summary in `content`.
- Tests: vitest, no network. Mock `PteroClient` via the `fetch` injection point or a hand-written fake.
- No `console.log` anywhere (stdout is the MCP transport). Diagnostics go to `console.error`.
- Commit per phase with a clear message.
