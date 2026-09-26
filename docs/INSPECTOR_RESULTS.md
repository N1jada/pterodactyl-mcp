# MCP Inspector results — SPEC §8.4 (docs/SPEC.md)

> "Tested against MCP Inspector — every tool invoked at least once."

**Status: 19/19 registered tools invoked, 41 checks, 0 failures.**

> **Addendum, 2026-09-08.** `ptero_upload_file` was added after this run. The smoke
> script now covers it (signed-URL + multipart create, sha256 match, presence on the
> panel filesystem, overwrite confirmation, unreadable-local-path error) and the
> `tools/list` assertion was raised from 19 to 20. Re-run on 2026-09-08:
> **20/20 tools invoked, 46 checks, 0 failures.** The per-check tables below still
> describe the original 2026-09-05 run and have not been rewritten.

Run date: 2026-09-05 · Node v22.23.2 · `@modelcontextprotocol/inspector` (latest via `npx`) ·
macOS (darwin 25.6.0) · bash 3.2.

No live Pterodactyl panel was available, so the whole surface was exercised against
`test/mock-panel/server.mjs` — an in-memory panel that speaks the exact envelopes in
`docs/pterodactyl-api.md`, including a Wings console websocket (§15).

---

## 1. How to run it

```bash
./scripts/inspector-smoke.sh          # exits 0 on success, 1 on any FAIL
```

The script builds, starts the mock panel on a free port, starts a persistent-session
bridge, invokes every tool, prints one `PASS`/`FAIL` line per invocation, dumps the audit
trail and then kills everything it started (including on Ctrl-C).

### The mock panel on its own

```bash
node test/mock-panel/server.mjs          # port 4567
node test/mock-panel/server.mjs 0        # free port; prints MOCK_PANEL_URL=... on stderr
```

Fixture state: one server `1a2b3c4d` "Survival" on node `eu-1` (memory 8192, disk 51200,
cpu 300; allocations `203.0.113.10:25565` default and `203.0.113.10:19132` notes "Geyser"),
resources `running` / 3.2 GiB / 42.5 % / 3 h uptime, a virtual filesystem
(`server.properties`, `ops.json`, `test.txt`, `plugins/Geyser-Spigot/config.yml`,
`plugins/floodgate/config.yml`, two plugin jars, `logs/latest.log` at 300 lines,
`world/level.dat`), two completed backups (one locked), one schedule with two tasks, and
four startup variables. Every `/api/client` route requires `Authorization: Bearer mock-key`
(anything else → 401 envelope), every response carries `X-RateLimit-*`, unknown routes
return the 404 envelope. `GET /__mock/state` (unauthenticated, outside `/api/client`) exposes
counters the smoke script asserts on — websocket auth frames, power state, virtual files.

### Exact Inspector CLI syntax that worked

Environment is **not** inherited by the spawned stdio server — it must be passed with `-e`,
and the `-e` flags go *after* the target command:

```bash
npx --yes @modelcontextprotocol/inspector --cli node dist/index.js \
  -e PTERODACTYL_PANEL_URL=http://127.0.0.1:51244 \
  -e PTERODACTYL_API_KEY=mock-key \
  -e PTERODACTYL_DEFAULT_SERVER=1a2b3c4d \
  -e PTERODACTYL_ALLOW_DELETE=true \
  -e PTERODACTYL_ALLOW_KILL=true \
  -e PTERODACTYL_AUDIT_LOG=/tmp/audit.jsonl \
  --method tools/list --format json
```

```bash
# tools/call — arguments as one JSON object (arrays/numbers/booleans survive verbatim)
npx --yes @modelcontextprotocol/inspector --cli node dist/index.js -e ... \
  --method tools/call \
  --tool-name ptero_delete_file \
  --tool-args-json '{"root":"/","files":["test.txt"]}' \
  --format json
```

Notes on the CLI:

- `--format json` puts exactly one JSON object on stdout (`{"result":{...}}` or
  `{"error":{...}}`); the server's own `console.error` banner and the schema-portability
  summary go to stderr. That makes `jq` parsing reliable.
- `--tool-arg key=value` is the alternative, but it coerces everything through
  string/number heuristics and has no natural spelling for `files: ["test.txt"]`.
  **`--tool-args-json` is the one to use for this server** — several tools take arrays,
  booleans and nested objects.
