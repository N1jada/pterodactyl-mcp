#!/usr/bin/env node
/**
 * Mock Pterodactyl Panel — enough of the Client API (`/api/client/...`) plus a Wings
 * console websocket to drive the whole MCP server end to end without a live panel.
 *
 * Shapes follow docs/pterodactyl-api.md exactly (fractal envelopes, error envelope,
 * 204s, raw-text file contents, signed URLs, §15 websocket protocol).
 *
 *   node test/mock-panel/server.mjs [port]     # default 4567, `0` = pick a free port
 *
 * The chosen base URL is printed on stderr as `MOCK_PANEL_URL=http://127.0.0.1:<port>`.
 * Everything is in memory; nothing is persisted and nothing touches the real filesystem.
 *
 * Plain ESM JavaScript on purpose: no build step, so it can be started straight from a
 * shell script before `dist/` even exists.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const API_KEY = 'mock-key';
const SERVER_ID = '1a2b3c4d';
const SERVER_UUID = '1a2b3c4d-9f4a-4d1e-9a3b-5f2c7e0d1a44';
const RATE_LIMIT = 256;
const ESC = String.fromCharCode(27);

/* -------------------------------------------------------------------------- */
/* Console log fixture                                                        */
/* -------------------------------------------------------------------------- */

/** ~300 lines of plausible Paper/Geyser boot output, oldest first. */
function buildLatestLog() {
  const lines = [];
  const stamp = (n) => {
    const total = 3 + n * 2;
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `[12:${m}:${s}]`;
  };
  let i = 0;
  const push = (text) => lines.push(`${stamp(i++)} ${text}`);

  push('[ServerMain/INFO]: Starting minecraft server version 1.21.x');
  push('[ServerMain/INFO]: Java version 21.0.4, OpenJDK 64-Bit Server VM (Eclipse Adoptium)');
  push('[ServerMain/INFO]: Loading properties');
  push('[Server thread/INFO]: Default game type: SURVIVAL');
  push('[Server thread/INFO]: Generating keypair');
  push('[Server thread/INFO]: Starting Minecraft server on 0.0.0.0:25565');
  push('[Server thread/INFO]: Using epoll channel type');
  push('[Server thread/INFO]: Paper: Using OpenSSL 3.0.x for encryption');
  push('[Server thread/INFO]: [floodgate] Loading floodgate v2.2.4-SNAPSHOT');
  push('[Server thread/INFO]: [Geyser-Spigot] Loading Geyser-Spigot v2.4.2-SNAPSHOT');
  push('[Server thread/INFO]: Preparing level "world"');
  push('[Server thread/INFO]: Preparing start region for dimension minecraft:overworld');
  push('[Server thread/INFO]: Time elapsed: 1423 ms');
  push('[Server thread/INFO]: Preparing start region for dimension minecraft:the_nether');
  push('[Server thread/INFO]: Time elapsed: 311 ms');
  push('[Server thread/INFO]: Preparing start region for dimension minecraft:the_end');
  push('[Server thread/INFO]: Time elapsed: 208 ms');
  push('[Server thread/INFO]: [floodgate] Took 84ms to boot floodgate');
  push('[Server thread/INFO]: [Geyser-Spigot] ******************************************');
  push('[Server thread/INFO]: [Geyser-Spigot] Loading extensions...');
  push('[Server thread/INFO]: [Geyser-Spigot] Loaded 0 extension(s)');
  push('[Server thread/INFO]: [Geyser-Spigot] Started Geyser on 0.0.0.0:19132');
  push('[Server thread/INFO]: [Geyser-Spigot] Done (2.104s)! Run /geyser help for help!');
  push('[Server thread/INFO]: Done (6.812s)! For help, type "help"');
  push('[Server thread/INFO]: Timings Reset');

  const filler = [
    'UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5',
    'Steve joined the game',
    'Steve[/10.0.0.14:52233] logged in with entity id 412 at (128.5, 68.0, -344.2)',
    'Saving chunks for level ServerLevel[world]',
    'Saved the game',
    '[floodgate] Floodgate player logged in as .BedrockUser joined the game',
    'Alex lost connection: Disconnected',
    'Alex left the game',
    '[Geyser-Spigot] .BedrockUser (Xbox) has connected to remote java server on account .BedrockUser',
    'Can\'t keep up! Is the server overloaded? Running 2143ms or 42 ticks behind',
    'ThreadedAnvilChunkStorage (world): All chunks are saved',
    'Steve has made the advancement [Stone Age]',
  ];
  while (lines.length < 300) {
    push(`[Server thread/INFO]: ${filler[lines.length % filler.length]}`);
  }
  return lines.join('\n') + '\n';
}

const LATEST_LOG = buildLatestLog();

/* -------------------------------------------------------------------------- */
/* In-memory state                                                            */
/* -------------------------------------------------------------------------- */

const NOW = () => new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
const T0 = '2026-09-01T09:14:02+00:00';

const state = {
  power: 'running',
  uptimeMs: 3 * 60 * 60 * 1000,
  requests: 0,
  wsConnections: 0,
  wsAuths: 0,
  wsCommands: 0,
  websocketTokenRequests: 0,
  commandsSent: [],
  powerSignals: [],
};

