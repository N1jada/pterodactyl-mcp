# Design spec: Pterodactyl MCP Server

The original requirements this project was built against. Section numbers are
referenced from code comments and tests (e.g. "SPEC §7" for the safety layers).
The README describes what was actually built where it differs.

**Goal:** An MCP server that exposes a Pterodactyl-hosted game server's control
panel as tools, so an agent can inspect, diagnose and operate the server
conversationally.

---

## 1. Context

Pterodactyl Panel is a widely used game-server control panel. Everything worth
automating on a hosted server — status, console, files, power, backups — is already
exposed through Pterodactyl's Client API; this project exposes it as MCP tools.

**Build it generic.** Panel URL and server ID come from config, not hardcoded.
It should work against any Pterodactyl panel. The design was driven by a Minecraft
(Paper + Geyser/Floodgate) server, which is why many examples reference Minecraft
paths, but nothing in the code depends on that.

Representative tasks an operator should be able to hand to an agent:

- "Is the server up, and what's the memory doing?"
- "Something's wrong — pull the recent console output and tell me what's failing."
- "Check whether Geyser actually bound to its Bedrock port on the last boot."
- "Take a backup before I change the config."
- "Show me the Geyser config and change the Bedrock MOTD."
- "Restart the server."

---

## 2. Before writing any code

Load these in order. Do not skip the skill — it defines the quality bar.

1. **The MCP builder skill** (`mcp-builder`, `SKILL.md`) plus its
   reference files, particularly `reference/mcp_best_practices.md` and
   `reference/node_mcp_server.md`.
2. **TypeScript SDK README**:
   `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md`
3. **MCP spec**: start at `https://modelcontextprotocol.io/sitemap.xml`, fetch
   relevant pages with a `.md` suffix.
4. **Pterodactyl Client API docs.** Two community references, both good:
   - `https://pterodactyl-api-docs.netvpx.com/docs/api/client`
   - `https://pteroapi.com/docs/api/client/servers`

> **Important:** the endpoint paths and payload shapes below were not verified up front.
> Treat the tool list in §5 as the intended capability surface, not as verified
> API contracts. Confirm each endpoint against the docs above — and where the docs
> are ambiguous, against `routes/api-client.php` in the `pterodactyl/panel` repo,
> which is authoritative. If an endpoint doesn't exist or behaves differently,
> adapt and note it in the README rather than forcing the shape below.

---

## 3. Stack

- **Language:** TypeScript
- **Transport:** stdio (this is a local, single-user server — no need for HTTP)
- **Schemas:** Zod for inputs; define `outputSchema` and return `structuredContent`
  wherever the response is structured
- **HTTP:** native `fetch`
- **Testing:** MCP Inspector (`npx @modelcontextprotocol/inspector`)

Tool naming convention: `ptero_` prefix, action-oriented, e.g.
`ptero_get_server_resources`, `ptero_send_console_command`.

---

## 4. Auth and configuration

Client API keys are generated in the panel under **Account → API Credentials**.
Requests are:

```
Authorization: Bearer <PTERODACTYL_API_KEY>
Accept: Application/vnd.pterodactyl.v1+json
Content-Type: application/json
```

Base path is `<PANEL_URL>/api/client`.

Config via environment variables — **never** commit or log the key:

| Variable | Required | Notes |
|---|---|---|
| `PTERODACTYL_PANEL_URL` | yes | e.g. `https://panel.example.com` |
| `PTERODACTYL_API_KEY` | yes | Client API key |
| `PTERODACTYL_DEFAULT_SERVER` | no | Short ID used when a tool call omits one |

The guard variables (`PTERODACTYL_READ_ONLY`, `PTERODACTYL_ALLOWED_SERVERS`,
`PTERODACTYL_ALLOW_DELETE`, `PTERODACTYL_ALLOW_KILL`, `PTERODACTYL_PROTECTED_PATHS`,
`PTERODACTYL_MAX_MUTATIONS`, `PTERODACTYL_AUTO_BACKUP`, `PTERODACTYL_AUDIT_LOG`) are
specified in §7. They are not optional extras — build the guard module in Phase 1,
before any mutating tool exists, so later phases have nowhere to bypass it.

