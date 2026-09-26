#!/usr/bin/env node
// Live verification for ptero_upload_file — the ONLY live mutation this script performs is
// creating, then deleting, a throwaway 2 KiB binary under /mcp-throwaway-upload/. It never
// issues a power action, never touches world/, plugins/ or any config, and cleans up after
// itself (including on failure). Modelled on scripts/live-verify.mjs: one long-lived server
// process, so confirmation tokens survive between the two calls of each two-phase flow.
//
//   node scripts/live-verify-upload.mjs           run the sequence
//   node scripts/live-verify-upload.mjs cleanup   only the cleanup sweep
//
// PTERODACTYL_AUTO_BACKUP=false deliberately: servers often have a tiny backup limit, and
// this run must not consume a slot. PTERODACTYL_ALLOW_DELETE=true is needed for the cleanup.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.LIVE_OUT_DIR ?? path.join(ROOT, 'scripts');
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const KEY = env.PTERODACTYL_API_KEY;
const SERVER = env.PTERODACTYL_DEFAULT_SERVER;
if (!env.PTERODACTYL_PANEL_URL || !KEY || !SERVER) {
  console.error('Set PTERODACTYL_PANEL_URL, PTERODACTYL_API_KEY and PTERODACTYL_DEFAULT_SERVER in .env first.');
  process.exit(2);
}
const serverEnv = {
  PATH: process.env.PATH,
  PTERODACTYL_PANEL_URL: env.PTERODACTYL_PANEL_URL,
  PTERODACTYL_API_KEY: KEY,
  PTERODACTYL_DEFAULT_SERVER: SERVER,
  PTERODACTYL_READ_ONLY: 'false',
  PTERODACTYL_ALLOW_DELETE: 'true',
  PTERODACTYL_ALLOW_KILL: 'false',
  PTERODACTYL_AUTO_BACKUP: 'false',
  PTERODACTYL_AUDIT_LOG: path.join(OUT, 'live-audit-upload.jsonl'),
};
const CALL_TIMEOUT_MS = 120_000;
const REMOTE_DIR = 'mcp-throwaway-upload';
const REMOTE_NAME = 'probe.bin';
const SIZE = 2048;

const LOCAL_DIR = mkdtempSync(path.join(tmpdir(), 'ptero-live-upload-'));
const LOCAL_FILE = path.join(LOCAL_DIR, REMOTE_NAME);
const LOCAL_BYTES = randomBytes(SIZE);
writeFileSync(LOCAL_FILE, LOCAL_BYTES);
const LOCAL_SHA = createHash('sha256').update(LOCAL_BYTES).digest('hex');

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(ROOT, 'dist/index.js')],
  env: serverEnv,
  stderr: 'pipe',
});
const client = new Client({ name: 'live-verify-upload', version: '0.0.1' });
await client.connect(transport);
transport.stderr?.on('data', (d) => process.stderr.write(String(d).replaceAll(KEY, '[KEY]')));

const scrub = (s) => String(s).replaceAll(KEY, '[KEY]');
function show(step, res) {
  const sc = res.structuredContent ?? {};
  const text = scrub(res.content?.[0]?.text ?? '');
  console.log(`[${step}] status=${sc.status ?? (res.isError ? 'ERROR' : 'ok')} ${text.split('\n')[0].slice(0, 170)}`);
  return res;
}
const raw = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
const call = async (step, name, args) => show(step, await raw(name, args));
function expect(cond, msg) {
  if (!cond) throw new Error('EXPECTATION FAILED: ' + msg);
}
/** Two-phase flow: first call previews, second call confirms with the issued token. */
async function confirmed(step, name, args) {
  const first = await call(step + 'a', name, args);
  const sc = first.structuredContent ?? {};
  if (sc.status === 'success' || sc.status === 'refused') return first;
  expect(sc.status === 'needs_confirmation', `${name} should need confirmation, got ${sc.status}`);
  return call(step + 'b', name, { ...args, confirmation_token: sc.confirmation_token });
}
async function listDir(directory) {
  const r = await raw('ptero_list_files', { directory });
  if (r.isError) return null;
  return r.structuredContent?.entries ?? [];
}
async function rootNames() {
  return (await listDir('/')).map((e) => e.name);
}

async function cleanup() {
  console.log('--- cleanup sweep ---');
  if ((await rootNames()).includes(REMOTE_DIR)) {
    await confirmed('C1', 'ptero_delete_file', { root: '/', files: [REMOTE_DIR] });
  }
  console.log(`cleanup done: ${REMOTE_DIR} present = ${(await rootNames()).includes(REMOTE_DIR)}`);
}