/** Virtual filesystem: path -> entry. Directories are implicit plus `dirs`. */
const files = new Map();
const dirs = new Set(['plugins', 'logs', 'world', 'plugins/Geyser-Spigot', 'plugins/floodgate']);

function addFile(path, content, mimetype = 'text/plain', size) {
  files.set(path, {
    content,
    mimetype,
    size: size ?? Buffer.byteLength(content, 'utf8'),
    created_at: T0,
    modified_at: T0,
  });
}

function seedFiles() {
  files.clear();
  dirs.clear();
  for (const d of ['plugins', 'logs', 'world', 'plugins/Geyser-Spigot', 'plugins/floodgate']) {
    dirs.add(d);
  }

  addFile(
    'server.properties',
    [
      '#Minecraft server properties',
      'server-port=25565',
      'motd=Survival',
      'max-players=40',
      'view-distance=10',
      'online-mode=true',
      'difficulty=normal',
      'level-name=world',
      '',
    ].join('\n'),
  );
  addFile('ops.json', JSON.stringify([{ uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Steve', level: 4, bypassesPlayerLimit: false }], null, 2) + '\n', 'application/json');
  addFile('test.txt', 'scratch file for the inspector smoke test\n');
  addFile(
    'plugins/Geyser-Spigot/config.yml',
    ['bedrock:', '  port: 19132', '  motd1: "Survival"', '  motd2: "Bedrock welcome"', '', 'remote:', '  address: auto', '  port: 25565', '  auth-type: floodgate', ''].join('\n'),
    'text/yaml',
  );
  addFile(
    'plugins/floodgate/config.yml',
    ['# Floodgate configuration', 'username-prefix: "."', 'replace-spaces: true', 'disconnect:', '  invalid-key: "Invalid Floodgate key"', ''].join('\n'),
    'text/yaml',
  );
  addFile('plugins/Geyser-Spigot.jar', '', 'application/java-archive', 11_482_311);
  addFile('plugins/floodgate-spigot.jar', '', 'application/java-archive', 1_204_887);
  addFile('logs/latest.log', LATEST_LOG);
  addFile('world/level.dat', '', 'application/octet-stream', 16_384);
}
seedFiles();

const backups = [
  {
    uuid: '7f0f1e64-2b32-4b64-9c4d-1a1de7d0b3c1',
    is_successful: true,
    is_locked: false,
    name: 'nightly-2026-09-04',
    ignored_files: [],
    checksum: 'sha256:9f2c1d4b8e3a7c5f1029384756abcdef0123456789abcdef0123456789abcdef',
    bytes: 734_003_200,
    created_at: '2026-09-04T03:00:00+00:00',
    completed_at: '2026-09-04T03:06:41+00:00',
  },
  {
    uuid: 'c1b2a3d4-5e6f-4708-9a0b-1c2d3e4f5061',
    is_successful: true,
    is_locked: true,
    name: 'pre-1.21-upgrade (locked)',
    ignored_files: ['logs/**'],
    checksum: 'sha256:0123456789abcdef0123456789abcdef9f2c1d4b8e3a7c5f1029384756abcdef',
    bytes: 689_182_720,
    created_at: '2026-08-28T21:11:00+00:00',
    completed_at: '2026-08-28T21:18:07+00:00',
  },
];

const allocations = [
  { id: 41, ip: '203.0.113.10', ip_alias: null, port: 25565, notes: null, is_default: true },
  { id: 42, ip: '203.0.113.10', ip_alias: null, port: 19132, notes: 'Geyser', is_default: false },
];

const schedules = [
  {
    id: 7,
    name: 'Nightly restart',
    cron: { minute: '0', hour: '5', day_of_month: '*', month: '*', day_of_week: '*' },
    is_active: true,
    is_processing: false,
    only_when_online: true,
    last_run_at: '2026-09-05T05:00:00+00:00',
    next_run_at: '2026-09-06T05:00:00+00:00',
    created_at: T0,
    updated_at: T0,
    tasks: [
      { id: 11, sequence_id: 1, action: 'command', payload: 'say Restarting in 60 seconds', time_offset: 0, is_queued: false, continue_on_failure: true },
      { id: 12, sequence_id: 2, action: 'power', payload: 'restart', time_offset: 60, is_queued: false, continue_on_failure: false },
    ],
  },
];

const startupVariables = [
  {
    name: 'Server Jar File',
    description: 'The name of the server jarfile to run the server with.',
    env_variable: 'SERVER_JARFILE',
    default_value: 'server.jar',
    server_value: 'paper.jar',
    is_editable: true,
    rules: 'required|regex:/^([\\w\\d._-]+)(\\.jar)$/',
  },
  {
    name: 'Server Memory',
    description: 'Heap size handed to the JVM, in MiB.',
    env_variable: 'MEMORY',
    default_value: '4096',
    server_value: '7168',
    is_editable: true,
    rules: 'required|integer|min:512',
  },
  {
    name: 'Minecraft Version',
    description: 'The version of Paper to download on boot. `latest` tracks the newest build.',
    env_variable: 'MINECRAFT_VERSION',
    default_value: 'latest',
    server_value: '1.21.4',
    is_editable: true,
    rules: 'required|string|max:20',
  },
  {
    name: 'Build Number',
    description: 'Paper build to pull. `latest` for the newest.',
    env_variable: 'BUILD_NUMBER',
    default_value: 'latest',
    server_value: 'latest',
    is_editable: false,
    rules: 'required|string|max:20',
  },
];

/* -------------------------------------------------------------------------- */
/* Envelope helpers                                                           */
/* -------------------------------------------------------------------------- */

const item = (object, attributes, meta) => ({ object, attributes, ...(meta ? { meta } : {}) });
const list = (data, meta) => ({ object: 'list', data, ...(meta ? { meta } : {}) });

function pagination(total, perPage = 50, page = 1) {
  return {
    pagination: {
      total,
      count: total,
      per_page: perPage,
      current_page: page,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
      links: {},
    },
  };
}

function errorEnvelope(status, code, detail, meta) {
  return { errors: [{ code, status: String(status), detail, ...(meta ? { meta } : {}) }] };
}

function serverAttributes() {
  return {
    server_owner: true,
    identifier: SERVER_ID,
    __deprecated_uuid_short: SERVER_ID,
    server_identifier: SERVER_ID,
    internal_id: 12,
    uuid: SERVER_UUID,
    name: 'Survival',
    node: 'eu-1',
    is_node_under_maintenance: false,
    sftp_details: { ip: '203.0.113.10', port: 2022 },
    description: 'Java + Bedrock (Geyser) survival server',
    limits: { memory: 8192, swap: 0, disk: 51200, io: 500, cpu: 300, threads: null, oom_disabled: true },
    invocation: 'java -Xms128M -Xmx7168M -jar paper.jar',
    docker_image: 'ghcr.io/pterodactyl/yolks:java_21',
    egg_features: ['eula', 'java_version', 'pid_limit'],
    feature_limits: { databases: 2, allocations: 4, backups: 5 },
    status: null,
    is_suspended: false,
    is_installing: false,
    is_transferring: false,
    skip_scripts: false,
    relationships: {
      allocations: list(allocations.map((a) => item('allocation', { ...a }))),
      variables: list(startupVariables.map((v) => item('egg_variable', { ...v }))),
    },
  };
}

function resourcesAttributes() {
  const running = state.power === 'running' || state.power === 'starting';
  return {
    current_state: state.power,
    is_suspended: false,
    resources: {
      memory_bytes: running ? Math.round(3.2 * 1024 * 1024 * 1024) : 0,
      cpu_absolute: running ? 42.5 : 0,
      disk_bytes: 18_253_611_008,
      network_rx_bytes: running ? 91_224_113 : 0,
      network_tx_bytes: running ? 412_889_004 : 0,
      uptime: running ? state.uptimeMs : 0,
    },
  };
}

function backupItem(b) {
  return item('backup', {
    uuid: b.uuid,
    is_successful: b.is_successful,
    is_locked: b.is_locked,
    name: b.name,
    ignored_files: b.ignored_files,
    checksum: b.checksum,
    bytes: b.bytes,
    created_at: b.created_at,
    completed_at: b.completed_at,
  });
}

/* -------------------------------------------------------------------------- */
/* Virtual filesystem helpers                                                 */
/* -------------------------------------------------------------------------- */

function normalise(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('/');
}

function parentOf(p) {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

function baseOf(p) {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

function joinPath(root, name) {
  const r = normalise(root);
  const n = normalise(name);
  return r === '' ? n : `${r}/${n}`;
}

/** `a/b/c` -> `['a', 'a/b', 'a/b/c']`. Wings creates missing parents on upload. */
function ancestorsOf(p) {
  const parts = normalise(p).split('/').filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

function fileObject(name, entry, isFile) {
  return item('file_object', {
    name,
    mode: isFile ? '-rw-r--r--' : 'drwxr-xr-x',
    mode_bits: isFile ? '644' : '755',
    size: isFile ? entry.size : 0,
    is_file: isFile,
    is_symlink: false,
    mimetype: isFile ? entry.mimetype : 'inode/directory',
    created_at: isFile ? entry.created_at : T0,
    modified_at: isFile ? entry.modified_at : T0,
  });
}

function listDirectory(directory) {
  const dir = normalise(directory);
  if (dir !== '' && !dirs.has(dir)) return null;
  const out = [];
  for (const d of dirs) {
    if (parentOf(d) === dir) out.push(fileObject(baseOf(d), null, false));
  }
  for (const [path, entry] of files) {
    if (parentOf(path) === dir) out.push(fileObject(baseOf(path), entry, true));
  }
  out.sort((a, b) => {
    if (a.attributes.is_file !== b.attributes.is_file) return a.attributes.is_file ? 1 : -1;
    return a.attributes.name.localeCompare(b.attributes.name);
  });
  return out;
}

function deletePath(path) {
  let removed = 0;
  if (files.delete(path)) removed += 1;
  if (dirs.has(path)) {
    dirs.delete(path);
    removed += 1;
    for (const child of [...dirs]) if (child.startsWith(`${path}/`)) dirs.delete(child);
    for (const child of [...files.keys()]) if (child.startsWith(`${path}/`)) files.delete(child);
  }
  return removed > 0;
}

/** The panel's copy naming: `config.yml` -> `config copy.yml` -> `config copy 2.yml`. */
function copyName(path) {
  const base = baseOf(path);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const dir = parentOf(path);
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`;
    const full = dir === '' ? candidate : `${dir}/${candidate}`;
    if (!files.has(full) && !dirs.has(full)) return full;
  }
  return `${path}.copy`;
}

/* -------------------------------------------------------------------------- */
/* HTTP plumbing                                                              */
/* -------------------------------------------------------------------------- */

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 8 * 1024 * 1024) chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/** Like `readBody`, but keeps the bytes — a multipart upload body is not text. */
function readBodyBuffer(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 128 * 1024 * 1024) chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

/**
 * Minimal `multipart/form-data` parser — enough to check the field name, the filename and
 * the exact bytes of each part. Returns `null` if the body is not multipart at all.
 */
function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType));
  if (!/multipart\/form-data/i.test(String(contentType)) || !match) return null;
  const boundary = `--${(match[1] ?? match[2]).trim()}`;
  const parts = [];
  let cursor = buffer.indexOf(boundary);
  if (cursor === -1) return null;
  cursor += boundary.length;
  for (;;) {
    if (buffer.slice(cursor, cursor + 2).toString() === '--') break; // closing boundary
    cursor += 2; // CRLF after the boundary line
    const headerEnd = buffer.indexOf('\r\n\r\n', cursor);
    if (headerEnd === -1) break;
    const headers = buffer.slice(cursor, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const next = buffer.indexOf(boundary, bodyStart);
    if (next === -1) break;
    const data = buffer.slice(bodyStart, next - 2); // strip the CRLF before the boundary
    const name = /name="([^"]*)"/i.exec(headers);
    const filename = /filename="([^"]*)"/i.exec(headers);
    const partType = /content-type:\s*([^\r\n]+)/i.exec(headers);
    parts.push({
      name: name ? name[1] : '',
      filename: filename ? filename[1] : undefined,
      contentType: partType ? partType[1].trim() : undefined,
      data,
    });
    cursor = next + boundary.length;
  }
  return parts;
}

function rateLimitHeaders() {
  state.requests += 1;
  return {
    'X-RateLimit-Limit': String(RATE_LIMIT),
    'X-RateLimit-Remaining': String(Math.max(0, RATE_LIMIT - (state.requests % RATE_LIMIT))),
    'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 60),
  };
}

function send(res, status, body, contentType = 'application/json') {
  const headers = { ...rateLimitHeaders() };
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  headers['Content-Type'] = contentType;
  headers['Content-Length'] = String(Buffer.byteLength(payload, 'utf8'));
  res.writeHead(status, headers);
  res.end(payload);
}

const sendError = (res, status, code, detail, meta) =>
  send(res, status, errorEnvelope(status, code, detail, meta));

/* -------------------------------------------------------------------------- */
/* Routing                                                                    */
/* -------------------------------------------------------------------------- */

async function route(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method ?? 'GET';

  /* Mock introspection — deliberately unauthenticated, outside /api/client. */
  if (pathname === '/__mock/state') {
    return send(res, 200, {
      power_state: state.power,
      requests: state.requests,
      ws_connections: state.wsConnections,
      ws_auths: state.wsAuths,
      ws_commands: state.wsCommands,
      websocket_token_requests: state.websocketTokenRequests,
      commands_sent: state.commandsSent,
      power_signals: state.powerSignals,
      backups: backups.map((b) => ({ uuid: b.uuid, name: b.name, is_locked: b.is_locked, completed_at: b.completed_at })),
      files: [...files.keys()].sort(),
      dirs: [...dirs].sort(),
    });
  }
  if (pathname === '/__mock/reset' && method === 'POST') {
    seedFiles();
    state.power = 'running';
    return send(res, 200, { ok: true });
  }

  /*
   * Wings' own upload endpoint, NOT part of the panel API — the signed URL handed out by
   * `GET /api/client/servers/{id}/files/upload` points here. Deliberately unauthenticated
   * by bearer token: Wings registers `POST /upload/file` outside its authorization
   * middleware and authenticates from the `token` query param instead
   * (`router/router.go`, `postServerUploadFiles` in `router/router_server_files.go`).
   */
  if (pathname === '/upload/file') {
    if (method !== 'POST') {
      return send(res, 405, { error: 'The requested resource was not found on this server.' });
    }
    if (searchParams.get('token') !== 'mock.upload.token') {
      return send(res, 404, { error: 'The requested resource was not found on this server.' });
    }
    if (req.headers['authorization']) {
      // The panel key must never be sent to the node; fail loudly if it is.
      return send(res, 400, { error: 'Unexpected Authorization header on a signed-URL route.' });
    }
    const directory = normalise(searchParams.get('directory') ?? '');
    const raw = await readBodyBuffer(req);
    const parts = parseMultipart(raw, req.headers['content-type'] ?? '');
    if (parts === null) {
      return send(res, 400, { error: 'Failed to get multipart form data from request.' });
    }
    const uploads = parts.filter((p) => p.name === 'files');
    if (uploads.length === 0) {
      return send(res, 400, { error: 'No files were found on the request body.' });
    }
    for (const part of uploads) {
      if (part.filename === undefined || part.filename === '') {
        return send(res, 400, { error: 'No files were found on the request body.' });
      }
      if (part.data.length > 100 * 1024 * 1024) {
        return send(res, 400, {
          error: `File ${part.filename} is larger than the maximum file upload size of 100 MB.`,
        });
      }
      // Wings joins the part's filename onto `directory` verbatim (no filepath.Base).
      const target = joinPath(directory, part.filename);
      const parent = parentOf(target);
      if (parent !== '') for (const d of ancestorsOf(parent)) dirs.add(d);
      // The virtual FS stores text; keep the byte length exact so `files/list` (and hence
      // any size verification after an upload) reports what was actually received.
      addFile(target, part.data.toString('utf8'), part.contentType ?? 'application/octet-stream', part.data.length);
      files.get(target).modified_at = NOW();
    }
    // Wings returns a bare 200 with an empty body on success.
    res.writeHead(200);
    return res.end();
  }

  if (!pathname.startsWith('/api/client')) {
    return sendError(res, 404, 'NotFoundHttpException', 'The requested resource could not be found.');
  }

  /* Auth: every /api/client route needs the bearer token. */
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${API_KEY}`) {
    return sendError(res, 401, 'AuthenticationException', 'Unauthenticated.');
  }

  const rest = pathname.slice('/api/client'.length);

  if (rest === '' || rest === '/') {
    if (method !== 'GET') return sendError(res, 405, 'MethodNotAllowedHttpException', `The ${method} method is not supported for this route.`);
    const page = Number(searchParams.get('page') ?? '1');
    if (page > 1) return send(res, 200, list([], pagination(1, 50, page)));
    return send(res, 200, list([item('server', serverAttributes())], pagination(1, 50, 1)));
  }

  if (rest === '/account') {
    return send(
      res,
      200,
      item('user', {
        id: 1,
        admin: false,
        username: 'admin',
        email: 'admin@example.test',
        first_name: 'Alex',
        last_name: 'Example',
        language: 'en',
      }),
    );
  }

  const serverMatch = /^\/servers\/([^/]+)(\/.*)?$/.exec(rest);
  if (!serverMatch) {
    return sendError(res, 404, 'NotFoundHttpException', 'The requested resource could not be found.');
  }

  const id = decodeURIComponent(serverMatch[1]);
  const tail = serverMatch[2] ?? '';

  if (id !== SERVER_ID) {
    return sendError(res, 404, 'ModelNotFoundException', `No server matching identifier "${id}" was found for this account.`);
  }

  /* ---- server ---------------------------------------------------------- */
  if (tail === '') {
    return send(
      res,
      200,
      item('server', serverAttributes(), {
        is_server_owner: true,
        user_permissions: ['control.console', 'control.start', 'control.stop', 'control.restart', 'file.read', 'file.read-content', 'file.create', 'file.update', 'file.delete', 'backup.read', 'backup.create', 'backup.delete', 'websocket.connect'],
      }),
    );
  }

  if (tail === '/resources') {
    return send(res, 200, item('stats', resourcesAttributes()));
  }

  if (tail === '/websocket') {
    state.websocketTokenRequests += 1;
    const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ server_uuid: SERVER_UUID, iat: Date.now(), n: state.websocketTokenRequests })).toString('base64url')}.mockmocksignature`;
    return send(res, 200, { data: { token, socket: `ws://127.0.0.1:${boundPort}/ws` } });
  }

  /* ---- power ----------------------------------------------------------- */
  if (tail === '/power' && method === 'POST') {
    const body = safeJson(await readBody(req));
    const signal = body?.signal;
    if (!['start', 'stop', 'restart', 'kill'].includes(signal)) {
      return sendError(res, 422, 'ValidationException', 'The given data was invalid.', {
        source_field: 'signal',
        rule: 'in',
      });
    }
    state.powerSignals.push(signal);
    if (signal === 'start' || signal === 'restart') {
      state.power = 'running';
      state.uptimeMs = 1000;
    } else {
      state.power = 'offline';
      state.uptimeMs = 0;
    }
    broadcast('status', [state.power]);
    return send(res, 204);
  }

  /* ---- command --------------------------------------------------------- */
  if (tail === '/command' && method === 'POST') {
    const body = safeJson(await readBody(req));
    const command = body?.command;
    if (typeof command !== 'string' || command.length === 0) {
      return sendError(res, 422, 'ValidationException', 'The given data was invalid.', {
        source_field: 'command',
        rule: 'required',
      });
    }
    if (state.power !== 'running') {
      return sendError(res, 502, 'HttpException', 'Server must be online in order to send commands.');
    }
    state.commandsSent.push(command);
    broadcast('console output', [`${ESC}[0;33m[12:41:07 INFO]: Issued server command: /${command}${ESC}[m`]);
    return send(res, 204);
  }

  /* ---- files ------------------------------------------------------------ */
  if (tail.startsWith('/files/')) {
    return routeFiles(req, res, tail.slice('/files/'.length), searchParams, method);
  }

  /* ---- backups ---------------------------------------------------------- */
  if (tail === '/backups' && method === 'GET') {
    const perPage = Math.min(Number(searchParams.get('per_page') ?? '20') || 20, 50);
    const page = backups.slice(0, perPage);
    return send(res, 200, list(page.map(backupItem), {
      ...pagination(backups.length, perPage, 1),
      backup_count: backups.filter((b) => b.is_successful || b.completed_at === null).length,
    }));
  }

  if (tail === '/backups' && method === 'POST') {
    const body = safeJson(await readBody(req)) ?? {};
    if (backups.length >= 20) {
      return sendError(res, 400, 'TooManyBackupsException', 'Cannot create a new backup, this server has reached its limit of 20 backups.');
    }
    const record = {
      uuid: randomUUID(),
      is_successful: false,
      is_locked: body.is_locked === true,
      name: typeof body.name === 'string' && body.name.length > 0 ? body.name.slice(0, 191) : `Backup at ${NOW()}`,
      ignored_files: typeof body.ignored === 'string' && body.ignored.length > 0 ? body.ignored.split('\n').filter(Boolean) : [],
      checksum: null,
      bytes: 0,
      created_at: NOW(),
      completed_at: null,
    };
    backups.unshift(record);
    const finish = setTimeout(() => {
      record.completed_at = NOW();
      record.is_successful = true;
      record.bytes = 712_351_744;
      record.checksum = `sha256:${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
      broadcast('backup completed', [JSON.stringify({ uuid: record.uuid, is_successful: true })]);
    }, 1000);
    finish.unref?.();
    return send(res, 200, backupItem(record));
  }

  const backupMatch = /^\/backups\/([^/]+)(\/.*)?$/.exec(tail);
  if (backupMatch) {
    const uuid = decodeURIComponent(backupMatch[1]);
    const sub = backupMatch[2] ?? '';
    const record = backups.find((b) => b.uuid === uuid);
    if (!record) {
      return sendError(res, 404, 'ModelNotFoundException', `No backup matching "${uuid}" was found for this server.`);
    }
    if (sub === '' && method === 'GET') return send(res, 200, backupItem(record));
    if (sub === '' && method === 'DELETE') {
      if (record.is_locked) {
        return sendError(res, 400, 'DisplayException', 'Cannot delete a backup that is locked. Unlock it first.');
      }
      backups.splice(backups.indexOf(record), 1);
      return send(res, 204);
    }
    if (sub === '/download' && method === 'GET') {
      if (record.completed_at === null) {
        return sendError(res, 400, 'DisplayException', 'This backup has not completed and cannot be downloaded yet.');
      }
      return send(res, 200, item('signed_url', {
        url: `http://127.0.0.1:${boundPort}/download/backup?token=eyJhbGciOiJIUzI1NiJ9.${Buffer.from(uuid).toString('base64url')}.mocksig`,
      }));
    }
    if (sub === '/lock' && method === 'POST') {
      record.is_locked = !record.is_locked;
      return send(res, 200, backupItem(record));
    }
    return sendError(res, 404, 'NotFoundHttpException', 'The requested resource could not be found.');
  }

  /* ---- schedules -------------------------------------------------------- */
  if (tail === '/schedules' && method === 'GET') {
    return send(
      res,
      200,
      list(
        schedules.map((s) =>
          item('server_schedule', {
            id: s.id,
            name: s.name,
            cron: s.cron,
            is_active: s.is_active,
            is_processing: s.is_processing,
            only_when_online: s.only_when_online,
            last_run_at: s.last_run_at,
            next_run_at: s.next_run_at,
            created_at: s.created_at,
            updated_at: s.updated_at,
            relationships: {
              tasks: list(
                s.tasks.map((t) => item('schedule_task', { ...t, created_at: T0, updated_at: T0 })),
              ),
            },
          }),
        ),
      ),
    );
  }

  /* ---- allocations ------------------------------------------------------ */
  if (tail === '/network/allocations' && method === 'GET') {
    return send(res, 200, list(allocations.map((a) => item('allocation', { ...a }))));
  }

  /* ---- startup ---------------------------------------------------------- */
  if (tail === '/startup' && method === 'GET') {
    return send(res, 200, list(startupVariables.map((v) => item('egg_variable', { ...v })), {
      startup_command: 'java -Xms128M -Xmx7168M -jar paper.jar',
      raw_startup_command: 'java -Xms128M -Xmx{{MEMORY}}M -jar {{SERVER_JARFILE}}',
      docker_images: { 'Java 21': 'ghcr.io/pterodactyl/yolks:java_21', 'Java 17': 'ghcr.io/pterodactyl/yolks:java_17' },
    }));
  }

  return sendError(res, 404, 'NotFoundHttpException', 'The requested resource could not be found.');
}

