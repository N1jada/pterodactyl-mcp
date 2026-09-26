# pterodactyl-mcp

[![CI](https://github.com/N1jada/pterodactyl-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/N1jada/pterodactyl-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![MCP](https://img.shields.io/badge/MCP-stdio-purple)

**Let an AI assistant look after your game server — safely.**

`pterodactyl-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server
that connects Claude (or any MCP client) to a server hosted on
[Pterodactyl Panel](https://pterodactyl.io). Ask about the server in plain language and
the assistant can check its status, read the console and log files, edit configs, take
backups and restart it — with guardrails that stop a confused model from deleting your
world.

It works with any Pterodactyl panel — self-hosted or a commercial host — using an
ordinary **Client API key** from your account page. No panel admin access or plugins
required.

Things you can ask:

- *"Is the server up, and what's the memory doing?"*
- *"Something's wrong — pull the recent console output and tell me what's failing."*
- *"Did Geyser actually bind to its Bedrock port on the last boot?"*
- *"Take a backup, then change the Bedrock MOTD in the Geyser config."*
- *"Upload this plugin jar and restart the server."*

## Features

- **20 tools** covering servers, live resources, console, files (including binary
  uploads), power, backups, schedules, network allocations and startup variables.
- **Read-only mode** for day-to-day diagnosis — register a second, write-enabled
  profile only for maintenance.
- **Human confirmation** before anything destructive, via MCP elicitation when your
  client supports it, or a single-use preview-and-confirm token when it doesn't.
- **Automatic backup** before file writes, deletes and `kill` — and the change is
  aborted if the backup fails.
- **Protected paths** (world folders, `server.properties`, `ops.json`, … by default)
  that write and delete tools refuse to touch.
- **Blast-radius limits** — per-process mutation budget, 10-file bulk-delete cap,
  30-second power cooldown.
- **Append-only audit log** of every attempted, refused and completed change, with
  secrets redacted.
- **Console-aware** — reads the Wings websocket, and tells the model to use
  `logs/latest.log` when the output it wants has already scrolled out of the buffer.

> **These guards protect against mistakes, not attackers.** Anyone holding the API key
> can do everything this server does directly in the panel. See
> [How mutations work](#how-mutations-work) for the full safety model.

## Contents

- [Quick start](#quick-start)
- [Generating a Pterodactyl Client API key](#generating-a-pterodactyl-client-api-key)
- [Configuration](#configuration)
- [Registering with Claude Code](#registering-with-claude-code) (and Claude Desktop)
- [Tools](#tools)
- [How mutations work](#how-mutations-work)
- [Console caveats](#console-caveats)
- [Known limitations](#known-limitations--open-questions)
- [Development](#development)

## Quick start

You need **Node.js 22 or newer** and a Pterodactyl **Client** API key
([how to get one](#generating-a-pterodactyl-client-api-key)).

**1. Build it**

```bash
git clone https://github.com/N1jada/pterodactyl-mcp.git
cd pterodactyl-mcp
npm install
npm run build
```

**2. Find your server's short ID** — it's the 8-character code in the panel URL when
you open the server, e.g. `https://panel.example.com/server/1a2b3c4d`.

**3. Register it with Claude Code** as a read-only profile (the safe default):

```bash
claude mcp add pterodactyl-ro \
  -e PTERODACTYL_PANEL_URL=https://panel.example.com \
  -e PTERODACTYL_API_KEY=ptlc_your_key_here \
  -e PTERODACTYL_DEFAULT_SERVER=1a2b3c4d \
  -e PTERODACTYL_READ_ONLY=true \
  -- node "$(pwd)/dist/index.js"
```

Then ask Claude *"What's the status of my server?"*. When you're ready to let it make
changes, add the [maintenance profile](#registering-with-claude-code) too. Using
Claude Desktop or another client? See [Claude Desktop](#claude-desktop) — any MCP
client that can launch a stdio server works.

**Want to try it without a real server?** A mock panel is included:

```bash
node test/mock-panel/server.mjs 4567 &    # fake panel on http://127.0.0.1:4567
npx @modelcontextprotocol/inspector --cli node dist/index.js \
  -e PTERODACTYL_PANEL_URL=http://127.0.0.1:4567 -e PTERODACTYL_API_KEY=mock-key \
  -e PTERODACTYL_DEFAULT_SERVER=1a2b3c4d \
  --method tools/call --tool-name ptero_get_server_resources
```

Or point any profile above at `http://127.0.0.1:4567` with the key `mock-key`.

## Generating a Pterodactyl Client API key

1. Log into the panel (e.g. `https://your-panel.example.com`).
2. Go to **Account → API Credentials**.
3. Create a new API key. This produces a **Client** key, prefixed `ptlc_...`.
4. Restricting **Allowed IPs** is optional — leave it blank unless you want to pin
   the key to the machine running this server.

> Use a *Client* key (`ptlc_...`), not an *Application* (admin) key. Application
> keys are for the Application API (users, nodes, server provisioning) and are
> rejected outright on every Client API route this server calls.

## Configuration

All configuration is environment variables, loaded once at startup by
`src/config.ts`. Values are frozen after load; restart the server to pick up
changes. Booleans accept `1/true/yes/on` and `0/false/no/off` (case-insensitive).

### Required

| Variable | Default | Effect |
|---|---|---|
| `PTERODACTYL_PANEL_URL` | — | Panel base URL, e.g. `https://panel.example.com`. No trailing slash, no `/api/client` suffix — that's appended internally. Must be `http://` or `https://`. |
| `PTERODACTYL_API_KEY` | — | The Client API key (`ptlc_...`) from above. Never logged, never audited, never included in an error message. |

### Optional

| Variable | Default | Effect |
|---|---|---|
| `PTERODACTYL_DEFAULT_SERVER` | unset | Server short identifier (e.g. `1a2b3c4d`) used when a tool call omits its `server` argument. |
| `PTERODACTYL_MAX_READ_BYTES` | `524288` (512 KiB) | Default largest file `ptero_read_file` will return; refuses larger files with a message suggesting the caller narrow the request or pass a larger `max_bytes`. A per-call `max_bytes` argument can override this, but is itself hard-capped at 4194304 bytes (4 MiB, the panel's own edit-size limit) regardless of how high this variable is set. |

### Guardrails

| Variable | Default | Effect |
|---|---|---|
| `PTERODACTYL_READ_ONLY` | `false` | When `true`, every mutating tool refuses outright. Recommended for the day-to-day profile. |
| `PTERODACTYL_ALLOWED_SERVERS` | unset | Comma-separated allowlist of server short IDs a mutating call may target. If unset **and** `PTERODACTYL_DEFAULT_SERVER` is also unset, the guard fails closed: **every** mutating call is refused, since there is no way to tell which server was meant to be in bounds. |
| `PTERODACTYL_ALLOW_DELETE` | `false` | File and backup deletion refuse unless this is `true`. |
| `PTERODACTYL_ALLOW_KILL` | `false` | The `kill` power signal refuses unless this is `true` (risks world corruption — it does not save before terminating). |
| `PTERODACTYL_PROTECTED_PATHS` | `world/**, world_nether/**, world_the_end/**, server.properties, ops.json, whitelist.json, banned-*.json` | Comma-separated glob patterns that write/delete tools refuse to touch. Matching is case-sensitive, backslashes are normalised to `/` first, and percent-encoded path segments are decoded (and re-checked) before matching, so a `%2e%2e` or `world%2Flevel.dat`-style argument can't slip past it. A path containing a `..` segment, or one that resolves to the server root (`""`, `/`, `.`, `./`), is always refused regardless of this list. **Setting this variable to an empty string does not disable protection** — an empty value is treated the same as unset and the built-in defaults still apply; to genuinely disable it you must supply a pattern that matches nothing. |
| `PTERODACTYL_UNPROTECTED_PATHS` | unset | Comma-separated globs carved back out of `PTERODACTYL_PROTECTED_PATHS`. A path that matches one of these is not refused by the protected-path check, so a deploy profile can open exactly `world/datapacks/mypack/**` without unprotecting the world. The `..` and server-root refusals still apply regardless, and every percent-decoding of the path must fall inside the exception. |
| `PTERODACTYL_MAX_MUTATIONS` | `20` | Mutating tool calls allowed per process lifetime; refuses once exhausted. Restart the process to reset the budget. |
| `PTERODACTYL_AUTO_BACKUP` | `true` | Take a backup automatically before any file write, file delete, or `kill`; **abort the operation** if the backup fails. |
| `PTERODACTYL_AUDIT_LOG` | `~/.pterodactyl-mcp/audit.jsonl` | Path to the append-only JSONL audit trail. Relative paths are resolved against the process's working directory. |

**Allowed-servers semantics** (`PTERODACTYL_ALLOWED_SERVERS`, per `src/config.ts` /
`src/guard.ts`):

- **Set** (comma-separated list): a mutating call is allowed only against a server
  short ID in that list.
- **Unset, but `PTERODACTYL_DEFAULT_SERVER` is set**: the allowlist defaults to
  `[defaultServer]` — mutations are restricted to that one server only.
- **Neither set**: the guard **fails closed** — every mutating call is refused
  with `PTERODACTYL_ALLOWED_SERVERS` named as the variable to set, because
  "which server may I change?" has to be answered deliberately rather than left
  open by omission. (Read-only tools are never restricted by this variable in
  any case; you always need an explicit `server` argument or a default to
  resolve which server a call targets at all.)

## Registering with Claude Code

Register the server **twice**, with different configs: a read-only profile for
day-to-day inspection, and a full-access profile you enable deliberately for
maintenance. Most diagnostic work needs no write access at all — treat
`pterodactyl-ro` as the default, and reach for `pterodactyl-admin` only when you
intend to change something.

Replace `/absolute/path/to/dist/index.js`, the panel URL, the API key, and the
server ID with your own values in every example below.

### `claude mcp add`

Read-only (default) profile:

```bash
claude mcp add pterodactyl-ro \
  -e PTERODACTYL_PANEL_URL=https://panel.example.com \
  -e PTERODACTYL_API_KEY=ptlc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  -e PTERODACTYL_DEFAULT_SERVER=1a2b3c4d \
  -e PTERODACTYL_READ_ONLY=true \
  -- node /absolute/path/to/dist/index.js
```

Full-access (maintenance) profile — `ALLOW_DELETE`/`ALLOW_KILL` are left `false`
here; turn them on only for the session where you actually need them:

```bash
claude mcp add pterodactyl-admin \
  -e PTERODACTYL_PANEL_URL=https://panel.example.com \
  -e PTERODACTYL_API_KEY=ptlc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  -e PTERODACTYL_DEFAULT_SERVER=1a2b3c4d \
  -e PTERODACTYL_AUTO_BACKUP=true \
  -e PTERODACTYL_ALLOW_DELETE=false \
  -e PTERODACTYL_ALLOW_KILL=false \
  -- node /absolute/path/to/dist/index.js
```

### `.mcp.json`

Equivalent project-level config (`.mcp.json` in your project root):

```json
{
  "mcpServers": {
    "pterodactyl-ro": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "PTERODACTYL_PANEL_URL": "https://panel.example.com",
        "PTERODACTYL_API_KEY": "ptlc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "PTERODACTYL_DEFAULT_SERVER": "1a2b3c4d",
        "PTERODACTYL_READ_ONLY": "true"
      }
    },
    "pterodactyl-admin": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "PTERODACTYL_PANEL_URL": "https://panel.example.com",
        "PTERODACTYL_API_KEY": "ptlc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "PTERODACTYL_DEFAULT_SERVER": "1a2b3c4d",
        "PTERODACTYL_AUTO_BACKUP": "true",
        "PTERODACTYL_ALLOW_DELETE": "false",
        "PTERODACTYL_ALLOW_KILL": "false"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pterodactyl-ro": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "PTERODACTYL_PANEL_URL": "https://panel.example.com",
        "PTERODACTYL_API_KEY": "ptlc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "PTERODACTYL_DEFAULT_SERVER": "1a2b3c4d",
        "PTERODACTYL_READ_ONLY": "true"
      }
    }
  }
}
```

Add a second `pterodactyl-admin` entry the same way as the `.mcp.json` example
above if you want the maintenance profile available in Desktop too.

## Tools

All tools are prefixed `ptero_`. `readOnlyHint`/`destructiveHint`/`idempotentHint`
are advisory annotations per the MCP spec — clients are free to ignore them, which
is exactly why the guard module (not annotations) is the real enforcement
mechanism for mutating tools. `openWorldHint` is `false` for every tool: the panel
is a closed, known system.

| Tool | Purpose | readOnly | destructive | idempotent | openWorld | Guarded by |
|---|---|---|---|---|---|---|
| `ptero_list_servers` | List servers this API key can access (identifier, node, primary allocation, limits). Call first when you don't know a server's identifier. | true | false | true | false | — (read-only) |
| `ptero_get_server` | Full static configuration for one server: limits, feature limits, allocations, SFTP host, Docker image, resolved startup command. | true | false | true | false | — (read-only) |
| `ptero_get_server_resources` | Live power state (running/offline/...) and current CPU, memory, disk, network, uptime. | true | false | true | false | — (read-only) |
| `ptero_get_console_log` | Recent console output collected from the Wings websocket over a bounded window. See [Console caveats](#console-caveats). | true | false | true | false | — (read-only) |
| `ptero_send_console_command` | Send a command to the running server's console. Confirms dispatch only — does not return the command's output. | false | true | false | false | `PTERODACTYL_READ_ONLY`, `PTERODACTYL_ALLOWED_SERVERS`, `PTERODACTYL_MAX_MUTATIONS`, `dry_run`. No confirmation prompt (not classified `destructive` by the guard) and no auto-backup. |
| `ptero_list_files` | Directory listing relative to the server root. | true | false | true | false | — (read-only) |
| `ptero_read_file` | Read a file's contents. Refuses files above `PTERODACTYL_MAX_READ_BYTES`. | true | false | true | false | — (read-only) |
| `ptero_write_file` | Write/overwrite a file. | false | true | true | false | `PTERODACTYL_READ_ONLY`, `PTERODACTYL_ALLOWED_SERVERS`, `PTERODACTYL_PROTECTED_PATHS`, `PTERODACTYL_MAX_MUTATIONS`, `PTERODACTYL_AUTO_BACKUP`. Confirmation is required only when overwriting an existing file; writing a new path does not require it. |
| `ptero_upload_file` | Upload a **binary** local file (plugin jar, zip, image) from the machine running this MCP server to the game server. The complement to `ptero_write_file`, which is text-only. | false | true | true | false | `PTERODACTYL_READ_ONLY`, `PTERODACTYL_ALLOWED_SERVERS`, `PTERODACTYL_PROTECTED_PATHS`, `PTERODACTYL_MAX_MUTATIONS`, `PTERODACTYL_AUTO_BACKUP`, plus a hard 64 MiB local-file cap. Confirmation is required only when the remote file already exists (or existence could not be determined). |
| `ptero_rename_file` | Rename/move a file. | false | false | false | false | `PTERODACTYL_READ_ONLY`, `PTERODACTYL_ALLOWED_SERVERS`, `PTERODACTYL_PROTECTED_PATHS`, `PTERODACTYL_MAX_MUTATIONS`. No confirmation, no auto-backup. |
| `ptero_copy_file` | Copy a file. | false | false | false | false | Same as `ptero_rename_file`. |
| `ptero_delete_file` | Delete one or more files. | false | true | true | false | `PTERODACTYL_READ_ONLY`, `PTERODACTYL_ALLOWED_SERVERS`, `PTERODACTYL_ALLOW_DELETE`, `PTERODACTYL_PROTECTED_PATHS`, `PTERODACTYL_MAX_MUTATIONS`, 10-file bulk-delete cap, `PTERODACTYL_AUTO_BACKUP`. Always requires confirmation. |
| `ptero_set_power_state` | `start` / `stop` / `restart` / `kill`. Prefer `stop` over `kill` — `kill` is a hard stop and risks world corruption. | false | true | false | false | `PTERODACTYL_READ_ONLY`, `PTERODACTYL_ALLOWED_SERVERS`, `PTERODACTYL_ALLOW_KILL` (for `kill` only), `PTERODACTYL_MAX_MUTATIONS`, 30-second power cooldown, `PTERODACTYL_AUTO_BACKUP` (for `kill` only). Confirmation required for `stop`/`restart`/`kill`; not for `start`. |
| `ptero_list_backups` | List backups for a server. | true | false | true | false | — (read-only) |
| `ptero_create_backup` | Create a backup. The natural thing to do before any risky change. | false | false | false | false | `PTERODACTYL_READ_ONLY`, `PTERODACTYL_ALLOWED_SERVERS`, `PTERODACTYL_MAX_MUTATIONS`. No confirmation prompt, no auto-backup-before-backup. |
| `ptero_delete_backup` | Delete a backup. Irreversible. | false | true | true | false | `PTERODACTYL_READ_ONLY`, `PTERODACTYL_ALLOWED_SERVERS`, `PTERODACTYL_ALLOW_DELETE`, `PTERODACTYL_MAX_MUTATIONS`. Always requires confirmation. |
| `ptero_get_backup_download_url` | Generate a signed, short-lived download URL for a backup. | true | false | true | false | — (read-only; the URL itself is a secret — see [How mutations work](#how-mutations-work)) |
| `ptero_list_schedules` | Read the server's scheduled tasks. | true | false | true | false | — (read-only) |
| `ptero_list_allocations` | List network allocations (ports) assigned to the server. | true | false | true | false | — (read-only) |
| `ptero_get_startup_variables` | Startup command template and egg (environment) variables. | true | false | true | false | — (read-only) |

The annotation columns match the `registerTool(...)` calls in `src/tools/*.ts`; a
structural test (`test/integration/guard-coverage.test.ts`) fails if a mutating tool
is ever registered without going through the guard.

### Tool parameters

Every input parameter for every registered tool, verified against
`src/tools/*.ts`, grouped by source file. `server` (short
identifier, optional, falls back to `PTERODACTYL_DEFAULT_SERVER`) is omitted
below since every tool takes it identically. For a mutating tool, "Guard" gives
the `MutationRequest` fields it sets — `kind`, `destructive`, `wantsAutoBackup`,
and any `paths`/`fileCount`/`powerSignal` — which drive the guard decisions
summarised in the table above.

#### Servers (`src/tools/servers.ts`)

- **`ptero_list_servers`**: `page` (integer ≥ 1, optional) — 1-based page number; omit for page 1.
- **`ptero_get_server`**: no parameters beyond `server`.
- **`ptero_get_server_resources`**: no parameters beyond `server`.

#### Console (`src/tools/console.ts`)

- **`ptero_get_console_log`**:
  - `window_seconds` (integer 1-60, default `5`) — collection window.
  - `max_lines` (integer 1-1000, default `400`) — stop early once reached. The node backlog alone is ~150 lines, so the default leaves room to observe streamed output too.
  - `filter` (string, optional) — regex if `filter` parses as one, else a case-insensitive substring match, applied after collection.
- **`ptero_send_console_command`**:
  - `command` (string, 1-4096 chars, single line, no `\r`/`\n`, trimmed, required).
  - `dry_run` (boolean, default `false`).
  - Guard: `kind: 'command'`, `destructive: false`, `wantsAutoBackup: false`, no `paths`. Note: its *annotations* declare `destructiveHint: true`, but the guard's own `destructive` flag is `false` — so, unlike every other tool where the two agree, this one dispatches with no confirmation prompt and no auto-backup despite the advisory hint.

#### Files (`src/tools/files.ts`)

- **`ptero_list_files`**: `directory` (string, default `/`).
- **`ptero_read_file`**:
  - `path` (string, min 1 char, required).
  - `max_bytes` (integer, 1 to 4194304, optional; defaults to `PTERODACTYL_MAX_READ_BYTES`).
  - `tail_lines` (integer ≥ 1, optional; mutually exclusive with `head_lines`).
  - `head_lines` (integer ≥ 1, optional; mutually exclusive with `tail_lines`).
- **`ptero_write_file`**:
  - `path` (string, min 1 char, required).
  - `content` (string, required) — replaces the entire file.
  - `dry_run` (boolean, default `false`).
  - `confirmation_token` (string, optional).
  - Guard: `kind: 'write'`, `paths: [path]`, `destructive` is `true` only when the file already exists (or existence couldn't be determined), `wantsAutoBackup: true`.
- **`ptero_upload_file`**:
  - `local_path` (string, min 1 char, required) — **absolute** path on the machine running the MCP server. The server reads the bytes itself; there is no way to pass content inline, and nothing is ever accepted as base64 through the model. Must be an existing, readable, regular file of at most **64 MiB** (`MAX_UPLOAD_BYTES` in `src/tools/files.ts`; Wings' own per-file default is 100 MB).
  - `remote_dir` (string, default `/`) — destination *directory* on the server, not a file path.
  - `remote_name` (string, min 1 char, optional; defaults to the basename of `local_path`) — a single file name, refused if it contains `/` or `\\`.
  - `dry_run` (boolean, default `false`).
  - `confirmation_token` (string, optional).
  - Guard: `kind: 'write'`, `paths: [remote_dir + remote_name]`, `destructive` is `true` only when the remote file already exists (or existence couldn't be determined), `wantsAutoBackup: true`.
- **`ptero_rename_file`**:
  - `root` (string, default `/`) — directory `from`/`to` are relative to.
  - `from` (string, min 1 char, required).
  - `to` (string, min 1 char, required).
  - `dry_run` (boolean, default `false`).
  - `confirmation_token` (string, optional).
  - Guard: `kind: 'write'`, `paths: [from_path, to_path]`, `destructive: false`, `wantsAutoBackup: false`.
- **`ptero_copy_file`**:
  - `path` (string, min 1 char, required).
  - `dry_run` (boolean, default `false`).
  - `confirmation_token` (string, optional).
  - Guard: `kind: 'write'`, `paths: [path]`, `destructive: false`, `wantsAutoBackup: false`.
- **`ptero_delete_file`**:
  - `root` (string, default `/`).
  - `files` (array of string, min 1 char each, at least 1 entry, required) — bare names relative to `root`; more than 10 is refused by the guard's bulk-file cap, not by this schema.
  - `dry_run` (boolean, default `false`).
  - `confirmation_token` (string, optional).
  - Guard: `kind: 'delete'`, `paths` = every resolved target, `fileCount: files.length`, `destructive: true`, `wantsAutoBackup: true`.

#### Power (`src/tools/power.ts`)

- **`ptero_set_power_state`**:
  - `signal` (enum `start | stop | restart | kill`, required).
  - `dry_run` (boolean, default `false`).
  - `confirmation_token` (string, optional).
  - `wait_seconds` (integer 0-60, default `0`) — poll every 2s after dispatch and report `state_after`.
  - Guard: `kind: 'power'`, `powerSignal: signal`, `destructive` = `signal !== 'start'`, `wantsAutoBackup` = `signal === 'kill'`, no `paths`.

#### Backups (`src/tools/backups.ts`)

- **`ptero_list_backups`**: `per_page` (integer 1-50, optional; the panel's own default is 20).
- **`ptero_create_backup`**:
  - `name` (string, max 191 chars, optional) — omit for a panel-assigned default name.
  - `ignored` (string, optional) — newline-separated glob patterns to exclude.
  - `wait` (boolean, default `true`) — block until the panel reports the backup complete (up to ~2 minutes) via `createBackupAndWait`; `false` returns immediately with just the `uuid`.
  - `dry_run` (boolean, default `false`).
  - Guard: `kind: 'backup_create'`, `destructive: false`, `wantsAutoBackup: false`, no `paths`. This tool has **no** `confirmation_token` parameter — it never needs one.
- **`ptero_delete_backup`**:
  - `backup_uuid` (string, required).
  - `dry_run` (boolean, default `false`).
  - `confirmation_token` (string, optional).
  - Guard: `kind: 'backup_delete'`, `destructive: true`, `wantsAutoBackup: false`, no `paths`.
- **`ptero_get_backup_download_url`**: `backup_uuid` (string, required). Not a mutating tool — it does not go through the guard or the audit log at all (see [How mutations work](#how-mutations-work)).

#### Schedules, allocations & startup (`src/tools/misc.ts`)

- **`ptero_list_schedules`**: no parameters beyond `server`.
- **`ptero_list_allocations`**: no parameters beyond `server`.
- **`ptero_get_startup_variables`**: no parameters beyond `server`.

### Uploading binaries (`ptero_upload_file`)

`ptero_write_file` posts a UTF-8 request body to the panel, so it cannot carry a jar or a
zip. Uploads take a different route, in two hops, both of which this tool performs for you:

1. `GET /api/client/servers/{id}/files/upload` at the **panel** (with the API key) returns
   `{"object":"signed_url","attributes":{"url":"https://<node>:<port>/upload/file?token=<jwt>"}}`.
   The JWT is scoped `FileUpload`, lives 15 minutes, and is **single-use** — so the tool
   mints a fresh one inside every upload and never stores or reuses one.
2. `POST <that url>&directory=<remote_dir>` goes straight to the **Wings node**, as
   `multipart/form-data` with the file in a field named `files` whose part filename is the
   name it will get on disk. The panel API key is deliberately *not* sent on this hop:
   Wings registers `/upload/file` outside its authorization middleware and authenticates
   from the `token` query parameter alone.

Wings answers a successful upload with an empty `200`. **That is a confirmation of receipt
and nothing more** — it does not tell you the file landed at the size you sent. Follow every
upload with `ptero_list_files` on `remote_dir` and compare the size against the `bytes` the
tool reports. (A new plugin jar also needs a server restart before it loads.)

The signed URL is a credential: like `ptero_get_backup_download_url`'s URL it is never
written to the audit log, and unlike that one it is never returned to the caller either.

## How mutations work

Every mutating tool routes through a single `Guard` before it does anything, and
returns one of four `status` values in its structured result:

- **`dry_run`** — you passed `dry_run: true`. Nothing changed; the response's
  `preview` shows what *would* happen. No confirmation token is issued and this
  does not count against `PTERODACTYL_MAX_MUTATIONS`.
- **`needs_confirmation`** — the operation is destructive and the connected MCP
  client does not support elicitation (see below). The response carries a
  `preview` of exactly what will change, and a `confirmation_token` that:
  - is generated server-side, cryptographically random, and never derivable by
    the caller;
  - is **bound to a hash of tool name + server ID + normalised arguments AND the
    resolved effect** (`kind`, the resolved `paths`, the power signal, and the
    effective file count) — changing any argument, or anything about what the
    call would actually touch, on the confirming call invalidates it;
  - is **single-use** and **expires after 120 seconds**;
  - lives **in memory only**, never persisted to disk, and is process-local: if the MCP
    client restarts the server between the two calls the token is unknown and a fresh
    preview is required.

  **This preview is for the human, not for the calling model to round-trip
  silently.** Surface it in your reply and wait for the user to approve before
  calling the tool again with `confirmation_token` set.
- **`refused`** — a guardrail blocked the call. The response names the specific
  reason and the environment variable that would need to change to allow it, e.g.
  `Refused: file deletion is disabled (variable: PTERODACTYL_ALLOW_DELETE)`.
- **`success`** — the change was made. If a pre-flight backup was taken, its ID
  appears as `backup_id` in the response, giving you a concrete rollback path.

**Elicitation vs. token fallback.** When the connected client declares the MCP
`elicitation` capability, destructive operations use `elicitation/create` instead
of the token dance: the server presents the preview through the client's native
confirmation UI and waits for an explicit accept/decline. Declining or dismissing
is treated as a refusal, and so is a client that never answers: an elicitation
that gets no response within 120 seconds (or whose request is aborted) times out
and is treated as **`cancelled`**, i.e. refused — never as an implicit accept. When
the client doesn't support elicitation, the two-phase token flow above is the
fallback — functionally equivalent, just surfaced as a normal tool response
instead of a UI prompt.

**Power actions** are rate-limited to one per 30 seconds, to stop restart loops —
a second power action inside that window is refused, naming the seconds
remaining.

**Bulk file deletes** are capped at 10 files per call. The guard checks
`max(fileCount, paths.length)` against that cap, so an under-reported or omitted
file count can't be used to sneak a larger operation past it — the number of
paths actually resolved is always a floor on the effective count. A delete that
resolves to more than 10 files either way is refused with a message to narrow
the pattern; there is no legitimate reason for this server to remove a hundred
files at once.

**`PTERODACTYL_MAX_MUTATIONS`** (default 20) is a budget of successful mutating
calls per **process lifetime** — restart the server to reset it. It exists so a
misbehaving agent loop can't run indefinitely.

**Pre-flight backup (Layer 3).** When a write, delete, or `kill` wants an
automatic backup (`PTERODACTYL_AUTO_BACKUP=true` and the tool sets
`wantsAutoBackup`), the guard calls `createBackupAndWait` and blocks the
destructive change until that backup has actually **completed** — not merely
been requested. The guard aborts the whole operation, refusing it outright,
if the backup: throws (including a panel-reported failure), does not report a
usable `uuid`, or does not complete within a hard 120-second timeout
(`BACKUP_TIMEOUT_MS` in `src/guard.ts`, matching `DEFAULT_TIMEOUT_MS` in
`src/backupWait.ts`) — a slow-but-eventually-successful backup does not get more
time. The wait also honours the calling request's own cancellation: if the MCP
client aborts the tool call while the backup is in flight, the guard stops
waiting and refuses rather than proceeding with the destructive change anyway.
This same instruction — prefer `stop` over `kill`, take a backup before risky
changes, and surface confirmation previews to the human rather than
round-tripping them automatically — is also given directly to the connected MCP
client via the server's `instructions` string in `src/index.ts`.

**Audit log.** Every mutating call appends one or more JSON lines — `dry_run`,
`needs_confirmation`, `declined`, `refused`, and, once a call actually proceeds,
an `attempted` line followed by a final `success` or `error` line — to
`PTERODACTYL_AUDIT_LOG` (default `~/.pterodactyl-mcp/audit.jsonl`). A write
failure is logged to stderr but never breaks the tool call. Example `success`
line for a `ptero_delete_file` call (root `plugins`, one file, confirmed via
token, with a pre-flight backup taken):

```json
{"ts":"2026-09-05T10:15:32.041Z","tool":"ptero_delete_file","server":"1a2b3c4d","kind":"delete","args":{"server":"1a2b3c4d","root":"/plugins","files":["old-plugin.jar"]},"dry_run":false,"outcome":"success","paths":["plugins/old-plugin.jar"],"file_count":1,"confirmed_via":"token","backup_id":"3f2a1e4b-9c1d-4a5e-8b2f-6d7e8f9a0b1c","root":"/plugins","files":["old-plugin.jar"],"deleted_count":1}
```

`args` is exactly what the tool put in its `MutationRequest.args` (here
`server`/`root`/`files`, not a `path` field — the shape differs per tool); the
trailing `root`/`files`/`deleted_count` come from the tool's own result being
merged onto the entry when the call commits. `AuditEntry` in `src/audit.ts`
formally declares only `ts`/`tool`/`server`/`args`/`kind`/`outcome`/`reason`/
`variable`/`confirmed_via`/`backup_id`/`error`; the `paths`, `power_signal`,
`file_count`, and per-tool result fields the guard also writes to every line are
additional properties beyond that declared TypeScript shape — accepted at
runtime (`AuditSink.append` takes a plain `Record<string, unknown>`), but worth
knowing about if you parse the JSONL against the `AuditEntry` type.

**Secrets are redacted from the audit log and from what's bound into a
confirmation token — not from a tool's own return value.** Before an entry is
persisted, any argument or field whose key matches
`/token|key|secret|password|passwd|jwt|url|auth|bearer|credential|cookie|session/i`
is replaced with `[REDACTED]`; this same key-based pattern is applied
independently in both `src/guard.ts` (for confirmation-token binding and
previews) and `src/audit.ts` (for what actually reaches disk). On top of that,
`AuditLog` also scrubs the literal *value* of the configured Pterodactyl API key
(and any other configured secret) out of the fully-serialised line, so an API
key pasted into, say, a console command argument is still caught even though its
key name (`command`) doesn't look secret. None of this touches what a tool
*returns to its caller*: `ptero_get_backup_download_url`, for instance,
deliberately returns the real signed URL in its result (that's the point of the
tool) — it just never reaches the audit trail, because that tool is read-only
and never goes through the guard at all.

## Console caveats

Pterodactyl doesn't expose console history over plain REST — the console is a
Wings **websocket**, reached via a short-lived JWT minted per-call. Consequences
that matter when using `ptero_get_console_log` / `ptero_send_console_command`:

- **The backlog buffer is small** — 150 lines by default (Wings'
  `system.websocket_log_count`, admin-configurable per node). An hour after boot,
  plugin startup output has typically already rolled out of it.
- **For anything from boot time, use `ptero_read_file` on `logs/latest.log`
  instead** — it has the full history the websocket buffer does not. This is the
  single most common mistake an agent will make here: querying the console for
  old output and confidently reporting "no such line" when it simply rolled off
  the buffer.
- **Command output is asynchronous.** `ptero_send_console_command` only confirms
  that the command was dispatched to the daemon — Wings does not correlate
  responses with the command that produced them. Read the console (or the log
  file) separately, afterward, to see what actually happened.

## Known limitations / open questions

- **Host-restricted endpoints.** Some hosts sit in front of Pterodactyl and disable
  parts of the Client API. A Client API call that consistently 403s may be a host
  restriction rather than a key or permission problem — the error text calls this
  out, but there is no way for this server to detect or work around it. If you hit
  this, check with your host.
- **Panel extensions.** Some panels run an extension framework (e.g. Blueprint) on
  top of Pterodactyl. Whether such extensions add or alter Client API endpoints is
  panel-specific — worth checking if something behaves unexpectedly.
- **Rate limit discrepancy.** Community docs for the Pterodactyl Client API
  describe a default of 240 requests/minute; the current `pterodactyl/panel`
  source (`1.0-develop`) defaults to 256/minute, admin-configurable via
  `APP_API_CLIENT_RATELIMIT`. This server does not hardcode either number — it
  reads `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` from
  response headers and, on a 429, reports the actual reset time rather than
  guessing. Treat the true limit as whatever your panel's own config sets.
- **Live verification.** Every read-only tool, and the mutating file, backup,
  upload and console-command tools, have been run against a real panel with
  `scripts/live-verify.mjs` and `scripts/live-verify-upload.mjs` (sequences on
  throwaway `mcp-throwaway-*` files at the server root that clean up after
  themselves): create, dry run, overwrite two-phase confirmation, token replay
  refusal, abort when the pre-flight backup hits the panel's backup limit, rename,
  copy, protected-path refusal, bulk delete with auto-backup, binary upload, and
  backup deletion. `ptero_set_power_state` has only been exercised by unit tests
  and the mock-panel smoke run. Both scripts read `.env` from the repo root and
  **mutate the configured server** — point them at a test server, never at one
  with players on it.
- **Uploading into a directory that does not exist yet always asks for confirmation.**
  `ptero_upload_file` decides create-vs-overwrite from a directory listing, and
  panels have been seen answering `GET /files/list` for a missing directory with a
  500 `UnexpectedValueException` (not a 404). The tool cannot tell "not there" from
  "could not look", so it reports `action: "unknown"` and requires confirmation — the
  intended fail-safe, not a bug. Wings itself creates the missing parent directories
  during the upload, so the upload does then succeed.
- **Backup limit interacts with auto-backup.** Many hosts give a server a small
  backup feature limit (sometimes just **1**). With `PTERODACTYL_AUTO_BACKUP=true`
  (the default) the first file write, delete or kill takes a slot; once the limit
  is reached the next destructive change will fail its pre-flight backup (the panel
  refuses to create another) and be aborted by design. Either delete an older
  backup first with `ptero_delete_backup`, take backups manually and set
  `PTERODACTYL_AUTO_BACKUP=false` for that session, or ask your host to raise the
  limit.

## Development

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm install
npm run build        # tsc -> dist/
npm test             # vitest — unit + integration tests, no network
npm run typecheck
```

### Testing with MCP Inspector

```bash
npm run inspector    # npx @modelcontextprotocol/inspector node dist/index.js
```

This opens the Inspector UI against the built server. Set the required env vars
(`PTERODACTYL_PANEL_URL`, `PTERODACTYL_API_KEY`, ...) in the Inspector's connection
form, or export them in your shell first.

For scripted checks use the Inspector CLI. Env vars must be passed with `-e` after the
command (they are not inherited), and array/boolean arguments need `--tool-args-json`:

```bash
npx --yes @modelcontextprotocol/inspector --cli node dist/index.js \
  -e PTERODACTYL_PANEL_URL=https://panel.example.com -e PTERODACTYL_API_KEY=ptlc_... \
  -e PTERODACTYL_DEFAULT_SERVER=1a2b3c4d \
  --method tools/call --tool-name ptero_list_files \
  --tool-args-json '{"directory":"/plugins"}' --format json
```

Each `--cli` invocation starts a fresh server process, so confirmation tokens, the
mutation budget and the power cooldown reset between calls. Two-phase flows therefore
need one long-lived process; `scripts/inspector-smoke.sh` (needs `jq`) shows how, and
runs every tool end to end against the mock panel in `test/mock-panel/`. Results of
that run are in `docs/INSPECTOR_RESULTS.md`.

### Design docs

- [`docs/SPEC.md`](docs/SPEC.md) — the original requirements and safety model.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module layout and shared contracts.
- [`docs/pterodactyl-api.md`](docs/pterodactyl-api.md) — the Client API and Wings
  websocket behaviour this server relies on.

### Layout

```
src/
  index.ts              entrypoint: load config, build deps, register all tools, connect stdio
  config.ts             parse env -> Config (frozen); actionable, fatal validation errors
  client.ts             PteroClient: fetch wrapper for /api/client, rate-limit + error mapping
  errors.ts             PteroError hierarchy + toActionableMessage() helper
  guard.ts              Guard: every safety layer, in one module — no per-tool checks
  audit.ts              AuditLog: append-only JSONL with secret redaction
  confirm.ts            Confirmation: elicitation-or-token two-phase flow (used by guard)
  console/
    websocket.ts         WingsSocket: connect, auth, re-auth, event stream, bounded collect
  tools/
    _shared.ts           registerTool helper, common Zod fragments, result builders, runMutation()
    servers.ts            ptero_list_servers, ptero_get_server, ptero_get_server_resources
    console.ts             ptero_get_console_log, ptero_send_console_command
    files.ts                ptero_list_files, ptero_read_file, ptero_write_file, ptero_upload_file, ptero_rename_file, ptero_copy_file, ptero_delete_file
    power.ts                 ptero_set_power_state
    backups.ts                ptero_list_backups, ptero_create_backup, ptero_delete_backup, ptero_get_backup_download_url
    misc.ts                    ptero_list_schedules, ptero_list_allocations, ptero_get_startup_variables
test/
  guard.test.ts, confirm.test.ts, client.test.ts, audit.test.ts, config.test.ts, tools/*.test.ts
evals/
  evaluation.xml        10 read-only eval questions against the mock panel (mcp-builder Phase 4 format)
```

Each `src/tools/*.ts` file exports exactly one `registerXxxTools(ctx: ToolContext)`
function, called once from `src/index.ts`.

### Adding a tool

1. Pick (or create) the `src/tools/*.ts` file for the relevant area.
2. Define Zod input/output schemas. Import the shared fragments from `_shared.ts`
   (`serverIdSchema`, `dryRunSchema`, `confirmationTokenSchema`) rather than
   redefining them — every tool that resolves a server or supports dry-run/
   confirmation should use the same shapes.
3. Register with `ctx.server.registerTool(name, { title, description, inputSchema,
   outputSchema, annotations }, handler)`. Write the description for the calling
   model: what it does, when to use it, what it does *not* do, and the
   alternative when relevant (the console-vs-`logs/latest.log` pattern in
   `console.ts` is the canonical example).
4. **Read-only tool:** call the client directly, wrap in `try { return ok(...) }
   catch (e) { return fail(e) }`, done.
5. **Mutating tool:** build a `MutationRequest` (tool, server, args, kind, paths,
   powerSignal, fileCount, dryRun, confirmationToken, preview, destructive,
   wantsAutoBackup) and pass it to `runMutation(ctx, req, extra, execute,
   summarise)` from `_shared.ts` — it handles every guard decision
   (`refused`/`dry_run`/`needs_confirmation`/`proceed`) and audit-commit for you.
   Never call the Pterodactyl API for a mutating effect outside of the `execute`
   callback passed to `runMutation`.
6. Set all four annotations explicitly (`readOnlyHint`, `destructiveHint`,
   `idempotentHint`, `openWorldHint: false`).
7. Register the new `registerXxxTools(ctx)` call in `src/index.ts`.
8. Add tests under `test/tools/` with a mocked `PteroClient` (see
   `test/tools/servers.test.ts` for the pattern) — no network in tests.
9. Exercise the new tool at least once with `npm run inspector`, and add it to the
   tables in this README.

## License

[MIT](LICENSE). Not affiliated with or endorsed by the Pterodactyl project.