async function main() {
  if (process.argv[2] === 'cleanup') return cleanup();

  console.log(`local fixture: ${SIZE} bytes, sha256 ${LOCAL_SHA}`);

  // ---- pre-flight (read-only) ----
  const before = await rootNames();
  expect(!before.includes(REMOTE_DIR), `${REMOTE_DIR} must not already exist at the server root`);
  console.log(`[P] server root has ${before.length} entries; ${REMOTE_DIR} absent as expected`);

  // 1 protected-path refusal — must never reach the panel's upload endpoint
  let r = await call('1', 'ptero_upload_file', {
    local_path: LOCAL_FILE,
    remote_dir: 'world',
    remote_name: 'level.dat',
  });
  expect(
    r.structuredContent?.status === 'refused' &&
      r.structuredContent.variable === 'PTERODACTYL_PROTECTED_PATHS',
    'upload into world/ refused by the protected-path guard',
  );

  // 2 dry run — nothing created
  r = await call('2', 'ptero_upload_file', {
    local_path: LOCAL_FILE,
    remote_dir: REMOTE_DIR,
    remote_name: REMOTE_NAME,
    dry_run: true,
  });
  expect(r.structuredContent?.status === 'dry_run', 'dry_run');
  expect(!(await rootNames()).includes(REMOTE_DIR), 'dry run created nothing');

  // 3 the real upload (two-phase: the destination directory does not exist yet, so the
  //   existence probe fails and the guard treats it as a possible overwrite)
  r = await confirmed('3', 'ptero_upload_file', {
    local_path: LOCAL_FILE,
    remote_dir: REMOTE_DIR,
    remote_name: REMOTE_NAME,
  });
  const sc = r.structuredContent ?? {};
  expect(sc.status === 'success', `upload succeeded (got ${sc.status}: ${scrub(r.content?.[0]?.text ?? '')})`);
  expect(sc.bytes === SIZE, `reported bytes ${sc.bytes} === ${SIZE}`);
  expect(sc.sha256 === LOCAL_SHA, 'reported sha256 matches the local file');
  expect(sc.path === `${REMOTE_DIR}/${REMOTE_NAME}`, `path ${sc.path}`);
  expect(sc.backup_id === undefined, 'no auto-backup taken (PTERODACTYL_AUTO_BACKUP=false)');

  // 4 verify on the panel: the file exists at the size we sent
  const entries = await listDir(`/${REMOTE_DIR}`);
  expect(entries !== null, `${REMOTE_DIR} is listable`);
  console.log('    listing:', JSON.stringify(entries.map((e) => ({ name: e.name, size: e.size_bytes }))));
  const probe = entries.find((e) => e.name === REMOTE_NAME);
  expect(probe !== undefined, `${REMOTE_NAME} present in ${REMOTE_DIR}`);
  expect(probe.size_bytes === SIZE, `panel reports ${probe.size_bytes} bytes, expected ${SIZE}`);
  expect(probe.is_file === true, 'it is a regular file');

  // 5 clean up: delete the throwaway directory (confirmation round-trip, no backup)
  r = await confirmed('5', 'ptero_delete_file', { root: '/', files: [REMOTE_DIR] });
  expect(r.structuredContent?.status === 'success', 'delete succeeded');
  expect(r.structuredContent.deleted_count === 1, 'deleted_count 1');

  // 6 final state: the server root is exactly as we found it
  const after = await rootNames();
  expect(!after.includes(REMOTE_DIR), `${REMOTE_DIR} is gone`);
  expect(after.length === before.length, `root entry count unchanged (${before.length} -> ${after.length})`);

  const audit = readFileSync(serverEnv.PTERODACTYL_AUDIT_LOG, 'utf8');
  expect(!audit.includes(KEY), 'API key not in audit log');
  expect(!audit.includes('/upload/file'), 'signed Wings upload URL not in audit log');
  expect(audit.includes(LOCAL_SHA), 'audit log records the sha256 of the uploaded bytes');
  console.log(`    audit lines: ${audit.trim().split('\n').length}`);
  console.log('ALL STEPS PASSED');
}

try {
  await main();
} catch (err) {
  console.error('RUN FAILED:', scrub(err.message ?? err));
  try { await cleanup(); } catch (e) { console.error('CLEANUP FAILED:', scrub(e.message ?? e)); }
  process.exitCode = 1;
} finally {
  await client.close();
}
