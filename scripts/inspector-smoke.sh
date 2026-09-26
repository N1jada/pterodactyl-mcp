#!/usr/bin/env bash
#
# inspector-smoke.sh — SPEC §8.4 (docs/SPEC.md): drive every registered MCP tool through the
# MCP Inspector CLI against the in-memory mock Pterodactyl panel.
#
#   ./scripts/inspector-smoke.sh
#
# What it does:
#   1. builds (`npm run build`, retried a few times — another agent may be mid-edit)
#   2. starts test/mock-panel/server.mjs on a free port
#   3. starts a one-process stdio<->HTTP bridge so the two-phase confirmation flows can
#      complete (see BRIDGE below)
#   4. invokes every tool at least once through `@modelcontextprotocol/inspector --cli`
#   5. prints PASS/FAIL per invocation, dumps the audit trail, exits non-zero on any FAIL
#
# Everything transient lives in a mktemp dir that is removed on exit; the mock panel and
# the bridge are always killed, including on Ctrl-C.

set -uo pipefail


REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ptero-inspector.XXXXXX")"
AUDIT="$WORK/audit.jsonl"
OUT="$WORK/out.json"
ERR="$WORK/out.err"
MOCK_LOG="$WORK/mock-panel.log"
BRIDGE_LOG="$WORK/bridge.log"

MOCK_PID=""
BRIDGE_PID=""
FAILURES=0
CHECKS=0

cleanup() {
  local code=$?
  [ -n "$BRIDGE_PID" ] && kill "$BRIDGE_PID" 2>/dev/null
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
  wait "$BRIDGE_PID" 2>/dev/null
  wait "$MOCK_PID" 2>/dev/null
  # Keep the audit log around for the results doc if anything failed.
  if [ "$FAILURES" -ne 0 ] && [ -f "$AUDIT" ]; then
    cp "$AUDIT" "${TMPDIR:-/tmp}/ptero-inspector-audit.jsonl" 2>/dev/null
    echo "audit trail preserved at ${TMPDIR:-/tmp}/ptero-inspector-audit.jsonl" >&2
  fi
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT INT TERM

# --------------------------------------------------------------------------- #
# Reporting                                                                    #
# --------------------------------------------------------------------------- #

pass() {
  CHECKS=$((CHECKS + 1))
  printf 'PASS  %-30s %s\n' "$1" "$2"
}

fail() {
  CHECKS=$((CHECKS + 1))
  FAILURES=$((FAILURES + 1))
  printf 'FAIL  %-30s %s\n' "$1" "$2"
  printf '      result: %s\n' "$(jq -c '.result.structuredContent // .result // .error // .' "$OUT" 2>/dev/null | head -c 400)"
}

section() { printf '\n--- %s\n' "$1"; }

# assert <tool> <one-line summary> <jq expression yielding true/false>
assert() {
  if [ "$(jq -r "$3" "$OUT" 2>/dev/null)" = "true" ]; then
    pass "$1" "$2"
  else
    fail "$1" "$2"
  fi
}

# --------------------------------------------------------------------------- #
# 1. Build (retry: src/ may be under concurrent edit)                          #
# --------------------------------------------------------------------------- #

section "build"
built=0
for attempt in 1 2 3 4 5; do
  if npm run build >"$WORK/build.log" 2>&1; then
    built=1
    echo "npm run build ok (attempt $attempt)"
    break
  fi
  echo "npm run build failed (attempt $attempt/5); retrying in 60s" >&2
  tail -20 "$WORK/build.log" >&2
  [ "$attempt" -lt 5 ] && sleep 60
done
if [ "$built" -ne 1 ]; then
  echo "FATAL: npm run build never succeeded" >&2
  FAILURES=$((FAILURES + 1))
  exit 1
fi

# --------------------------------------------------------------------------- #
# 2. Mock panel                                                                #
# --------------------------------------------------------------------------- #

section "mock panel"
node test/mock-panel/server.mjs 0 >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
PANEL_URL=""
for _ in $(seq 1 50); do
  PANEL_URL="$(sed -n 's/^MOCK_PANEL_URL=//p' "$MOCK_LOG" | head -1)"
  [ -n "$PANEL_URL" ] && break
  sleep 0.2
done
if [ -z "$PANEL_URL" ]; then
  echo "FATAL: mock panel did not start" >&2
  cat "$MOCK_LOG" >&2
  FAILURES=$((FAILURES + 1))
  exit 1
fi
echo "mock panel at $PANEL_URL (pid $MOCK_PID)"

MOCK_ENV=(
  -e "PTERODACTYL_PANEL_URL=$PANEL_URL"
  -e "PTERODACTYL_API_KEY=mock-key"
  -e "PTERODACTYL_DEFAULT_SERVER=1a2b3c4d"
  -e "PTERODACTYL_ALLOW_DELETE=true"
  -e "PTERODACTYL_ALLOW_KILL=true"
  -e "PTERODACTYL_AUDIT_LOG=$AUDIT"
)

# --------------------------------------------------------------------------- #
# 3. BRIDGE                                                                    #
#                                                                              #
# Every `inspector --cli` invocation spawns a FRESH `node dist/index.js`, so    #
# the guard's mutation budget and 30s power cooldown reset on every call — and  #
# the two-phase confirmation token, which lives in that process's memory, is    #
# gone by the time the second call runs. To exercise the real two-phase flow    #
# the way a long-lived MCP client sees it, this bridge keeps ONE server process #
# alive behind a Streamable-HTTP endpoint that several --cli calls share.       #
# --------------------------------------------------------------------------- #

cat >"$WORK/bridge.mjs" <<'BRIDGE_EOF'
#!/usr/bin/env node
/** Streamable-HTTP <-> stdio bridge: one long-lived MCP server, many CLI calls. */
import http from 'node:http';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const port = Number(argv[0]);
const cmd = argv.slice(sep + 1);

const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
child.on('exit', (code) => {
  process.stderr.write(`[bridge] child exited ${code}\n`);
  process.exit(code ?? 1);
});

const pending = new Map();
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const key = String(msg.id);
    if (msg.id !== undefined && pending.has(key)) {
      const resolve = pending.get(key);
      pending.delete(key);
      resolve(msg);
    }
  }
});