- `--method tools/list --strict` reports schema-portability problems in full and exits 6 on
  any error-severity one. This server: **0 errors, 25 warnings across 15 tools** (see
  finding **F4**).
- One `--method` per invocation. There is no way to chain two calls into one process.

### The persistent-session bridge (why it exists)

Each `inspector --cli` invocation spawns a **fresh** `node dist/index.js`. Three pieces of
guard state therefore reset on every call:

| State | Lives in | Consequence for `--cli` |
|---|---|---|
| `PTERODACTYL_MAX_MUTATIONS` budget | `Guard.mutations` | never reached; resets per call |
| 30 s power cooldown | `Guard.lastPowerAt` | never trips; resets per call |
| two-phase confirmation token | `Confirmation.tokens` (in-memory `Map`) | **phase 2 always fails with "unknown token"** |

Observed directly, two separate `--cli` calls:

```
call 1 → {"status":"needs_confirmation","confirmation_token":"VCp_hHoeRchMgJggrBq2y2tRkl0QCRcb", ...}
call 2 → "Refused: the confirmation token was rejected (unknown token); call
          `ptero_delete_file` again without a token to get a fresh preview."
```

That is correct, intended behaviour (a single-use in-memory token is the whole point) — it
just means the Inspector CLI alone cannot demonstrate a completed two-phase flow. The smoke
script therefore also starts a ~70-line Streamable-HTTP↔stdio bridge (written to its temp dir
at runtime, embedded as a heredoc in `scripts/inspector-smoke.sh`) that keeps **one**
`dist/index.js` alive behind `http://127.0.0.1:<port>/mcp`. Calls made through it use the
Inspector CLI unchanged:

```bash
npx --yes @modelcontextprotocol/inspector --cli \
  --transport http --server-url http://127.0.0.1:51245/mcp \
  --method tools/call --tool-name ptero_delete_file \
  --tool-args-json '{"root":"/","files":["test.txt"],"confirmation_token":"…"}' \
  --format json
```

This is the shape a real MCP client (Claude Code, Claude Desktop) has: one long-lived server
process across many tool calls, so the budget, the cooldown and the token all behave.

In the table below, **session** is `stdio` (fresh process per call) or `http` (shared,
long-lived process via the bridge).

---

## 2. Results