function routeFiles(req, res, op, searchParams, method) {
  const bodyPromise = () => readBody(req);

  if (op === 'list' && method === 'GET') {
    const entries = listDirectory(searchParams.get('directory') ?? '/');
    if (entries === null) {
      return sendError(res, 404, 'DaemonConnectionException', `The directory "${searchParams.get('directory')}" could not be found on the remote host.`);
    }
    return send(res, 200, list(entries));
  }

  if (op === 'contents' && method === 'GET') {
    const path = normalise(searchParams.get('file') ?? '');
    const entry = files.get(path);
    if (!entry) {
      return sendError(res, 404, 'DaemonConnectionException', `The file "${path}" could not be found on the remote host.`);
    }
    if (entry.size > 4 * 1024 * 1024) {
      return sendError(res, 400, 'FileSizeTooLargeException', 'The file you are attempting to open is too large to view.');
    }
    return send(res, 200, entry.content, 'text/plain;charset=UTF-8');
  }

  if (op === 'download' && method === 'GET') {
    const path = normalise(searchParams.get('file') ?? '');
    if (!files.has(path)) {
      return sendError(res, 404, 'DaemonConnectionException', `The file "${path}" could not be found on the remote host.`);
    }
    return send(res, 200, item('signed_url', {
      url: `http://127.0.0.1:${boundPort}/download/file?token=eyJhbGciOiJIUzI1NiJ9.${Buffer.from(path).toString('base64url')}.mocksig`,
    }));
  }

  if (op === 'upload' && method === 'GET') {
    return send(res, 200, item('signed_url', { url: `http://127.0.0.1:${boundPort}/upload/file?token=mock.upload.token` }));
  }

  if (op === 'write' && method === 'POST') {
    return bodyPromise().then((content) => {
      const path = normalise(searchParams.get('file') ?? '');
      if (path === '') {
        return sendError(res, 422, 'ValidationException', 'The given data was invalid.', { source_field: 'file', rule: 'required' });
      }
      if (dirs.has(path)) {
        return sendError(res, 400, 'DisplayException', 'Cannot write to a directory.');
      }
      const parent = parentOf(path);
      if (parent !== '' && !dirs.has(parent)) {
        return sendError(res, 404, 'DaemonConnectionException', `The directory "${parent}" could not be found on the remote host.`);
      }
      const existing = files.get(path);
      addFile(path, content, existing?.mimetype ?? 'text/plain');
      files.get(path).modified_at = NOW();
      return send(res, 204);
    });
  }

  if (op === 'rename' && method === 'PUT') {
    return bodyPromise().then((raw) => {
      const body = safeJson(raw) ?? {};
      const root = normalise(body.root ?? '/');
      const entries = Array.isArray(body.files) ? body.files : [];
      if (entries.length === 0) {
        return sendError(res, 422, 'ValidationException', 'The given data was invalid.', { source_field: 'files', rule: 'required' });
      }
      for (const e of entries) {
        const from = joinPath(root, e?.from ?? '');
        const to = joinPath(root, e?.to ?? '');
        if (!files.has(from) && !dirs.has(from)) {
          return sendError(res, 404, 'DaemonConnectionException', `The file "${from}" could not be found on the remote host.`);
        }
        if (files.has(to) || dirs.has(to)) {
          return sendError(res, 400, 'DisplayException', `Cannot move or rename file, destination "${to}" already exists.`);
        }
        const toParent = parentOf(to);
        if (toParent !== '' && !dirs.has(toParent)) {
          return sendError(res, 404, 'DaemonConnectionException', `The directory "${toParent}" could not be found on the remote host.`);
        }
        if (files.has(from)) {
          const entry = files.get(from);
          files.delete(from);
          files.set(to, { ...entry, modified_at: NOW() });
        } else {
          dirs.delete(from);
          dirs.add(to);
          for (const child of [...dirs]) {
            if (child.startsWith(`${from}/`)) {
              dirs.delete(child);
              dirs.add(to + child.slice(from.length));
            }
          }
          for (const [child, entry] of [...files]) {
            if (child.startsWith(`${from}/`)) {
              files.delete(child);
              files.set(to + child.slice(from.length), entry);
            }
          }
        }
      }
      return send(res, 204);
    });
  }

  if (op === 'copy' && method === 'POST') {
    return bodyPromise().then((raw) => {
      const body = safeJson(raw) ?? {};
      const location = normalise(body.location ?? '');
      const entry = files.get(location);
      if (!entry) {
        return sendError(res, 404, 'DaemonConnectionException', `The file "${location}" could not be found on the remote host.`);
      }
      const target = copyName(location);
      files.set(target, { ...entry, created_at: NOW(), modified_at: NOW() });
      return send(res, 204);
    });
  }

  if (op === 'delete' && method === 'POST') {
    return bodyPromise().then((raw) => {
      const body = safeJson(raw) ?? {};
      const root = normalise(body.root ?? '/');
      const names = Array.isArray(body.files) ? body.files : [];
      if (names.length === 0) {
        return sendError(res, 422, 'ValidationException', 'The given data was invalid.', { source_field: 'files', rule: 'required' });
      }
      for (const name of names) deletePath(joinPath(root, String(name ?? '')));
      return send(res, 204);
    });
  }

  if (op === 'create-folder' && method === 'POST') {
    return bodyPromise().then((raw) => {
      const body = safeJson(raw) ?? {};
      dirs.add(joinPath(body.root ?? '/', body.name ?? 'new folder'));
      return send(res, 204);
    });
  }

  if ((op === 'compress' || op === 'decompress' || op === 'chmod' || op === 'pull') && method === 'POST') {
    return bodyPromise().then(() => send(res, 204));
  }

  return sendError(res, 404, 'NotFoundHttpException', 'The requested resource could not be found.');
}