Ship a `.env.example`. Add `.env` to `.gitignore` in the first commit.

**Rate limiting:** the Client API allows 240 requests/minute per key and returns
`X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers. Read
those in the shared client, and on a 429 return an actionable error naming the
reset time rather than blindly retrying.

---

## 5. Tool surface

Prioritise coverage over cleverness. Group into phases so they can be built in
parallel worktrees.

### Phase 1 — Read-only core

Get this working end to end first. It's the highest-value, lowest-risk slice.

| Tool | Purpose |
|---|---|
| `ptero_list_servers` | Servers the key can access |
| `ptero_get_server` | Details for one server: name, node, limits, allocations, state |
| `ptero_get_server_resources` | Current CPU, memory, disk, network, uptime, power state |

All `readOnlyHint: true`.

### Phase 2 — Console

The interesting one, and the awkward one. See §6.

| Tool | Purpose |
|---|---|
| `ptero_get_console_log` | Recent console output as text |
| `ptero_send_console_command` | Send a command to the running server |

`ptero_send_console_command` is **not** read-only and **not** idempotent. Mark it
accordingly.

### Phase 3 — Files

| Tool | Purpose |
|---|---|
| `ptero_list_files` | Directory listing, relative to server root |
| `ptero_read_file` | File contents |
| `ptero_write_file` | Write/overwrite a file |
| `ptero_rename_file` / `ptero_copy_file` / `ptero_delete_file` | Standard ops |

`ptero_read_file` needs a size guard — refuse anything over a sane threshold with a
message suggesting the caller narrow the request, rather than dumping a 50MB world
file into context.

`ptero_delete_file` is destructive. Mark `destructiveHint: true`.

### Phase 4 — Power and lifecycle

| Tool | Purpose |
|---|---|
| `ptero_set_power_state` | `start` / `stop` / `restart` / `kill` |

`kill` is a hard stop and risks world corruption. Treat it as destructive and make
the tool description say so explicitly, so the calling model knows to prefer `stop`.

### Phase 5 — Backups, schedules, network, startup

| Tool | Purpose |
|---|---|
| `ptero_list_backups` / `ptero_create_backup` / `ptero_delete_backup` | Backup management |
| `ptero_get_backup_download_url` | Generates a signed download link |
| `ptero_list_schedules` | Read scheduled tasks |
| `ptero_list_allocations` | Ports assigned to the server |
| `ptero_get_startup_variables` | Startup config and egg variables |

Backup deletion is destructive and irreversible. Backup *creation* is safe and is
the natural thing for an agent to do before any risky change — make that clear in
the description of the mutating tools.

---

## 6. The console problem — read this before starting Phase 2

Pterodactyl does not expose console history over plain REST. The console is a
**WebSocket** on Wings, and getting to it is a two-step dance:

1. `GET /api/client/servers/<id>/websocket` on the panel returns a short-lived JWT
   and a socket URL.
2. Connect to that socket, authenticate with the token, and receive events.

Consequences you need to design around:

- **Tokens expire.** They're short-lived and the socket will tell you when. Handle
  re-authentication rather than letting the connection die mid-read.
- **There is no "give me the last N lines" request.** You connect and receive a
  backlog plus a live stream. `ptero_get_console_log` therefore needs to connect,
  collect for a bounded window or until a line budget is hit, disconnect, and
  return. Make the window and max-lines configurable parameters with sensible
  defaults.
- **Buffer size is limited.** In practice, an hour after boot the panel's
  console buffer has usually already rolled past the plugin startup lines. If a caller
  needs boot-time output, the honest answer is to point them at
  `ptero_read_file` on `logs/latest.log`, which has the full history. **Say this
  in the tool description** — it's exactly the kind of thing an agent will
  otherwise get wrong and then confidently report a wrong conclusion.
- **Command output is asynchronous.** Sending a command via the socket doesn't
  return its output. `ptero_send_console_command` should be honest about this:
  it confirms dispatch, and the caller must read the console separately to see
  the result. Do not fake a request/response shape.

---

## 7. Safety and guardrails — belt and braces

This server can stop a live service and delete files, and the thing calling it is a
language model that will occasionally be confidently wrong. Annotations alone are
not enough: they are advisory, and a client is free to ignore them.

**Framing, so this doesn't get oversold.** None of what follows is a security
boundary. Anyone holding the API key can do all of this through the panel UI
anyway. This is protection against *mistakes* — an agent misreading a situation,
acting on a stale assumption, or over-interpreting a vague instruction. Design for
that threat model, not for a hostile operator.

Five layers. Each is independently sufficient to prevent a given class of accident.

### Layer 1 — Configuration boundaries

Hard limits set at startup that no tool call can talk its way past. Implement as a
single shared guard module consulted by every mutating tool, not per-tool checks.

| Variable | Default | Effect |
|---|---|---|
| `PTERODACTYL_READ_ONLY` | `false` | When true, every mutating tool refuses |
| `PTERODACTYL_ALLOWED_SERVERS` | unset | Comma-separated allowlist; unset means the default server only |
| `PTERODACTYL_ALLOW_DELETE` | `false` | File and backup deletion refuse unless explicitly enabled |
| `PTERODACTYL_ALLOW_KILL` | `false` | `kill` power action refuses unless explicitly enabled |
| `PTERODACTYL_PROTECTED_PATHS` | see below | Glob patterns that write and delete tools refuse to touch |
| `PTERODACTYL_MAX_MUTATIONS` | `20` | Mutating calls per process lifetime; refuse past this |

Sensible `PROTECTED_PATHS` default: `world/**`, `world_nether/**`,
`world_the_end/**`, `server.properties`, `ops.json`, `whitelist.json`,
`banned-*.json`. A world directory deleted through a file tool is not recoverable
without a backup, and that is the single worst outcome this server could produce.

Refusals must name the variable that caused them, so the operator knows which knob to turn:
"Refused: `world/region/r.0.0.mca` matches a protected path. Set
`PTERODACTYL_PROTECTED_PATHS` to override."

### Layer 2 — Human confirmation in the loop

Two mechanisms. Implement both; select at runtime.

**Preferred: MCP elicitation.** The spec (2025-06-18 edition onward) provides
`elicitation/create`, letting the server pause tool execution and request
structured input from the user via the client. Declare the capability during
`initialize` and check whether the client declared support back. When it has, use
it for every destructive operation: present what's about to happen and require an
explicit confirm.

Note the spec is clear that elicitation must not be used to request credentials or
PII. We're only ever asking for a yes/no, so that's fine — but don't drift.

**Fallback: two-phase confirmation token.** Client support for elicitation is
uneven, so this must work when elicitation is unavailable. Pattern:

1. Destructive tool called without a `confirmation_token` parameter. It does *not*
   act. It returns a preview — exactly what would change, which server, which
   paths, how many files — plus a token.
2. Caller calls again with the token to execute.

The token must be:

- **Generated server-side**, cryptographically random, never derivable by the
  caller.
- **Bound to a hash of the exact call** (tool name + server ID + normalised
  arguments). If any argument differs on the second call, reject it. This is the
  part that matters: without binding, a model can preview a harmless operation and
  then confirm a different one.
- **Single use** and **short-lived** (120 seconds).
- **In-memory only.** Never persisted to disk.

The point of the two-phase pattern is not that it's unbypassable — the model can
call twice. It's that the preview lands in the conversation where the human can see it, and
the second call is a deliberate act rather than a side effect. Say this plainly in
the tool descriptions so the calling model understands the preview is *for the
human*, and should be surfaced rather than silently round-tripped.

### Layer 3 — Pre-flight protection

- **Automatic backup before destructive change.** Controlled by
  `PTERODACTYL_AUTO_BACKUP` (default `true`). Before any file write, file delete or
  `kill`, trigger `ptero_create_backup` and wait for it to register. If the backup
  fails, **abort the operation** rather than proceeding — a failed backup is a
  signal, not an inconvenience. Include the backup ID in the tool response so a
  rollback path is visible.
- **`dry_run` parameter on every mutating tool**, defaulting to `false`. When true,
  return the full preview and change nothing. Gives the agent a way to reason about
  an operation without committing to it.

### Layer 4 — Blast radius limits

- Power actions: reject a second one within 30 seconds. Stops restart loops.
- Bulk delete: refuse a delete resolving to more than 10 files in one call, with a
  message saying to narrow the pattern. There is no legitimate reason for this
  server to remove a hundred files at once.
- `MAX_MUTATIONS` per process, per Layer 1.

### Layer 5 — Audit trail

Append-only JSONL at `PTERODACTYL_AUDIT_LOG` (default
`~/.pterodactyl-mcp/audit.jsonl`). One line per mutating call — attempted, refused
*and* succeeded:

```json
{"ts":"...","tool":"ptero_delete_file","server":"1a2b3c4d","args":{...},
 "confirmed_via":"elicitation","outcome":"success","backup_id":"..."}
```

Never write the API key, websocket JWT, or signed backup URLs into it. Redact any
argument named like a secret before logging.

### Deployment recommendation

Register the server twice in Claude Code with different configs: a read-only
profile for day-to-day inspection, and a second full-access profile enabled only
when deliberately doing maintenance. Document both in the README, with the
read-only one presented as the default. Most of what this is for is diagnosis,
and diagnosis needs no write access at all.

### General error handling

- Annotate every tool honestly (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`).
- Never log the API key, the websocket JWT, or backup download URLs.
- Errors must be actionable: "Server `abc123` not found — call
  `ptero_list_servers` to see available IDs" beats "404".
- If the panel returns HTML instead of JSON, the key is wrong or the path is off.
  Detect it and say so, rather than surfacing a JSON parse error.


---

## 8. Deliverables

1. Working TypeScript MCP server, builds clean with `npm run build`.
2. `README.md`: setup, env vars, how to generate a Pterodactyl API key, how to
   register the server with Claude Code, and a table of tools with their
   annotations.
3. `.env.example`.
4. Tested against MCP Inspector — every tool invoked at least once.
5. **Guard tests.** Unit tests covering, at minimum: read-only mode blocks every
   mutating tool; a protected path is refused; a confirmation token bound to one
   set of arguments is rejected when replayed with different arguments; a token is
   rejected on second use; a token is rejected after expiry; a failed auto-backup
   aborts the operation. These are the assertions that make the guard real rather
   than decorative — do not ship without them.
6. Per Phase 4 of the mcp-builder skill: an evaluation XML with 10 read-only
   questions. Base them on real diagnostic tasks, e.g. "What port is the Bedrock
   listener bound to?" (discoverable via
   `ptero_read_file` on `plugins/Geyser-Spigot/config.yml`).

---

## 9. Suggested worktree split

Phase 1 must land first — everything shares its API client **and the §7 guard
module**. Build the guard before the first mutating tool exists, so phases 3, 4 and
5 are written against it rather than retrofitted with it. After Phase 1, phases 3,
4 and 5 are independent and parallelise cleanly. Phase 2 is the long pole and
should get its own worktree and its own attention; don't let it block the others.

---

## 10. Explicitly out of scope

- **Pterodactyl Application API** (admin-level: users, nodes, server creation).
  Client API only.
- **Minecraft Server Management Protocol.** Worth knowing this exists: a JSON-RPC
  2.0 API over WebSocket added across the 1.21.9 / 1.21.11 cycles, giving typed
  access to players, allowlist, operators, settings and game rules plus push
  notifications — a proper replacement for RCON. `rpc.discover` returns a schema
  you could generate tools from, which makes it a very natural second MCP server.
  Not now, for two reasons: it needs a third port allocation, and
  `management-server-tls-enabled` defaults to `true` such that enabling it without
  a keystore stops the whole Minecraft server from booting.
- **RCON.** Superseded by the above.
- **Anything Geyser-specific.** Geyser config is just a file; Phase 3 covers it.

---

## 11. Open questions

Flag these rather than guessing:

- Whether the host has restricted any Client API endpoints. Some hosts disable
  parts of the panel. If something 403s consistently, that's likely why.
- Whether a panel extension framework (e.g. Blueprint) adds or alters any
  endpoints. Worth a look if something behaves unexpectedly.