function forward(msg) {
  return new Promise((resolve) => {
    if (msg.id !== undefined) pending.set(String(msg.id), resolve);
    child.stdin.write(`${JSON.stringify(msg)}\n`);
    if (msg.id === undefined) resolve(null);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/mcp') return void res.writeHead(404).end();
  if (req.method === 'GET') return void res.writeHead(405, { Allow: 'POST, DELETE' }).end();
  if (req.method === 'DELETE') return void res.writeHead(200).end();
  if (req.method !== 'POST') return void res.writeHead(405).end();

  let raw = '';
  req.setEncoding('utf8');
  for await (const chunk of req) raw += chunk;

  let payload;
  try { payload = JSON.parse(raw); } catch {
    return void res.writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  const responses = [];
  for (const msg of messages) {
    const answer = await forward(msg);
    if (answer) responses.push(answer);
  }
  if (responses.length === 0) return void res.writeHead(202).end();

  const body = JSON.stringify(Array.isArray(payload) ? responses : responses[0]);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }).end(body);
});

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`BRIDGE_URL=http://127.0.0.1:${server.address().port}/mcp\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill('SIGKILL'); } finally { process.exit(0); } });
}
BRIDGE_EOF

section "persistent-session bridge"
PTERODACTYL_PANEL_URL="$PANEL_URL" \
PTERODACTYL_API_KEY="mock-key" \
PTERODACTYL_DEFAULT_SERVER="1a2b3c4d" \
PTERODACTYL_ALLOW_DELETE="true" \
PTERODACTYL_ALLOW_KILL="true" \
PTERODACTYL_AUDIT_LOG="$AUDIT" \
  node "$WORK/bridge.mjs" 0 -- node dist/index.js >"$BRIDGE_LOG" 2>&1 &
BRIDGE_PID=$!
BRIDGE_URL=""
for _ in $(seq 1 50); do
  BRIDGE_URL="$(sed -n 's/^BRIDGE_URL=//p' "$BRIDGE_LOG" | head -1)"
  [ -n "$BRIDGE_URL" ] && break
  sleep 0.2
done
if [ -z "$BRIDGE_URL" ]; then
  echo "FATAL: bridge did not start" >&2
  cat "$BRIDGE_LOG" >&2
  FAILURES=$((FAILURES + 1))
  exit 1
fi
echo "bridge at $BRIDGE_URL (pid $BRIDGE_PID) — one long-lived dist/index.js"

# --------------------------------------------------------------------------- #
# Invocation helpers                                                           #
# --------------------------------------------------------------------------- #

INSPECTOR=(npx --yes @modelcontextprotocol/inspector --cli)

# call_stdio <tool> <args-json> [extra -e pairs...] — fresh server process per call.
call_stdio() {
  local tool="$1" args="$2"
  shift 2
  "${INSPECTOR[@]}" node dist/index.js "${MOCK_ENV[@]}" "$@" \
    --method tools/call --tool-name "$tool" --tool-args-json "$args" \
    --format json >"$OUT" 2>"$ERR"
}

# call_http <tool> <args-json> — shared, long-lived server process via the bridge.
call_http() {
  local tool="$1" args="$2"
  "${INSPECTOR[@]}" --transport http --server-url "$BRIDGE_URL" \
    --method tools/call --tool-name "$tool" --tool-args-json "$args" \
    --format json >"$OUT" 2>"$ERR"
}

mock_state() { curl -s "$PANEL_URL/__mock/state"; }

# --------------------------------------------------------------------------- #
# 4. tools/list                                                                #
# --------------------------------------------------------------------------- #

section "tools/list"
"${INSPECTOR[@]}" node dist/index.js "${MOCK_ENV[@]}" --method tools/list --format json \
  >"$OUT" 2>"$ERR"
TOOL_COUNT="$(jq -r '.result.tools | length' "$OUT" 2>/dev/null)"
assert "tools/list" "$TOOL_COUNT tools advertised, all names ptero_*" \
  '(.result.tools | length) == 20 and ([.result.tools[].name | startswith("ptero_")] | all)'
jq -r '.result.tools[].name' "$OUT" 2>/dev/null | sed 's/^/      /'

# --strict reports schema-portability problems and exits 6 on any error-severity one.
"${INSPECTOR[@]}" node dist/index.js "${MOCK_ENV[@]}" --method tools/list --strict --format json \
  >/dev/null 2>"$WORK/strict.err"
STRICT_RC=$?
STRICT_SUMMARY="$(grep -E '^[0-9]+ errors?, ' "$WORK/strict.err" | tail -1)"
if [ "$STRICT_RC" -eq 0 ]; then
  pass "tools/list --strict" "no error-severity schema problems (${STRICT_SUMMARY:-summary unavailable})"
else
  fail "tools/list --strict" "schema portability errors (exit $STRICT_RC): ${STRICT_SUMMARY:-see stderr}"
  head -40 "$WORK/strict.err" >&2
fi

# --------------------------------------------------------------------------- #
# 5. Read-only tools                                                           #
# --------------------------------------------------------------------------- #

section "read-only tools"

call_stdio ptero_list_servers '{}'
assert "ptero_list_servers" "1 server, identifier 1a2b3c4d, node eu-1" \
  '.result.structuredContent.servers[0].identifier == "1a2b3c4d" and .result.structuredContent.servers[0].node == "eu-1"'

call_stdio ptero_get_server '{"server":"1a2b3c4d"}'
assert "ptero_get_server" "name=Survival, 8192 MiB memory, 2 allocations" \
  '.result.structuredContent.name == "Survival" and .result.structuredContent.limits.memory == 8192 and (.result.structuredContent.allocations | length) == 2'

call_stdio ptero_get_server_resources '{}'
assert "ptero_get_server_resources" "current_state=running, cpu 42.5%, uptime 3h" \
  '.result.structuredContent.current_state == "running" and .result.structuredContent.cpu_absolute == 42.5'

call_stdio ptero_list_files '{"directory":"/"}'
assert "ptero_list_files" "root listing has server.properties + plugins/ + logs/" \
  '([.result.structuredContent.entries[].name] | index("server.properties")) != null and ([.result.structuredContent.entries[].name] | index("plugins")) != null'

call_stdio ptero_read_file '{"path":"plugins/Geyser-Spigot/config.yml"}'
assert "ptero_read_file (config.yml)" "Geyser config read, bedrock port 19132 present" \
  '(.result.structuredContent.content | contains("port: 19132")) and (.result.structuredContent.content | contains("Bedrock welcome"))'

call_stdio ptero_read_file '{"path":"logs/latest.log","tail_lines":20}'
assert "ptero_read_file (tail 20)" "last 20 of 300 lines, truncated_to reported" \
  '.result.structuredContent.lines_returned == 20 and (.result.structuredContent.truncated_to | test("last 20 of 300 lines"))'

call_stdio ptero_read_file '{"path":"plugins/Geyser-Spigot.jar"}'
assert "ptero_read_file (size guard)" "refused an 11 MiB jar before downloading anything" \
  '.result.isError == true and (.result.content[0].text | test("Refused to read")) and (.result.content[0].text | test("Nothing was downloaded"))'

call_stdio ptero_list_backups '{}'
assert "ptero_list_backups" "2 seeded backups, one locked" \
  '(.result.structuredContent.backups | length) >= 2 and ([.result.structuredContent.backups[].is_locked] | any)'
NIGHTLY_UUID="$(jq -r '.result.structuredContent.backups[] | select(.is_locked == false) | .uuid' "$OUT" 2>/dev/null | head -1)"
LOCKED_UUID="$(jq -r '.result.structuredContent.backups[] | select(.is_locked == true) | .uuid' "$OUT" 2>/dev/null | head -1)"

call_stdio ptero_get_backup_download_url "{\"backup_uuid\":\"$NIGHTLY_UUID\"}"
assert "ptero_get_backup_download_url" "signed URL returned for $NIGHTLY_UUID" \
  '(.result.structuredContent.url | test("^http")) and (.result.structuredContent.uuid | length) > 0'

call_stdio ptero_list_schedules '{}'
assert "ptero_list_schedules" "1 schedule (Nightly restart) with 2 tasks" \
  '(.result.structuredContent.schedules | length) == 1 and (.result.structuredContent.schedules[0].tasks | length) == 2'

call_stdio ptero_list_allocations '{}'
assert "ptero_list_allocations" "25565 default + 19132 (Geyser)" \
  '([.result.structuredContent.allocations[] | select(.port == 25565 and .is_default)] | length) == 1 and ([.result.structuredContent.allocations[] | select(.port == 19132 and .notes == "Geyser")] | length) == 1'

call_stdio ptero_get_startup_variables '{}'
assert "ptero_get_startup_variables" "SERVER_JARFILE + MEMORY present, startup command shown" \
  '([.result.structuredContent.variables[].env_variable] | index("SERVER_JARFILE")) != null and ([.result.structuredContent.variables[].env_variable] | index("MEMORY")) != null'

# --------------------------------------------------------------------------- #
# 6. Console (websocket) — window long enough for the token-expiring re-auth   #
# --------------------------------------------------------------------------- #

section "console websocket"

WS_AUTHS_BEFORE="$(mock_state | jq -r '.ws_auths')"
call_stdio ptero_get_console_log '{"window_seconds":4,"max_lines":1000}'
assert "ptero_get_console_log" "150 backlog lines, state=running, 4s window" \
  '.result.structuredContent.line_count == 150 and .result.structuredContent.state == "running" and .result.structuredContent.window_seconds == 4'

# ANSI-free check: the mock deliberately colours some console output.
if jq -r '.result.structuredContent.lines[]?' "$OUT" 2>/dev/null | grep -q "$(printf '\033')"; then
  fail "ptero_get_console_log (ansi)" "ANSI escape codes leaked into lines[]"
else
  pass "ptero_get_console_log (ansi)" "returned lines are ANSI-free (mock emitted colour codes)"
fi

WS_AUTHS_AFTER="$(mock_state | jq -r '.ws_auths')"
WS_CONNS="$(mock_state | jq -r '.ws_connections')"
if [ "$((WS_AUTHS_AFTER - WS_AUTHS_BEFORE))" -ge 2 ]; then
  pass "ptero_get_console_log (reauth)" "re-authenticated on the same socket after 'token expiring' ($((WS_AUTHS_AFTER - WS_AUTHS_BEFORE)) auth frames, $WS_CONNS connection(s))"
else
  fail "ptero_get_console_log (reauth)" "expected >=2 auth frames on one socket, saw $((WS_AUTHS_AFTER - WS_AUTHS_BEFORE))"
fi

call_stdio ptero_get_console_log '{"window_seconds":2,"max_lines":400,"filter":"geyser"}'
assert "ptero_get_console_log (filter)" "filter=geyser narrows the backlog" \
  '.result.structuredContent.line_count > 0 and .result.structuredContent.line_count < 150 and ([.result.structuredContent.lines[] | ascii_downcase | test("geyser")] | all)'

call_stdio ptero_send_console_command '{"command":"say hello from the MCP Inspector"}'
assert "ptero_send_console_command" "dispatched over REST while running (204)" \
  '.result.structuredContent.status == "success" and .result.structuredContent.dispatched == true'

# --------------------------------------------------------------------------- #
# 7. Non-destructive mutating tools (single call, no confirmation)             #
# --------------------------------------------------------------------------- #

section "mutating tools — copy / rename / backup"

call_stdio ptero_copy_file '{"path":"plugins/Geyser-Spigot/config.yml"}'
assert "ptero_copy_file" "config.yml duplicated (panel chooses the copy name)" \
  '.result.structuredContent.status == "success"'

call_stdio ptero_rename_file '{"root":"/","from":"plugins/Geyser-Spigot/config copy.yml","to":"plugins/Geyser-Spigot/config-backup.yml"}'
assert "ptero_rename_file" "copy renamed to plugins/Geyser-Spigot/config-backup.yml" \
  '.result.structuredContent.status == "success"'

call_stdio ptero_create_backup '{"name":"inspector-smoke","wait":true}'
assert "ptero_create_backup" "created and waited for completion" \
  '.result.structuredContent.status == "success" and .result.structuredContent.completed == true and .result.structuredContent.is_successful == true'
SMOKE_BACKUP_UUID="$(jq -r '.result.structuredContent.uuid' "$OUT" 2>/dev/null)"

# --------------------------------------------------------------------------- #
# 8. Refusals                                                                  #
# --------------------------------------------------------------------------- #

section "guardrail refusals"

call_stdio ptero_delete_file '{"root":"world","files":["level.dat"]}'
assert "ptero_delete_file (protected)" "refused: world/level.dat matches a protected path" \
  '.result.isError == true and .result.structuredContent.status == "refused" and .result.structuredContent.variable == "PTERODACTYL_PROTECTED_PATHS"'

call_stdio ptero_delete_backup "{\"backup_uuid\":\"$LOCKED_UUID\"}"
assert "ptero_delete_backup (locked)" "refused: backup is locked" \
  '.result.isError == true and (.result.content[0].text | test("locked"; "i"))'

call_stdio ptero_set_power_state '{"signal":"kill","dry_run":true}'
assert "ptero_set_power_state (dry)" "dry_run preview for kill, nothing dispatched" \
  '.result.structuredContent.status == "dry_run" and .result.structuredContent.preview.signal == "kill"'

section "read-only mode (PTERODACTYL_READ_ONLY=true)"
call_stdio ptero_write_file '{"path":"test.txt","content":"nope\n"}' -e PTERODACTYL_READ_ONLY=true
assert "ptero_write_file (read-only)" "refused with variable PTERODACTYL_READ_ONLY" \
  '.result.isError == true and .result.structuredContent.status == "refused" and .result.structuredContent.variable == "PTERODACTYL_READ_ONLY"'

call_stdio ptero_set_power_state '{"signal":"restart"}' -e PTERODACTYL_READ_ONLY=true
assert "ptero_set_power_state (read-only)" "refused with variable PTERODACTYL_READ_ONLY" \
  '.result.isError == true and .result.structuredContent.variable == "PTERODACTYL_READ_ONLY"'

# --------------------------------------------------------------------------- #
# 9. Two-phase confirmation flows (persistent session via the bridge)          #
# --------------------------------------------------------------------------- #

section "two-phase confirmation (shared server process)"

# --- ptero_write_file: overwrite an existing file ---------------------------
WRITE_ARGS='{"path":"test.txt","content":"rewritten by the MCP Inspector smoke test\n"}'
call_http ptero_write_file "$WRITE_ARGS"
assert "ptero_write_file (phase 1)" "needs_confirmation, action=overwrite, token issued" \
  '.result.structuredContent.status == "needs_confirmation" and .result.structuredContent.preview.action == "overwrite" and (.result.structuredContent.confirmation_token | length) > 0'
WRITE_TOKEN="$(jq -r '.result.structuredContent.confirmation_token' "$OUT" 2>/dev/null)"

call_http ptero_write_file "$(jq -cn --argjson a "$WRITE_ARGS" --arg t "$WRITE_TOKEN" '$a + {confirmation_token:$t}')"
assert "ptero_write_file (phase 2)" "overwrote test.txt, confirmed_via=token, auto-backup taken" \
  '.result.structuredContent.status == "success" and .result.structuredContent.action == "overwrite" and .result.structuredContent.confirmed_via == "token" and (.result.structuredContent.backup_id | length) > 0'

# --- ptero_upload_file: binary bytes, panel signed URL then multipart to Wings
UPLOAD_LOCAL="$WORK/smoke-upload.bin"
head -c 2048 /dev/urandom > "$UPLOAD_LOCAL"
UPLOAD_SHA="$(shasum -a 256 "$UPLOAD_LOCAL" | cut -d' ' -f1)"
call_http ptero_upload_file "$(jq -cn --arg p "$UPLOAD_LOCAL" '{local_path:$p,remote_dir:"/",remote_name:"smoke-upload.bin"}')"
assert "ptero_upload_file (create)" "uploaded 2048 bytes to a new path, no confirmation needed" \
  '.result.structuredContent.status == "success" and .result.structuredContent.action == "create" and .result.structuredContent.bytes == 2048 and .result.structuredContent.path == "smoke-upload.bin"'
if [ "$(jq -r '.result.structuredContent.sha256' "$OUT" 2>/dev/null)" = "$UPLOAD_SHA" ]; then
  pass "ptero_upload_file (sha256)" "reported sha256 matches the local file"
else
  fail "ptero_upload_file (sha256)" "reported sha256 does not match the local file"
fi
if mock_state | jq -e '[.files[]] | index("smoke-upload.bin") != null' >/dev/null 2>&1; then
  pass "ptero_upload_file (panel)" "smoke-upload.bin is present on the panel's filesystem"
else
  fail "ptero_upload_file (panel)" "smoke-upload.bin never reached the panel's filesystem"
fi

call_http ptero_upload_file "$(jq -cn --arg p "$UPLOAD_LOCAL" '{local_path:$p,remote_dir:"/",remote_name:"smoke-upload.bin"}')"
assert "ptero_upload_file (overwrite)" "needs_confirmation, action=overwrite, token issued" \
  '.result.structuredContent.status == "needs_confirmation" and .result.structuredContent.preview.action == "overwrite" and (.result.structuredContent.confirmation_token | length) > 0'

call_stdio ptero_upload_file '{"local_path":"/nonexistent/definitely-not-here.jar"}'
assert "ptero_upload_file (missing local)" "errors on an unreadable local path, before any panel call" \
  '.result.isError == true and (.result.content[0].text | test("Cannot read"))'

# --- ptero_delete_file: the real thing, on the scratch file ------------------
DELETE_ARGS='{"root":"/","files":["test.txt"]}'
call_http ptero_delete_file "$DELETE_ARGS"
assert "ptero_delete_file (phase 1)" "needs_confirmation, preview lists test.txt, token issued" \
  '.result.structuredContent.status == "needs_confirmation" and .result.structuredContent.preview.files == ["test.txt"] and (.result.structuredContent.confirmation_token | length) > 0'
DELETE_TOKEN="$(jq -r '.result.structuredContent.confirmation_token' "$OUT" 2>/dev/null)"

call_http ptero_delete_file "$(jq -cn --argjson a "$DELETE_ARGS" --arg t "$DELETE_TOKEN" '$a + {confirmation_token:$t}')"
assert "ptero_delete_file (phase 2)" "deleted test.txt, confirmed_via=token, auto-backup taken" \
  '.result.structuredContent.status == "success" and .result.structuredContent.deleted_count == 1 and .result.structuredContent.confirmed_via == "token" and (.result.structuredContent.backup_id | length) > 0'

if mock_state | jq -e '[.files[]] | index("test.txt") == null' >/dev/null 2>&1; then
  pass "ptero_delete_file (panel)" "test.txt is gone from the panel's filesystem"
else
  fail "ptero_delete_file (panel)" "test.txt is still present on the panel"
fi

# --- ptero_delete_backup: the smoke backup created earlier -------------------
DELBACKUP_ARGS="{\"backup_uuid\":\"$SMOKE_BACKUP_UUID\"}"
call_http ptero_delete_backup "$DELBACKUP_ARGS"
assert "ptero_delete_backup (phase 1)" "needs_confirmation for $SMOKE_BACKUP_UUID" \
  '.result.structuredContent.status == "needs_confirmation" and (.result.structuredContent.confirmation_token | length) > 0'
DELBACKUP_TOKEN="$(jq -r '.result.structuredContent.confirmation_token' "$OUT" 2>/dev/null)"

call_http ptero_delete_backup "$(jq -cn --argjson a "$DELBACKUP_ARGS" --arg t "$DELBACKUP_TOKEN" '$a + {confirmation_token:$t}')"
assert "ptero_delete_backup (phase 2)" "backup deleted, confirmed_via=token" \
  '.result.structuredContent.status == "success" and .result.structuredContent.confirmed_via == "token"'

# --- ptero_set_power_state: stop, two-phase ---------------------------------
STOP_ARGS='{"signal":"stop","wait_seconds":4}'
call_http ptero_set_power_state "$STOP_ARGS"
assert "ptero_set_power_state (phase 1)" "needs_confirmation for stop, current_state=running" \
  '.result.structuredContent.status == "needs_confirmation" and .result.structuredContent.preview.signal == "stop" and .result.structuredContent.preview.current_state == "running"'
STOP_TOKEN="$(jq -r '.result.structuredContent.confirmation_token' "$OUT" 2>/dev/null)"

call_http ptero_set_power_state "$(jq -cn --argjson a "$STOP_ARGS" --arg t "$STOP_TOKEN" '$a + {confirmation_token:$t}')"
assert "ptero_set_power_state (phase 2)" "stop dispatched, polled to state_after=offline" \
  '.result.structuredContent.status == "success" and .result.structuredContent.signal == "stop" and .result.structuredContent.state_after == "offline"'

# The cooldown is per server process: a second power call on the SAME session is refused.
call_http ptero_set_power_state '{"signal":"start"}'
assert "ptero_set_power_state (cooldown)" "second power action in the same process refused by the 30s cooldown" \
  '.result.isError == true and (.result.content[0].text | test("power actions are limited to one per 30s"))'

# --------------------------------------------------------------------------- #
# 10. Offline behaviour + recovery (fresh process, so no cooldown)             #
# --------------------------------------------------------------------------- #

section "offline behaviour"

call_stdio ptero_send_console_command '{"command":"list"}'
assert "ptero_send_console_command (502)" "panel 502 mapped to an actionable 'start it first' error" \
  '.result.isError == true and (.result.content[0].text | test("offline"; "i"))'

call_stdio ptero_get_console_log '{"window_seconds":2,"max_lines":50}'
assert "ptero_get_console_log (offline)" "no console to read while offline, state reported" \
  '.result.structuredContent.state == "offline" and .result.structuredContent.line_count == 0'

# `start` is not destructive: one call, no confirmation token.
call_stdio ptero_set_power_state '{"signal":"start","wait_seconds":4}'
assert "ptero_set_power_state (start)" "start needs no confirmation; state_after=running" \
  '.result.structuredContent.status == "success" and .result.structuredContent.signal == "start" and .result.structuredContent.state_after == "running"'

# --------------------------------------------------------------------------- #
# 11. Audit trail                                                              #
# --------------------------------------------------------------------------- #

section "audit trail ($AUDIT)"
if [ -s "$AUDIT" ]; then
  pass "audit.jsonl" "$(wc -l <"$AUDIT" | tr -d ' ') entries written"
  jq -c '{ts, tool, kind, outcome, args, confirmed_via, backup_id, variable}' "$AUDIT" 2>/dev/null | sed 's/^/      /'
else
  fail "audit.jsonl" "no audit entries were written to $AUDIT"
fi

# --------------------------------------------------------------------------- #
# Summary                                                                      #
# --------------------------------------------------------------------------- #

section "summary"
printf '%d checks, %d failures\n' "$CHECKS" "$FAILURES"
if [ "$FAILURES" -ne 0 ]; then
  exit 1
fi
exit 0