function safeJson(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Wings websocket (docs/pterodactyl-api.md §15)                              */
/* -------------------------------------------------------------------------- */

const wss = new WebSocketServer({ noServer: true });
const liveSockets = new Set();

function broadcast(event, args = []) {
  for (const socket of liveSockets) {
    try {
      if (socket.readyState === 1) socket.send(JSON.stringify({ event, args }));
    } catch {
      /* peer went away mid-write */
    }
  }
}

/** A few lines carry ANSI colour so the client's stripAnsi path is exercised. */
function colourise(line, index) {
  if (index % 7 === 0) return `${ESC}[0;32m${line}${ESC}[m`;
  if (index % 11 === 0) return `${ESC}[1;31m${line}${ESC}[0m`;
  return line;
}

wss.on('connection', (socket) => {
  state.wsConnections += 1;
  liveSockets.add(socket);
  let firstAuth = true;
  let authed = false;
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      try {
        fn();
      } catch {
        /* never let a timer kill the mock */
      }
    }, ms);
    timers.add(t);
    return t;
  };

  const send = (event, args = []) => {
    try {
      if (socket.readyState === 1) socket.send(JSON.stringify({ event, args }));
    } catch {
      /* ignore */
    }
  };

  socket.on('error', () => {
    /* a client that vanished mid-write is not a failure */
  });

  socket.on('close', () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    liveSockets.delete(socket);
  });

  socket.on('message', (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return; // never crash on a malformed frame
    }
    if (!frame || typeof frame.event !== 'string') return;
    const args = Array.isArray(frame.args) ? frame.args : [];

    switch (frame.event) {
      case 'auth': {
        if (typeof args[0] !== 'string' || args[0].length === 0) {
          send('jwt error', ['The JWT provided is missing or malformed.']);
          return;
        }
        state.wsAuths += 1;
        authed = true;
        send('auth success');
        if (firstAuth) {
          firstAuth = false;
          send('status', [state.power]);
          // §15: `token expiring` fires ~60s before the JWT dies. Compressed to 3s
          // here so a short collection window still exercises the re-auth path.
          later(() => send('token expiring'), 3000);
        }
        return;
      }

      case 'send logs': {
        if (!authed) return send('jwt error', ['Not authenticated.']);
        if (state.power !== 'running') return; // §15: silently ignored when offline
        const all = LATEST_LOG.split('\n').filter((l) => l.length > 0);
        const backlog = all.slice(-150);
        backlog.forEach((line, i) => send('console output', [colourise(line, i)]));
        return;
      }

      case 'send stats': {
        if (!authed) return send('jwt error', ['Not authenticated.']);
        const r = resourcesAttributes().resources;
        send('stats', [
          JSON.stringify({
            memory_bytes: r.memory_bytes,
            memory_limit_bytes: 8192 * 1024 * 1024,
            cpu_absolute: r.cpu_absolute,
            network: { rx_bytes: r.network_rx_bytes, tx_bytes: r.network_tx_bytes },
            state: state.power,
            disk_bytes: r.disk_bytes,
          }),
        ]);
        return;
      }

      case 'send command': {
        if (!authed) return send('jwt error', ['Not authenticated.']);
        const command = typeof args[0] === 'string' ? args[0] : '';
        if (command.length === 0) return;
        state.wsCommands += 1;
        state.commandsSent.push(command);
        broadcast('console output', [
          `${ESC}[0;33m[12:41:07 INFO]: Issued server command: /${command}${ESC}[m`,
        ]);
        return;
      }

      case 'set state': {
        if (!authed) return send('jwt error', ['Not authenticated.']);
        const signal = args[0];
        if (!['start', 'stop', 'restart', 'kill'].includes(signal)) {
          return send('daemon error', ['Invalid power state requested.']);
        }
        state.power = signal === 'start' || signal === 'restart' ? 'running' : 'offline';
        state.powerSignals.push(signal);
        broadcast('status', [state.power]);
        return;
      }

      default:
        return; // unknown inbound events are ignored, as Wings does
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

let boundPort = 0;

const httpServer = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
  } catch {
    return sendError(res, 400, 'BadRequestHttpException', 'Malformed request URL.');
  }
  Promise.resolve()
    .then(() => route(req, res, url))
    .catch((err) => {
      process.stderr.write(`[mock-panel] handler error: ${err?.message ?? err}\n`);
      if (!res.headersSent) {
        sendError(res, 500, 'Exception', 'An unexpected error was encountered while processing this request.');
      } else {
        res.end();
      }
    });
});

httpServer.on('clientError', (_err, socket) => {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch {
    /* ignore */
  }
});

httpServer.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    /* fall through to the reject path */
  }
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

process.on('uncaughtException', (err) => {
  process.stderr.write(`[mock-panel] uncaught: ${err?.stack ?? err}\n`);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[mock-panel] unhandled rejection: ${err?.stack ?? err}\n`);
});

const requestedPort = Number(process.argv[2] ?? 4567);
httpServer.listen(Number.isFinite(requestedPort) ? requestedPort : 4567, '127.0.0.1', () => {
  boundPort = httpServer.address().port;
  process.stderr.write(`MOCK_PANEL_URL=http://127.0.0.1:${boundPort}\n`);
  process.stderr.write(`[mock-panel] server ${SERVER_ID} "Survival" ready (ws://127.0.0.1:${boundPort}/ws)\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      for (const s of liveSockets) s.terminate();
      httpServer.close();
    } finally {
      process.exit(0);
    }
  });
}