| # | Tool | Session | Args | Result | Observation |
|---|---|---|---|---|---|
| 1 | `tools/list` | stdio | — | **PASS** | 19 tools advertised, every name `ptero_*` |
| 2 | `tools/list --strict` | stdio | — | **PASS** | 0 error-severity schema problems; 25 warnings across 15 tools |
| 3 | `ptero_list_servers` | stdio | `{}` | **PASS** | 1 server, identifier `1a2b3c4d`, node `eu-1`, primary `203.0.113.10:25565` |
| 4 | `ptero_get_server` | stdio | `{"server":"1a2b3c4d"}` | **PASS** | name `Survival`, 8192 MiB memory, both allocations, invocation string |
| 5 | `ptero_get_server_resources` | stdio | `{}` | **PASS** | `current_state: running`, cpu 42.5 %, uptime 3 h |
| 6 | `ptero_list_files` | stdio | `{"directory":"/"}` | **PASS** | dirs first, then `ops.json`, `server.properties`, `test.txt` |
| 7 | `ptero_read_file` | stdio | `{"path":"plugins/Geyser-Spigot/config.yml"}` | **PASS** | full YAML returned; `port: 19132` and `motd2: "Bedrock welcome"` present |
| 8 | `ptero_read_file` | stdio | `{"path":"logs/latest.log","tail_lines":20}` | **PASS** | `lines_returned: 20`, `truncated_to: "last 20 of 300 lines"` |
| 9 | `ptero_read_file` (size guard) | stdio | `{"path":"plugins/Geyser-Spigot.jar"}` | **PASS** | refused before download: 11.0 MiB vs 512 KiB limit, with the three-option remedy text |
| 10 | `ptero_list_backups` | stdio | `{}` | **PASS** | both seeded backups, `is_locked` correct on one |
| 11 | `ptero_get_backup_download_url` | stdio | `{"backup_uuid":"7f0f1e64-…"}` | **PASS** | signed URL returned, flagged short-lived; never audited |
| 12 | `ptero_list_schedules` | stdio | `{}` | **PASS** | "Nightly restart" `0 5 * * *` with its 2 tasks |
| 13 | `ptero_list_allocations` | stdio | `{}` | **PASS** | `25565` default + `19132` notes "Geyser" |
| 14 | `ptero_get_startup_variables` | stdio | `{}` | **PASS** | `SERVER_JARFILE`, `MEMORY`, `MINECRAFT_VERSION`, `BUILD_NUMBER` + startup command |
| 15 | `ptero_get_console_log` | stdio | `{"window_seconds":4,"max_lines":1000}` | **PASS** | 150 backlog lines, `state: running`, held the socket the full 4 s |
| 16 | `ptero_get_console_log` (ANSI) | stdio | same call | **PASS** | mock emitted CSI colour codes on ~1 line in 7; returned `lines[]` are ANSI-free |
| 17 | `ptero_get_console_log` (re-auth) | stdio | same call | **PASS** | mock sent `token expiring` at 3 s → 2 `auth` frames on **1** socket; no duplicate backlog |
| 18 | `ptero_get_console_log` (filter) | stdio | `{"window_seconds":2,"max_lines":400,"filter":"geyser"}` | **PASS** | narrowed to Geyser lines only; every returned line matches |
| 19 | `ptero_send_console_command` | stdio | `{"command":"say hello from the MCP Inspector"}` | **PASS** | `dispatched: true`; mock recorded the command (REST `POST /command`, 204) |
| 20 | `ptero_copy_file` | stdio | `{"path":"plugins/Geyser-Spigot/config.yml"}` | **PASS** | one call, no confirmation; panel named the copy `config copy.yml` |
| 21 | `ptero_rename_file` | stdio | `{"root":"/","from":"plugins/Geyser-Spigot/config copy.yml","to":"plugins/Geyser-Spigot/config-backup.yml"}` | **PASS** | one call, no confirmation, no auto-backup — matches the docs |
| 22 | `ptero_create_backup` | stdio | `{"name":"inspector-smoke","wait":true}` | **PASS** | polled `completed_at` until set: `completed: true`, `is_successful: true` |
| 23 | `ptero_delete_file` (refused) | stdio | `{"root":"world","files":["level.dat"]}` | **PASS** | refused, `variable: PTERODACTYL_PROTECTED_PATHS`, `isError: true`, nothing dispatched |
| 24 | `ptero_delete_backup` (locked) | stdio | `{"backup_uuid":"c1b2a3d4-…"}` | **PASS** | refused before the guard: "is locked and cannot be deleted through this tool" |
| 25 | `ptero_set_power_state` (dry) | stdio | `{"signal":"kill","dry_run":true}` | **PASS** | `status: dry_run`, preview only; `ALLOW_KILL=true` did not cause a dispatch |
| 26 | `ptero_write_file` (read-only) | stdio + `PTERODACTYL_READ_ONLY=true` | `{"path":"test.txt","content":"nope\n"}` | **PASS** | refused, `variable: PTERODACTYL_READ_ONLY` |
| 27 | `ptero_set_power_state` (read-only) | stdio + `PTERODACTYL_READ_ONLY=true` | `{"signal":"restart"}` | **PASS** | refused, `variable: PTERODACTYL_READ_ONLY` |
| 28 | `ptero_write_file` phase 1 | http | `{"path":"test.txt","content":"rewritten by the MCP Inspector smoke test\n"}` | **PASS** | `needs_confirmation`, `preview.action: "overwrite"`, `exists: true`, token issued |
| 29 | `ptero_write_file` phase 2 | http | same + `confirmation_token` | **PASS** | `success`, `confirmed_via: "token"`, `backup_id` present (auto-backup completed first) |
| 30 | `ptero_delete_file` phase 1 | http | `{"root":"/","files":["test.txt"]}` | **PASS** | `needs_confirmation`, preview lists root/files/count, token issued |
| 31 | `ptero_delete_file` phase 2 | http | same + `confirmation_token` | **PASS** | `deleted_count: 1`, `confirmed_via: "token"`, auto-backup taken before the delete |
| 32 | `ptero_delete_file` (panel state) | — | `GET /__mock/state` | **PASS** | `test.txt` really is gone from the panel's filesystem |
| 33 | `ptero_delete_backup` phase 1 | http | `{"backup_uuid":"<inspector-smoke>"}` | **PASS** | `needs_confirmation` with a bound token |
| 34 | `ptero_delete_backup` phase 2 | http | same + `confirmation_token` | **PASS** | `success`, `confirmed_via: "token"`, backup removed from the list |
| 35 | `ptero_set_power_state` phase 1 | http | `{"signal":"stop","wait_seconds":4}` | **PASS** | `needs_confirmation`, `preview.current_state: "running"` |
| 36 | `ptero_set_power_state` phase 2 | http | same + `confirmation_token` | **PASS** | dispatched, polled: `state_after: "offline"` |
| 37 | `ptero_set_power_state` (cooldown) | http | `{"signal":"start"}` | **PASS** | refused: "power actions are limited to one per 30s" — cooldown works within a session |
| 38 | `ptero_send_console_command` (offline) | stdio | `{"command":"list"}` | **PASS** | panel 502 → "Server is offline; start it with `ptero_set_power_state` first" |
| 39 | `ptero_get_console_log` (offline) | stdio | `{"window_seconds":2,"max_lines":50}` | **PASS** | `state: offline`, 0 lines, note explains there is no live console |
| 40 | `ptero_set_power_state` (start) | stdio | `{"signal":"start","wait_seconds":4}` | **PASS** | `start` is non-destructive → single call, no token; `state_after: "running"` |

