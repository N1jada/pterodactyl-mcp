# Pterodactyl Panel — Client API Reference

Scope: **Client API only** (`/api/client/...`), for building a TypeScript MCP server against a
Pterodactyl panel. Compiled from the `pterodactyl/panel` source (branch `1.0-develop`) and
`pterodactyl/wings` source (branch `develop`) on GitHub, cross-checked against community docs at
pteroapi.com. Every non-obvious fact below is cited with the exact source path. Anything not
confirmed in source is explicitly flagged **UNVERIFIED**.

All paths below are relative to `/api/client` unless stated otherwise.
Route table source: `routes/api-client.php`
(https://raw.githubusercontent.com/pterodactyl/panel/1.0-develop/routes/api-client.php)

---

## 1. Authentication & required headers

- `Authorization: Bearer <client-api-key>` — client API keys are prefixed `ptlc_` and are created
  per-user in the panel UI ("API Credentials"). Route middleware is `client-api` →
  `RequireClientApiKey` (rejects an *application* API key used on client routes with 403) and
  `auth:sanctum` (from the `api` group). Source: `app/Http/Kernel.php` middleware groups `api` /
  `client-api`; `app/Http/Middleware/Api/Client/RequireClientApiKey.php`.
  (https://raw.githubusercontent.com/pterodactyl/panel/1.0-develop/app/Http/Kernel.php,
  .../app/Http/Middleware/Api/Client/RequireClientApiKey.php)
- `Accept: Application/vnd.pterodactyl.v1+json` — required by convention (community docs); not
  independently re-verified in source for this branch but is the documented/expected value.
- `Content-Type: application/json` for JSON bodies. The two file endpoints that take a raw body
  (`files/write`) use `Content-Type: text/plain` (or none) — the raw request body is used verbatim,
  no JSON parsing. Source: `FileController::write()` uses `$request->getContent()`.
- A 2FA-incomplete session/token can be blocked by `RequireTwoFactorAuthentication` middleware on
  most client routes (account root routes explicitly opt out via `withoutMiddleware`). Source:
  `routes/api-client.php`.

## 2. Error envelope

All API errors render as:
```json
{ "errors": [ { "code": "SomeExceptionShortName", "status": "404", "detail": "human message", "meta": { } } ] }
```
`code` = PHP exception class basename, `status` = HTTP status as a **string**, `detail` = message
(generic "An unexpected error..." message for uncaught 500s when `app.debug` is off). Validation
errors (422) attach `meta.source_field` and `meta.rule` per failed field/rule.
Source: `app/Exceptions/Handler.php::convertExceptionToArray()` / `invalidJson()`.
(https://raw.githubusercontent.com/pterodactyl/panel/1.0-develop/app/Exceptions/Handler.php)

Common status codes seen across client endpoints:
| Status | Meaning | Example source |
|---|---|---|
| 200 | OK, JSON body returned | normal reads/creates |
| 202 | Accepted | `POST .../schedules/{id}/execute` |
| 204 | No Content | power, command, most file ops, backup delete/restore, allocation delete |
| 400 | `DisplayException` (bad request / business-rule violation) — default status code for this exception base class | file too large to view, allocation limit issues, invalid cron expression |
| 401 | Unauthenticated (bad/missing/expired bearer token) | Sanctum auth failure |
| 403 | Forbidden — action not permitted for this API key/subuser, or application key used on client route | `HttpForbiddenException`, `AuthorizationException`, `RequireClientApiKey` |
| 404 | `NotFoundHttpException` / `ModelNotFoundException` — resource or nested resource (schedule/task not belonging to server) not found | mismatched schedule/task/server ids |
| 422 | Validation failure | any malformed request body |
| 429 | Rate limited | `ThrottleRequests` middleware |
| 502 | `HttpException(502)` — "Server must be online in order to send commands." | `POST .../command` while offline |

`DisplayException::getStatusCode()` hardcodes `400`.
(https://raw.githubusercontent.com/pterodactyl/panel/1.0-develop/app/Exceptions/DisplayException.php)

## 3. Rate limiting

Client-API limiter key = `$user->uuid` if authenticated else request IP (so switching IPs on the
same key does not evade limits). Config: `RateLimiter::for('api.client', ...)` using
`config('http.rate_limit.client_period')` (minutes window) and `config('http.rate_limit.client')`
(requests). Defaults in `config/http.php`:
```
client_period = 1        // minutes
client        = env('APP_API_CLIENT_RATELIMIT', 256)   // requests / period
```
Source: `app/Providers/RouteServiceProvider.php::configureRateLimiting()`,
`config/http.php`.
(https://raw.githubusercontent.com/pterodactyl/panel/1.0-develop/app/Providers/RouteServiceProvider.php,
.../config/http.php)

**Flag:** community docs (pteroapi.com) state a default of **240 requests/minute**; current
`1.0-develop` source shows a default of **256/min** (admin-configurable via
`APP_API_CLIENT_RATELIMIT` env var / panel `.env`). Treat the real limit as **whatever the target
panel's `.env` sets** — do not hardcode 240 or 256; read the response headers instead.
Laravel's default `ThrottleRequests` middleware headers (standard Laravel behavior, not
Pterodactyl-specific code): `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and on a 429:
`Retry-After` + `X-RateLimit-Reset`.

## 4. Servers

### 4.1 `GET /` — list servers
Query: `page`, `per_page` (server clamps to `min(per_page, 100)`, default `50`), `type` = `admin` |
`admin-all` | `owner` (omit for "servers I own or am a subuser on" — the default/normal case), plus
Spatie `filter[uuid|name|description|external_id]=` and a free-text multi-field filter, and
`include=egg,subusers` (available includes; `allocations` and `variables` are **always** included
by default). `filter[*]=` (MultiFieldServerFilter) matches across fields loosely.
Source: `app/Http/Controllers/Api/Client/ClientController.php`,
`app/Http/Requests/Api/Client/GetServersRequest.php` (authorize() always true — no special
permission check beyond having a valid key).

### 4.2 `GET /servers/{id}` — get one server
`{id}` = the server's `identifier` (uuidShort, 8 chars) by default, or short-uuid depending on
`pterodactyl.features.new_server_identifiers` panel config. Response envelope:
```json
{ "object": "server", "attributes": { ... }, "meta": { "is_server_owner": bool, "user_permissions": ["control.console", ...] } }
```
`ServerTransformer` attributes (all confirmed fields, `app/Transformers/Api/Client/ServerTransformer.php`):
```
server_owner: bool
identifier: string                 // uuidShort or new identifier depending on feature flag
__deprecated_uuid_short: string
server_identifier: string
internal_id: number
uuid: string                       // full UUID
name: string
node: string                       // node NAME (not id/uuid)
is_node_under_maintenance: bool
sftp_details: { ip: string, port: number }
description: string|null
limits: { memory, swap, disk, io, cpu, threads, oom_disabled }
invocation: string                 // resolved startup command (redacted if no startup:read perm)
docker_image: string
egg_features: string[]|null
feature_limits: { databases, allocations, backups }
status: string|null                // null = running/installed normally; see Server::STATUS_* below
is_suspended: bool                 // DEPRECATED, use status
is_installing: bool                // DEPRECATED, use status
is_transferring: bool
skip_scripts: bool
```
`Server::STATUS_*` constants (when `status` is non-null):
`installing`, `install_failed`, `reinstall_failed`, `suspended`, `restoring_backup`.
Source: `app/Models/Server.php`.

Relationships (fractal `included`, default-included unless noted):
- `relationships.allocations` → collection of allocation objects (see §9) — **default include**.
  If the caller lacks `allocation.read` permission, only the primary allocation is returned with
  `notes` nulled out.
- `relationships.variables` → collection of egg-variable objects (see §10) — **default include**,
  suppressed (`null` resource) if caller lacks `startup.read`.
- `relationships.egg` → single egg object — only with `?include=egg`.
- `relationships.subusers` → collection — only with `?include=subusers`, suppressed if caller
  lacks `user.read`.

Source: `ServerTransformer::includeAllocations/includeVariables/includeEgg/includeSubusers`.

## 5. Resources — `GET /servers/{id}/resources`
Cached server-side for 20s per server UUID. `StatsTransformer` output:
```json
{
  "object": "stats",
  "attributes": {
    "current_state": "running",        // Daemon-reported string, defaults to "stopped" if missing
    "is_suspended": false,
    "resources": {
      "memory_bytes": 0,
      "cpu_absolute": 0.0,
      "disk_bytes": 0,
      "network_rx_bytes": 0,
      "network_tx_bytes": 0,
      "uptime": 0
    }
  }
}
```
`current_state` values come straight from Wings (`environment.ProcessOfflineState` /
`starting` / `running` / `stopping` — observed in Wings source as the strings emitted over the
websocket `status` event, see §12); exact enum of daemon strings is **UNVERIFIED** here since the
Panel just passes through `Arr::get($data, 'state', 'stopped')` with no whitelist. In practice
expect: `offline`, `starting`, `running`, `stopping`.
Source: `app/Http/Controllers/Api/Client/Servers/ResourceUtilizationController.php`,
`app/Transformers/Api/Client/StatsTransformer.php`.

## 6. Websocket token — `GET /servers/{id}/websocket`
Requires permission `websocket.connect` (403 `HttpForbiddenException` if missing). Response:
```json
{ "data": { "token": "<JWT>", "socket": "wss://<node-fqdn>/api/servers/<uuid>/ws" } }
```
- Token expiry: **10 minutes** (`CarbonImmutable::now()->addMinutes(10)`), scope `Websocket`,
  claims `{ server_uuid, permissions: [...] }` (the caller's effective subuser permission strings,
  embedded so Wings can authorize actions without calling back to the Panel).
- If the server has an in-progress node transfer, the socket is redirected to the *new* node once
  archived, and viewing transfer logs additionally requires the `admin.websocket.transfer`
  permission string (server-side; returned in the `permissions` list, not a client-facing REST
  permission constant).
Source: `app/Http/Controllers/Api/Client/Servers/WebsocketController.php`.

## 7. Power — `POST /servers/{id}/power`
Body: `{ "signal": "start" | "stop" | "restart" | "kill" }` (validated against
`Task::POWER_ACTIONS = ['start','stop','restart','kill']`). Required permission is signal-specific
(`control.start` / `control.stop` / `control.restart`, `kill` maps to `control.stop`). Success:
**204 No Content**. No response body.
Source: `app/Http/Controllers/Api/Client/Servers/PowerController.php`,
`app/Http/Requests/Api/Client/Servers/SendPowerRequest.php`.

## 8. Command — `POST /servers/{id}/command`
Body: `{ "command": "say hello" }` (`required|string|min:1`). Requires `control.console`
permission. Success: **204 No Content**.
**If the server is offline**, Wings returns a Guzzle `BadResponseException` with HTTP 502 from the
daemon, which the Panel re-throws as `HttpException(502, "Server must be online in order to send
commands.")`. Any other Wings connection failure surfaces as a generic `DaemonConnectionException`
(500-ish, not further disambiguated here).
Source: `app/Http/Controllers/Api/Client/Servers/CommandController.php`.

## 9. Files (`/servers/{id}/files/...`)
All file endpoints require the caller to hold the relevant `file.*` permission
(`file.read`, `file.read-content`, `file.create`, `file.update`, `file.delete`, `file.archive`).
Path/filename query params (`file=`, `directory=`) should be percent-encoded by the client — the
Panel `rawurldecode()`s the `file` param when building the Wings download-token claim, implying it
expects the raw value it receives to already be URL-encoded on the wire.

| Op | Method & path | Body / query | Response |
|---|---|---|---|
| List directory | `GET .../files/list?directory=` | `directory` optional (default `/`) | `data[]` of `file_object` (see below). **No pagination** — the Panel proxies straight to Wings `GET /api/servers/{uuid}/files/list-directory` and returns the full array; no documented max file-count cap in Panel source (**UNVERIFIED** upper bound — depends on Wings/host). |
| Read contents | `GET .../files/contents?file=` | `file` required | **Raw text body**, `Content-Type: text/plain`, HTTP 200 — NOT a JSON envelope. Server enforces `config('pterodactyl.files.max_edit_size')`, default **4 MiB** (`1024*1024*4`); exceeding it throws `FileSizeTooLargeException` → 400. |
| Download link | `GET .../files/download?file=` | `file` required | `{ "object":"signed_url", "attributes": { "url": "https://<node>/download/file?token=..." } }`. Token expiry **15 minutes**, scope `FileDownload`. Client must then GET that URL directly (goes to Wings, not the Panel). |
| Upload link | `GET .../files/upload` | — | `{ "object":"signed_url", "attributes": { "url": "https://<node>/upload/file?token=..." } }`. Token expiry **15 minutes**, scope `FileUpload`. Client performs the actual multipart upload against Wings directly. |
| Rename/move | `PUT .../files/rename` | `{ "root": string|null, "files": [{ "from": string, "to": string }] }` | 204 |
| Copy | `POST .../files/copy` | `{ "location": string }` | 204 |
| Write | `POST .../files/write?file=` | Raw request body = new file contents (no JSON) | 204 |
| Compress | `POST .../files/compress` | `{ "root"?: string, "files": string[] }` | 200, body = created archive as a `file_object` |
| Decompress | `POST .../files/decompress` | `{ "root"?: string, "file": string }` | 204 (server sets a 300s time limit internally) |
| Delete | `POST .../files/delete` | `{ "root": string|null, "files": string[] }` | 204 |
| Create folder | `POST .../files/create-folder` | `{ "root"?: string, "name": string }` | 204 |
| Chmod | `POST .../files/chmod` | `{ "root": string|null, "files": [{ "file": string, "mode": string }] }` | 204 |
| Pull (remote fetch) | `POST .../files/pull` | `{ "url": string (must be valid URL), "directory"?: string, "filename"?: string, "use_header"?: bool, "foreground"?: bool }` | 204. Gated behind the `FilePull` resource-limit feature flag — may be disabled entirely on some panels. |

**Upload, step 2 (verified 2026-09-08 against `pterodactyl/wings@develop`).** The signed URL
points at the *node*, not the panel: `<scheme>://<node fqdn>:<daemonListen>/upload/file?token=<jwt>`
(`FileUploadController::getUploadUrl`, `Node::getConnectionAddress`). `POST /upload/file` is
registered in `router/router.go` **before** `middleware.RequireAuthorization()`, so it takes no
`Authorization` header — sending the panel key there would leak a panel credential to the node.
`postServerUploadFiles` (`router/router_server_files.go`) reads:

- `c.Query("token")` — the JWT, already embedded in the URL. `UploadPayload.IsUniqueRequest()`
  makes it **single-use**: mint a fresh signed URL for every upload.
- `c.Query("directory")` — the destination directory. A `directory` sent as a *form field*
  instead is ignored and the files land in the server root.
- `form.File["files"]` — the multipart field name is exactly `files`; one part per file, any
  number of them. Each part's `Filename` is joined onto `directory` with `filepath.Join` and is
  **not** passed through `filepath.Base`, so a filename containing `/` writes into a
  subdirectory. Missing parent directories are created by the write.
- Per-file size limit `api.upload_limit`, default **100 MB** (`config/config.go`); a larger part
  is rejected with 400 and a message naming the file. The accumulated total is not checked.

Success is a bare **200 with an empty body** (not 204, no JSON envelope).

`file_object` (`FileObjectTransformer`) shape:
```json
{
  "object": "file_object",
  "attributes": {
    "name": "server.properties",
    "mode": "-rw-r--r--",
    "mode_bits": "644",
    "size": 1234,
    "is_file": true,
    "is_symlink": false,
    "mimetype": "text/plain",
    "created_at": "2024-01-01T00:00:00+00:00",
    "modified_at": "2024-01-01T00:00:00+00:00"
  }
}
```
Source: `app/Http/Controllers/Api/Client/Servers/FileController.php`,
`FileUploadController.php`, `app/Http/Requests/Api/Client/Servers/Files/*.php`,
`app/Transformers/Api/Client/FileObjectTransformer.php`,
`app/Repositories/Wings/DaemonFileRepository.php`, `config/pterodactyl.php` (`max_edit_size`).

## 10. Backups (`/servers/{id}/backups/...`)
| Op | Method & path | Body | Response |
|---|---|---|---|
| List | `GET .../backups?per_page=` | `per_page` clamped to `min(x, 50)`, default 20 | Paginated collection + `meta.backup_count` (count of non-failed backups) |
| Create | `POST .../backups` | `{ "name"?: string(max 191), "ignored"?: string (newline-delimited glob list), "is_locked"?: bool }` — `is_locked` is silently ignored unless caller has `backup.delete` permission | 200, backup object |
| Get one | `GET .../backups/{uuid}` | — | 200, backup object |
| Toggle lock | `POST .../backups/{uuid}/lock` | — (no body; flips current state) | 200, backup object; requires `backup.delete` permission |
| Download | `GET .../backups/{uuid}/download` | — | `{ "object":"signed_url", "attributes": { "url": "..." } }`. Only works for `wings`- or `s3`-disk backups; other disk types → 400 `BadRequestHttpException` |
| Restore | `POST .../backups/{uuid}/restore` | `{ "truncate": bool }` (required) | 204. 400 if server currently mid another operation (`status` non-null) or backup not `is_successful`/`completed_at` null |
| Delete | `DELETE .../backups/{uuid}` | — | 204 |

`BackupTransformer` fields:
```
uuid, is_successful, is_locked, name, ignored_files, checksum, bytes,
created_at (ISO8601), completed_at (ISO8601 | null)
```
Source: `app/Http/Controllers/Api/Client/Servers/BackupController.php`,
`app/Http/Requests/Api/Client/Servers/Backups/*.php`,
`app/Transformers/Api/Client/BackupTransformer.php`.

## 11. Schedules (`/servers/{id}/schedules/...`)
| Op | Method & path | Body |
|---|---|---|
| List | `GET .../schedules` | tasks are **default-included** |
| Create | `POST .../schedules` | `{ "name", "is_active": bool, "only_when_online"?: bool, "minute", "hour", "day_of_month", "day_of_week" }` — cron-style strings (e.g. `"*/5"`); note: request rules do **not** validate a `month` field even though the controller reads `$request->input('month')` into `cron_month` — in practice month is effectively unused/always `*` for schedules created via this endpoint (**flag: minor inconsistency observed in source**, not independently explained) |
| Get one | `GET .../schedules/{id}` | — |
| Update | `POST .../schedules/{id}` | same body shape as create |
| Execute now | `POST .../schedules/{id}/execute` | — → **202 Accepted** |
| Delete | `DELETE .../schedules/{id}` | — → 204 |
| Add task | `POST .../schedules/{id}/tasks` | `{ "action": "command"\|"power"\|"backup", "payload": string (required unless action=backup; must be one of start/stop/restart/kill if action=power), "time_offset": number (0-900), "sequence_id"?: number, "continue_on_failure"?: bool }` |
| Update task | `POST .../schedules/{id}/tasks/{task}` | same body as add |
| Delete task | `DELETE .../schedules/{id}/tasks/{task}` | — → 204 |

Per-schedule task limit defaults to 10 (`pterodactyl.client_features.schedules.per_schedule_task_limit`),
exceeding it → error (`ServiceLimitExceededException`).

`ScheduleTransformer`:
```json
{
  "id": 1, "name": "Nightly restart",
  "cron": { "day_of_week": "*", "day_of_month": "*", "month": "*", "hour": "3", "minute": "0" },
  "is_active": true, "is_processing": false, "only_when_online": true,
  "last_run_at": "2024-01-01T03:00:00+00:00", "next_run_at": "2024-01-02T03:00:00+00:00",
  "created_at": "...", "updated_at": "...",
  "relationships": { "tasks": { "object": "list", "data": [ /* task objects */ ] } }
}
```
`TaskTransformer`:
```
id, sequence_id, action ("command"|"power"|"backup"), payload, time_offset,
is_queued, continue_on_failure, created_at, updated_at
```
Source: `app/Http/Controllers/Api/Client/Servers/ScheduleController.php`,
`ScheduleTaskController.php`, `app/Http/Requests/Api/Client/Servers/Schedules/*.php`,
`app/Transformers/Api/Client/ScheduleTransformer.php`, `TaskTransformer.php`,
`app/Models/Task.php` (`POWER_ACTIONS`).

## 12. Network allocations (`/servers/{id}/network/allocations`)
| Op | Method & path | Body |
|---|---|---|
| List | `GET .../network/allocations` | — |
| Create (auto-assign) | `POST .../network/allocations` | — (server picks a free allocation automatically); 400 `DisplayException` if `allocation_limit` reached |
| Update notes | `POST .../network/allocations/{id}` | `{ "notes": string|null }` (`present`) |
| Set primary | `POST .../network/allocations/{id}/primary` | — |
| Delete | `DELETE .../network/allocations/{id}` | — → 204. 400 if no `allocation_limit` configured, or target is the primary allocation |

`AllocationTransformer`:
```
id: number, ip: string, ip_alias: string|null, port: number, notes: string|null,
is_default: bool   // true iff this allocation is the server's current primary
```
Source: `app/Http/Controllers/Api/Client/Servers/NetworkAllocationController.php`,
`app/Transformers/Api/Client/AllocationTransformer.php`.

## 13. Startup / egg variables (`/servers/{id}/startup`)
`GET .../startup` → `data[]` of egg-variable objects + meta:
```json
{
  "object": "list",
  "data": [ { "object": "egg_variable", "attributes": {
      "name": "Server Jar File",
      "description": "...",
      "env_variable": "SERVER_JARFILE",
      "default_value": "server.jar",
      "server_value": "paper.jar",
      "is_editable": true,
      "rules": "required|string|max:20"
  } } ],
  "meta": {
    "startup_command": "java -jar {{SERVER_JARFILE}}",
    "docker_images": { "Java 17": "ghcr.io/...":  "..." },
    "raw_startup_command": "java -jar {{SERVER_JARFILE}} ..."
  }
}
```
Only variables with `user_viewable = true` are returned; hidden vars are never exposed to the
client API.
`PUT .../startup/variable` body `{ "key": env_variable_name, "value": string }`. Server re-validates
`value` against the variable's own `rules` string; 400 if variable doesn't exist / isn't viewable,
or isn't `user_editable`. Response mirrors the single-variable object + `meta.startup_command` /
`meta.raw_startup_command`.
Source: `app/Http/Controllers/Api/Client/Servers/StartupController.php`,
`app/Transformers/Api/Client/EggVariableTransformer.php`.

## 14. Account — `GET /account`
```json
{ "object": "user", "attributes": {
    "id": 1, "admin": false, "username": "admin", "email": "user@example.com",
    "first_name": "Alex", "last_name": "Example", "language": "en"
} }
```
No special permission required beyond a valid bearer token — good lightweight **auth/connectivity
check** for an MCP server on startup (200 = key valid; 401 = invalid/expired key).
Source: `app/Http/Controllers/Api/Client/AccountController.php`,
`app/Transformers/Api/Client/AccountTransformer.php`.

---

## 15. Wings websocket protocol

Source (Wings, branch `develop`): `router/websocket/message.go`, `websocket.go`, `listeners.go`,
`limiter.go`
(https://raw.githubusercontent.com/pterodactyl/wings/develop/router/websocket/{message,websocket,listeners,limiter}.go)
and `config/config.go`.

### Message envelope
Every frame, both directions, is JSON:
```json
{ "event": "<event name>", "args": ["<string>", ...] }
```
`args` is always an array of **strings** (even for structured payloads like stats/status — those
are JSON-encoded into `args[0]` as a string, e.g. `args: ["{\"state\":\"running\",...}"]`).
Wings sets a 4096-byte read limit per frame on the connection (`conn.SetReadLimit(4096)`) — keep
outbound command/auth frames small.

### Connection flow
1. `GET /servers/{id}/websocket` on the **Panel** → `{ token, socket }` (§6).
2. Open a WebSocket to `socket` (a `wss://` URL pointed at the *node*, not the panel).
   - **Origin header**: Wings' `CheckOrigin` upgrader callback requires the WebSocket handshake's
     `Origin` header to exactly equal the node's configured `PanelLocation` (the panel's base URL,
     from Wings' own `config.yml`), OR to appear in Wings' `AllowedOrigins` list (which also
     accepts a literal `"*"` entry). **A non-browser TypeScript client (e.g. Node.js `ws` library)
     must therefore send an `Origin` header equal to the panel's URL, or the handshake will be
     rejected by Wings before any messages are exchanged.** Confirmed in
     `router/websocket/websocket.go::GetHandler`.
3. Send `{"event":"auth","args":["<token>"]}` using the token from step 1.
4. Wings replies `{"event":"auth success"}`. On this *first* successful auth on a given TCP
   connection, Wings immediately also pushes one `{"event":"status","args":["<state>"]}` frame,
   and — only if the server is currently offline (and not installing/transferring) — one
   `{"event":"stats","args":["<json>"]}` frame with current disk usage.
5. Send `{"event":"send logs","args":[]}` to request console backlog. Wings replies with a
   **burst of `console output` events**, one per buffered line (only if the server's environment is
   currently running — if offline, this event is silently ignored and produces no output).
   Backlog size = **150 lines by default** (`WebsocketLogCount int` `default:"150"` in Wings
   `config.yml` → `system.websocket_log_count`; admin-configurable per node).
6. After that, Wings streams events continuously as they occur (no need to re-request).

### Events the client sends
| Event | Args | Notes |
|---|---|---|
| `auth` | `[jwt]` | Required first message; also used to **re-authenticate on token refresh** (see below) — sent again on the *same* open socket, does not require reconnecting. Rate-limited to 2 per 5 seconds. |
| `send logs` | `[]` | Request console backlog. Rate-limited to 2 per 5 seconds. Requires server to be running. |
| `send stats` | `[]` | Request an immediate stats snapshot (also pushed automatically on a timer server-side outside this handler). |
| `send command` | `[command string]` | Requires `control.console` in the JWT's embedded permission list; ignored (no-op, no error) if server is offline or (for Docker) not yet attached. Rate-limited to 10/sec. |
| `set state` | `[start\|stop\|restart\|kill]` (Wings power-action strings; `kill`→internal terminate) | Requires the matching `control.start`/`control.stop`/`control.restart` permission in the JWT; if another power action is mid-flight, Wings sends back an `daemon error` event instead of executing. Default rate limit 4/sec (shared bucket). |

All non-auth events sent before a valid/unexpired JWT is on the connection are answered with a
`jwt error` event instead of being processed (`HandleInbound` checks `TokenValid()` first).

### Events the client receives
| Event | Args[0] payload | Meaning |
|---|---|---|
| `auth success` | — | Auth accepted |
| `token expiring` | — | Sent once, 60 seconds before the JWT expires (checked every 30s server-side) — client should fetch a fresh token from the Panel (`GET /servers/{id}/websocket` again) and send a new `auth` event **on the same socket** |
| `token expired` | — | JWT has fully expired; further non-auth commands will be rejected until re-authenticated |
| `console output` | raw log line (string) | One event per line, both live and backlog |
| `install output` | raw install-script log line | Only forwarded if the JWT's permission list includes `admin.websocket.install` |
| `status` | one of the daemon's process-state strings | Sent on auth and whenever state changes |
| `stats` | JSON-encoded string: `{"memory_bytes":...,"memory_limit_bytes":...,"cpu_absolute":...,"network":{"rx_bytes":...,"tx_bytes":...},"state":"...","disk_bytes":...}` (**field names UNVERIFIED beyond what the Panel's `StatsTransformer` reads: `state`, `is_suspended`, `utilization.memory_bytes`, `utilization.cpu_absolute`, `utilization.disk_bytes`, `utilization.network.rx_bytes`, `utilization.network.tx_bytes`, `utilization.uptime`** — the exact raw Wings JSON key names were not independently pulled from Wings' `server.Proc()` struct in this pass) | Periodic + on-demand resource stats |
| `daemon message` | string | Misc daemon-originated message |
| `daemon error` | string (only the real error text if JWT has `admin.websocket.errors`, else a generic redacted message + a UUID for correlation) | Error during processing of a client event |
| `jwt error` | string | Auth/token problem (expired, wrong server uuid, missing connect permission, denylisted) |
| `backup completed` / `backup restore completed` | string/JSON | Only if JWT has `backup.read` permission |
| `transfer logs` / `transfer status` | string | Only if JWT has `admin.websocket.transfer` permission (node-transfer scenarios) |
| `throttled` | `[event name]` | Sent (at most once per throttling window) when the *client* is sending a given event type too fast; the offending inbound message is simply dropped, no error thrown |

### Re-auth flow (token refresh) — concrete sequence
1. Client is holding an open, authenticated socket.
2. Wings sends `{"event":"token expiring"}` ~60s before the original 10-minute JWT (from §6)
   expires.
3. Client calls `GET /api/client/servers/{id}/websocket` on the **Panel** again to mint a fresh
   JWT (same socket URL, new token, another 10-minute expiry).
4. Client sends `{"event":"auth","args":["<new token>"]}` on the **same still-open** WebSocket
   (no reconnect). Wings replies `auth success` again but — because this is a *reconnection of an
   already-authenticated* session, not first-auth — does **not** re-send `status`/`stats`, so no
   duplicate console-history burst occurs.
5. If the client misses the window and the token fully expires, Wings starts rejecting non-auth
   events with `jwt error`; sending a valid new `auth` recovers the session without needing a new
   TCP connection.

Source citations for this section: as listed above; `PanelLocation`/`AllowedOrigins`/
`WebsocketLogCount` fields confirmed in
https://raw.githubusercontent.com/pterodactyl/wings/develop/config/config.go.

---

## 16. Open items / unverified

- Exact raw JSON field names inside the Wings `stats` websocket event payload (as opposed to the
  Panel REST `/resources` shape, which **is** fully verified via `StatsTransformer`) — not pulled
  from Wings' `server.Proc()`/`ResourceUsage` struct in this pass. Treat the REST `/resources`
  endpoint as authoritative for field names; treat the websocket `stats` event as "same data,
  probably nested under a different top-level key" until confirmed against a live Wings response.
- Exact enum of `current_state` / websocket `status` strings — expected `offline`, `starting`,
  `running`, `stopping` by convention, not enumerated as a closed Go string-const in the files
  fetched.
- Any hard cap on `files/list` response size/count — none found in Panel source (it is not
  paginated by the Panel); Wings itself may or may not cap it — unverified.
- Rate limit default discrepancy: source (256/min) vs. community docs (240/min) — see §3.
- `Accept: Application/vnd.pterodactyl.v1+json` header requirement is standard Pterodactyl
  convention (community docs) but its exact enforcement/necessity was not traced through a content
  negotiation middleware in this pass — sending it is safe and recommended regardless.