**Tool coverage:** all 19 registered tools invoked —
`ptero_list_servers`, `ptero_get_server`, `ptero_get_server_resources`,
`ptero_get_console_log`, `ptero_send_console_command`, `ptero_list_files`,
`ptero_read_file`, `ptero_write_file`, `ptero_rename_file`, `ptero_copy_file`,
`ptero_delete_file`, `ptero_set_power_state`, `ptero_list_backups`,
`ptero_create_backup`, `ptero_delete_backup`, `ptero_get_backup_download_url`,
`ptero_list_schedules`, `ptero_list_allocations`, `ptero_get_startup_variables`.

---

## 3. Audit trail

`PTERODACTYL_AUDIT_LOG=<tmpdir>/audit.jsonl`. 29 lines for the run above, reproduced as
written (the tool's own redaction applied; only the `reason`, `paths`, `file_count` and
`dry_run` keys are elided here for width).

```jsonl
{"ts":"2026-09-05T18:34:51.091Z","tool":"ptero_send_console_command","kind":"command","outcome":"attempted","args":{"server":"1a2b3c4d","command":"say hello from the MCP Inspector"},"confirmed_via":"none"}
{"ts":"2026-09-05T18:34:51.104Z","tool":"ptero_send_console_command","kind":"command","outcome":"success","args":{"server":"1a2b3c4d","command":"say hello from the MCP Inspector"},"confirmed_via":"none"}
{"ts":"2026-09-05T18:34:51.604Z","tool":"ptero_copy_file","kind":"write","outcome":"attempted","args":{"server":"1a2b3c4d","path":"plugins/Geyser-Spigot/config.yml"},"confirmed_via":"none"}
{"ts":"2026-09-05T18:34:51.618Z","tool":"ptero_copy_file","kind":"write","outcome":"success","args":{"server":"1a2b3c4d","path":"plugins/Geyser-Spigot/config.yml"},"confirmed_via":"none"}
{"ts":"2026-09-05T18:34:52.130Z","tool":"ptero_rename_file","kind":"write","outcome":"attempted","args":{"server":"1a2b3c4d","root":"/","from":"plugins/Geyser-Spigot/config copy.yml","to":"plugins/Geyser-Spigot/config-backup.yml"},"confirmed_via":"none"}
{"ts":"2026-09-05T18:34:52.144Z","tool":"ptero_rename_file","kind":"write","outcome":"success","args":{"server":"1a2b3c4d","root":"/","from":"plugins/Geyser-Spigot/config copy.yml","to":"plugins/Geyser-Spigot/config-backup.yml"},"confirmed_via":"none"}
{"ts":"2026-09-05T18:34:52.947Z","tool":"ptero_create_backup","kind":"backup_create","outcome":"attempted","args":{"name":"inspector-smoke","wait":true},"confirmed_via":"none"}
{"ts":"2026-09-05T18:34:54.971Z","tool":"ptero_create_backup","kind":"backup_create","outcome":"success","args":{"name":"inspector-smoke","wait":true},"confirmed_via":"none"}
{"ts":"2026-09-05T18:34:55.551Z","tool":"ptero_delete_file","kind":"delete","outcome":"refused","args":{"server":"1a2b3c4d","root":"/world","files":["level.dat"]},"variable":"PTERODACTYL_PROTECTED_PATHS"}
{"ts":"2026-09-05T18:34:57.190Z","tool":"ptero_set_power_state","kind":"power","outcome":"dry_run","args":{"signal":"kill"}}
{"ts":"2026-09-05T18:34:58.088Z","tool":"ptero_write_file","kind":"write","outcome":"refused","args":{"server":"1a2b3c4d","path":"test.txt","content_sha256":"29872037c9573567744ef10ed2de57864ded7554c9fa2ef03fc1244c65794ba6","content_length":5},"variable":"PTERODACTYL_READ_ONLY"}
{"ts":"2026-09-05T18:34:58.610Z","tool":"ptero_set_power_state","kind":"power","outcome":"refused","args":{"signal":"restart"},"variable":"PTERODACTYL_READ_ONLY"}
{"ts":"2026-09-05T18:34:59.128Z","tool":"ptero_write_file","kind":"write","outcome":"needs_confirmation","args":{"server":"1a2b3c4d","path":"test.txt","content_sha256":"e302de42d73be5d3628aea085db9a21ea169ffce4b10207c873658c854f7b3dc","content_length":42}}
{"ts":"2026-09-05T18:35:01.887Z","tool":"ptero_write_file","kind":"write","outcome":"attempted","args":{"server":"1a2b3c4d","path":"test.txt","content_sha256":"e302de42d73be5d3628aea085db9a21ea169ffce4b10207c873658c854f7b3dc","content_length":42},"confirmed_via":"token","backup_id":"82eb318c-fcad-4e04-9e71-07d6c551debe"}
{"ts":"2026-09-05T18:35:01.897Z","tool":"ptero_write_file","kind":"write","outcome":"success","args":{"server":"1a2b3c4d","path":"test.txt","content_sha256":"e302de42d73be5d3628aea085db9a21ea169ffce4b10207c873658c854f7b3dc","content_length":42},"confirmed_via":"token","backup_id":"82eb318c-fcad-4e04-9e71-07d6c551debe"}
{"ts":"2026-09-05T18:35:02.376Z","tool":"ptero_delete_file","kind":"delete","outcome":"needs_confirmation","args":{"server":"1a2b3c4d","root":"/","files":["test.txt"]}}
{"ts":"2026-09-05T18:35:04.874Z","tool":"ptero_delete_file","kind":"delete","outcome":"attempted","args":{"server":"1a2b3c4d","root":"/","files":["test.txt"]},"confirmed_via":"token","backup_id":"5a075cf0-c9e1-4ac3-bf06-ec2cf25fa1e7"}
{"ts":"2026-09-05T18:35:04.879Z","tool":"ptero_delete_file","kind":"delete","outcome":"success","args":{"server":"1a2b3c4d","root":"/","files":["test.txt"]},"confirmed_via":"token","backup_id":"5a075cf0-c9e1-4ac3-bf06-ec2cf25fa1e7"}
{"ts":"2026-09-05T18:35:05.540Z","tool":"ptero_delete_backup","kind":"backup_delete","outcome":"needs_confirmation","args":{"backup_uuid":"d8086717-3693-43f1-83ce-f5c148e408e8"}}
{"ts":"2026-09-05T18:35:06.001Z","tool":"ptero_delete_backup","kind":"backup_delete","outcome":"attempted","args":{"backup_uuid":"d8086717-3693-43f1-83ce-f5c148e408e8"},"confirmed_via":"token"}
{"ts":"2026-09-05T18:35:06.004Z","tool":"ptero_delete_backup","kind":"backup_delete","outcome":"success","args":{"backup_uuid":"d8086717-3693-43f1-83ce-f5c148e408e8"},"confirmed_via":"token"}
{"ts":"2026-09-05T18:35:06.463Z","tool":"ptero_set_power_state","kind":"power","outcome":"needs_confirmation","args":{"signal":"stop"}}
{"ts":"2026-09-05T18:35:07.273Z","tool":"ptero_set_power_state","kind":"power","outcome":"attempted","args":{"signal":"stop"},"confirmed_via":"token"}
{"ts":"2026-09-05T18:35:09.283Z","tool":"ptero_set_power_state","kind":"power","outcome":"success","args":{"signal":"stop"},"confirmed_via":"token"}
{"ts":"2026-09-05T18:35:09.765Z","tool":"ptero_set_power_state","kind":"power","outcome":"refused","args":{"signal":"start"}}
{"ts":"2026-09-05T18:35:10.305Z","tool":"ptero_send_console_command","kind":"command","outcome":"attempted","args":{"server":"1a2b3c4d","command":"list"},"confirmed_via":"none"}
{"ts":"2026-09-05T18:35:10.319Z","tool":"ptero_send_console_command","kind":"command","outcome":"error","args":{"server":"1a2b3c4d","command":"list"},"confirmed_via":"none","error":"Server is offline; start it with `ptero_set_power_state` first — console commands require a running server."}
{"ts":"2026-09-05T18:35:14.144Z","tool":"ptero_set_power_state","kind":"power","outcome":"attempted","args":{"signal":"start"},"confirmed_via":"none"}
{"ts":"2026-09-05T18:35:16.157Z","tool":"ptero_set_power_state","kind":"power","outcome":"success","args":{"signal":"start"},"confirmed_via":"none"}
```

What the trail confirms:

- Read-only tools write nothing. Only mutating tools appear.
- Every destructive call has a `needs_confirmation` line **before** its `attempted` line,
  and `confirmed_via: "token"` on the pair that ran.
- `write`/`delete` carry a `backup_id` — the Layer-3 auto-backup completed before the change.
- `ptero_write_file` audits `content_sha256` + `content_length`, never the file content.
- Signed download URLs never reach the log (`ptero_get_backup_download_url` is read-only and
  is not audited at all).
- Secret **values** are scrubbed, not just secret-looking keys. Sending
  `say secret is mock-key here` as a console command was written to disk as
  `"command":"say secret is [REDACTED] here"`.

---

## 4. Findings for the maintainer

Nothing here blocked the run; all 41 checks pass. These are things worth a look, with the
relevant source line. **No file under `src/` was modified.**

### F1 — `ptero_get_console_log`'s default `max_lines` equals the node's default backlog, so the default call always reports `truncated: true` and ignores `window_seconds`

- Tool: `ptero_get_console_log`, args `{}` (all defaults: `window_seconds: 5`, `max_lines: 150`).
- Observed: `{"state":"running","line_count":150,"truncated":true,"duration_ms":19}`.
- Expected: `truncated: false` (nothing was actually dropped — the node's whole ring buffer
  was delivered), and the call to stay connected for its 5-second window so live output is
  collected too.
- Cause: `maxLinesSchema` defaults to 150 (`src/tools/console.ts`, the `.default(150)` on
  `maxLinesSchema`, described as "the node's typical backlog size"), and
  `Connection.collect()` in `src/console/websocket.ts` finishes as soon as
  `this.lines.length >= maxLines` with `truncated = true`:

  ```ts
  this.onLine = () => {
    if (this.lines.length >= maxLines) finish(undefined, true);
  };
  ```

  Wings' default `websocket_log_count` is also 150 (docs §15), so the backlog burst alone hits
  the cap exactly. The tool returns in ~19 ms, `window_seconds` never elapses, and the
  documented behaviour ("plus whatever new lines stream in during the collection window")
  does not happen on a default call.
- Suggested fix: either treat "landed exactly on `maxLines`" as not-truncated
  (`finish(undefined, this.lines.length > maxLines)` after a drain), or raise the default
  `max_lines` above the 150-line backlog (e.g. 200) so the window is still honoured. The
  second is a one-token change and preserves the cap's purpose.
- Workaround used in the smoke test: pass `max_lines: 1000` explicitly, which then holds the
  socket for the full window and exercises the `token expiring` re-auth path.

### F2 — `ptero_send_console_command`'s description says "websocket", but it uses the REST endpoint; `WingsSocket.sendCommand` is dead code

- `src/tools/console.ts:219` (tool description): *"Send a command to the server console over
  the same websocket connection used by ptero_get_console_log."*
- `src/tools/console.ts:271` (handler): `await client.sendCommand(id, command);` — that is
  `POST /api/client/servers/{id}/command` (`src/client.ts`, §8 of the API docs), not the socket.
- `src/console/websocket.ts:520` defines `WingsSocket.sendCommand(command)`; `grep -rn
  "sendCommand" src/` shows it has no caller anywhere in the tree.
- Why it matters: the description is what the model reads. It implies the same socket, the
  same `control.console` JWT permission, and the same ignore-when-offline semantics as
  `send command` over the websocket. The REST route behaves differently in one visible way —
  it returns **HTTP 502 when the server is offline**, which the handler correctly maps to an
  actionable error, whereas the websocket path is documented as a silent no-op. The
  behaviour is fine; only the sentence is wrong.
- Suggested fix: reword the first sentence to name `POST .../command`, and either delete
  `WingsSocket.sendCommand` or add a comment saying why it is kept.

### F3 — Confirmation tokens are process-local (correct, but worth documenting for CLI-style clients)

- `Confirmation` stores tokens in an in-memory `Map` (`src/confirm.ts`), which is exactly
  right for a single-use, 120-second, argument-bound token.
- Consequence: any client that restarts the server process between the two calls can never
  complete a two-phase flow. The MCP Inspector CLI is precisely such a client — every
  `--cli` invocation spawns a fresh `dist/index.js`. Observed:
  phase 1 issues `VCp_hHoeRchMgJggrBq2y2tRkl0QCRcb`, phase 2 in a new process answers
  *"Refused: the confirmation token was rejected (unknown token)"*.
- The same reset applies to `PTERODACTYL_MAX_MUTATIONS` and the 30 s power cooldown: neither
  is ever reached under per-call spawning, so **the Inspector CLI cannot on its own
  demonstrate those two guardrails either**. Both were verified through the shared-session
  bridge instead (rows 37 and the token rows in the table).
- Suggested fix: no code change. A sentence in the README under the confirmation section —
  "the token lives in this server process; a client that restarts the process between calls
  will need a fresh preview" — would save someone the same investigation.

### F4 — `tools/list --strict`: 25 schema-portability warnings (0 errors)

Two patterns, both in `outputSchema`s, both flagged by the Inspector as "legal JSON Schema
but several MCP clients mishandle it":

1. **17 × nullable-as-`type` array.** Zod's `.nullable()` emits `"type": ["string","null"]`.
   Affected: `ptero_list_servers` (`description`, `status`, `primary_allocation`),
   `ptero_get_server` (`description`, `status`, `limits.threads`,
   `allocations[].ip_alias`, `allocations[].notes`), `ptero_read_file` (`truncated_to`),
   `ptero_list_backups`, `ptero_create_backup`, `ptero_delete_backup`,
   `ptero_list_schedules`, `ptero_list_allocations`, `ptero_get_startup_variables`
   (`variables[].server_value`).
   The Inspector's suggestion is `{"anyOf":[{"type":"string"},{"type":"null"}]}`.
2. **8 × unconstrained `preview.additionalProperties`.** `mutationOutputShape.preview` is
   `z.record(z.unknown())` (`src/tools/_shared.ts`), which serialises to an
   `additionalProperties` schema carrying no validation keyword at all — the object-literal
   spelling of bare `true`. Affects every mutating tool that spreads `mutationOutputShape`:
   `ptero_send_console_command`, `ptero_write_file`, `ptero_rename_file`, `ptero_copy_file`,
   `ptero_delete_file`, `ptero_set_power_state`, `ptero_create_backup`,
   `ptero_delete_backup`.
   `z.record(z.any())` with an explicit `additionalProperties: true`, or a narrower preview
   type per tool, would clear it.

Neither is error-severity and neither broke any client here (`--strict` exits 0). Reproduce
with `--method tools/list --strict`.

### F5 — `WingsSocket.collectLogs` sends `send stats` but discards every `stats` frame

- `src/console/websocket.ts`, `collectLogs()`: `conn.send('send logs'); conn.send('send stats');`
- `Connection.handleFrame` has no `case 'stats':` — the frame falls through to `default: break`.
- Harmless (Wings ignores nothing; the mock answered with a well-formed `stats` frame that
  was simply dropped), but it is a wasted round trip on a rate-limited event bucket
  (docs §15 lists `send stats` under the shared limiter). Either consume it — the payload
  carries `state`, which would make `state: "unknown"` less likely on a short window — or
  drop the send.

### F6 — Testing note, not a defect: `--tool-arg` cannot express this server's arguments

`--tool-arg files=test.txt` cannot produce `files: ["test.txt"]`, and `--tool-arg wait=true`
goes through string/number coercion. Everything in this run used `--tool-args-json`, which
passes values verbatim. Worth putting in the README's Inspector snippet so the next person
does not fight the coercion.
