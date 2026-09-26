#!/usr/bin/env node
// Live mutation verification driver — runs the adversarially-reviewed sequence against the
// configured panel from ONE long-lived server process so confirmation tokens, the mutation
// budget and audit state persist across calls. Only touches files named mcp-throwaway-* at
// the server root and backups it created itself. Never issues a power action.
//
// Reads PTERODACTYL_PANEL_URL / PTERODACTYL_API_KEY / PTERODACTYL_DEFAULT_SERVER from .env at
// the repo root. It MUTATES that server — use a test server. Pre-flight checks refuse to run
// unless the server has a backup limit of exactly 1, no existing backups and no schedules
// (the sequence relies on the single backup slot filling up to prove the abort path).
//
// Usage: node scripts/live-verify.mjs           run the sequence (cleans up on failure)
//        node scripts/live-verify.mjs cleanup   only the cleanup sweep
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
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
  PTERODACTYL_AUTO_BACKUP: 'true',
  PTERODACTYL_AUDIT_LOG: path.join(OUT, 'live-audit.jsonl'),
};
const CALL_TIMEOUT_MS = 300_000; // D1: a ~300 MiB backup can take minutes
const FILE = 'mcp-throwaway-test.txt';
const RENAMED = 'mcp-throwaway-test-renamed.txt';
const PREFIX = 'mcp-throwaway-';

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(ROOT, 'dist/index.js')],
  env: serverEnv,
  stderr: 'pipe',
});
const client = new Client({ name: 'live-verify', version: '0.0.1' });
await client.connect(transport);
transport.stderr?.on('data', (d) => process.stderr.write(String(d).replaceAll(KEY, '[KEY]')));

const scrub = (s) => String(s).replaceAll(KEY, '[KEY]');
function show(step, res) {
  const sc = res.structuredContent ?? {};
  const text = scrub(res.content?.[0]?.text ?? '');
  console.log(`[${step}] status=${sc.status ?? (res.isError ? 'ERROR' : 'ok')} ${text.split('\n')[0].slice(0, 170)}`);
  return res;
}
async function raw(name, args) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
}
async function call(step, name, args) {
  return show(step, await raw(name, args));
}
function expect(cond, msg) {
  if (!cond) throw new Error('EXPECTATION FAILED: ' + msg);
}
async function confirmed(step, name, args) {
  const first = await call(step + 'a', name, args);
  const sc = first.structuredContent ?? {};
  if (sc.status === 'refused') return first;
  expect(sc.status === 'needs_confirmation', `${name} should need confirmation, got ${sc.status}`);
  return call(step + 'b', name, { ...args, confirmation_token: sc.confirmation_token });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function listRoot() {
  const r = await raw('ptero_list_files', { directory: '/' });
  return (r.structuredContent?.entries ?? []).map((e) => e.name);
}
async function throwaways() {
  return (await listRoot()).filter((n) => n.startsWith(PREFIX));
}
async function listBackups() {
  const r = await raw('ptero_list_backups', {});
  return r.structuredContent?.backups ?? [];
}
async function readFile(p) {
  const r = await raw('ptero_read_file', { path: p });
  return r.structuredContent?.content;
}
/** D5: never delete a backup until the panel reports it complete. */
async function waitComplete(uuid, maxMs = 300_000) {
  const t0 = Date.now();
  for (;;) {
    const b = (await listBackups()).find((x) => x.uuid === uuid);
    if (!b) return undefined;
    if (b.completed_at) return b;
    if (Date.now() - t0 > maxMs) throw new Error(`backup ${uuid} still not complete after ${maxMs} ms`);
    await sleep(3000);
  }
}
async function deleteBackup(step, uuid) {
  const b = await waitComplete(uuid);
  if (!b) {
    console.log(`[${step}] backup ${uuid} already gone`);
    return { structuredContent: { status: 'success' } };
  }
  return confirmed(step, 'ptero_delete_backup', { backup_uuid: uuid });
}
const isOurs = (b) => /^pre-ptero_/.test(String(b.name));

async function cleanup() {
  console.log('--- cleanup sweep ---');
  // D1: always re-list; a backup may exist even after an error. Wait for completion first.
  for (const b of await listBackups()) if (isOurs(b)) await deleteBackup('C1', b.uuid);
  const stray = await throwaways();
  if (stray.length) {
    const r = await confirmed('C2', 'ptero_delete_file', { root: '/', files: stray });
    if (r.structuredContent?.backup_id) await deleteBackup('C3', r.structuredContent.backup_id);
  }
  for (const b of await listBackups()) if (isOurs(b)) await deleteBackup('C4', b.uuid);
  console.log(`cleanup done: stray=${JSON.stringify(await throwaways())} backups=${(await listBackups()).length}`);
}

async function main() {
  if (process.argv[2] === 'cleanup') return cleanup();

  // ---- pre-flight (read-only) ----
  const srv = await raw('ptero_get_server', {});
  const limit = srv.structuredContent?.feature_limits?.backups;
  console.log(`[P] backup limit = ${limit}`);
  expect(limit === 1, `plan assumes backup limit 1 (got ${limit})`);
  expect((await listBackups()).length === 0, '0 backups before start');
  const sched = await raw('ptero_list_schedules', {});
  expect((sched.structuredContent?.schedules ?? []).length === 0, 'no schedules that could take a backup');
  expect((await throwaways()).length === 0, 'no throwaway files before start');
  // D4: confirmation-mode probe — delete_file makes no request before the guard.
  let r = await call('P-probe', 'ptero_delete_file', { root: '/', files: ['mcp-throwaway-probe-absent.txt'] });
  expect(r.structuredContent?.status === 'needs_confirmation', 'token confirmation mode active');
  expect((await throwaways()).length === 0, 'probe touched nothing');

  // 1 player count before any load (benign command)
  r = await call('1', 'ptero_send_console_command', { command: 'list' });
  expect(r.structuredContent?.status === 'success', 'list dispatched');
  r = await raw('ptero_get_console_log', { window_seconds: 3, max_lines: 400, filter: 'players online|of a max of' });
  console.log('    console:', scrub(r.content[0].text.split('\n').slice(-1)[0]).slice(0, 160));

  // 2 dry run
  r = await call('2', 'ptero_write_file', { path: FILE, content: 'hello\n', dry_run: true });
  expect(r.structuredContent?.status === 'dry_run', 'dry_run');
  expect(!(await listRoot()).includes(FILE), 'dry run created nothing');

  // 3 create (no confirmation; auto-backup B1)
  const t0 = Date.now();
  r = await call('3', 'ptero_write_file', { path: FILE, content: 'hello\n' });
  if (r.structuredContent?.status !== 'success') {
    throw new Error(`create failed: ${scrub(r.content[0].text)}`);
  }
  const B1 = r.structuredContent.backup_id;
  console.log(`    backup B1=${B1} took ${Math.round((Date.now() - t0) / 1000)} s`);
  expect(typeof B1 === 'string' && B1.length > 0, 'backup_id present');
  expect((await readFile(FILE)) === 'hello\n', 'content is hello');
  const b1 = await waitComplete(B1);
  expect(b1 && b1.is_successful, 'B1 completed successfully');
  expect((await listBackups()).length === 1, 'exactly 1 backup');

  // 4 overwrite → confirm → auto-backup must fail (slot full) → refused
  r = await call('4a', 'ptero_write_file', { path: FILE, content: 'hello v2\n' });
  expect(r.structuredContent?.status === 'needs_confirmation', 'overwrite needs confirmation');
  const tok = r.structuredContent.confirmation_token;
  r = await call('4b', 'ptero_write_file', { path: FILE, content: 'hello v2\n', confirmation_token: tok });
  let abortVerified = false;
  if (r.structuredContent?.status === 'refused') {
    expect(r.structuredContent.variable === 'PTERODACTYL_AUTO_BACKUP', `refusal variable is ${r.structuredContent.variable}`);
    expect((await readFile(FILE)) === 'hello\n', 'content unchanged after abort');
    abortVerified = true;
  } else {
    // D2: panel allowed a second backup. Record and clean it up; property (b) untested.
    console.log('    NOTE: panel accepted a second backup; abort-on-backup-failure NOT verified live');
    if (r.structuredContent?.backup_id) await deleteBackup('4c', r.structuredContent.backup_id);
  }
  const bl = await listBackups();
  expect(bl.length === 1, `still exactly 1 backup after step 4 (got ${bl.length})`);

  // 5 replay guard
  r = await call('5', 'ptero_write_file', { path: FILE, content: 'hello v2\n', confirmation_token: tok });
  expect(r.structuredContent?.status === 'refused' && /used|unknown/.test(r.content[0].text), 'replayed token refused');

  // 6 rename (no backup, no confirmation)
  r = await call('6', 'ptero_rename_file', { root: '/', from: FILE, to: RENAMED });
  expect(r.structuredContent?.status === 'success', 'rename succeeded');
  let names = await listRoot();
  expect(names.includes(RENAMED) && !names.includes(FILE), 'renamed only');

  // 7 copy — take the name from the listing (D7), never read it
  r = await call('7', 'ptero_copy_file', { path: RENAMED });
  expect(r.structuredContent?.status === 'success', 'copy succeeded');
  const files = await throwaways();
  console.log('    throwaway entries:', JSON.stringify(files));
  expect(files.length === 2, 'exactly two throwaway files after copy');

  // 8 protected path refusal — zero network
  r = await call('8', 'ptero_delete_file', { root: '/', files: ['ops.json'] });
  expect(r.structuredContent?.status === 'refused' && r.structuredContent.variable === 'PTERODACTYL_PROTECTED_PATHS', 'ops.json refused');

  // 9 free the slot
  r = await deleteBackup('9', B1);
  expect(r.structuredContent?.status === 'success', 'B1 deleted');
  expect((await listBackups()).length === 0, 'backups 0');

  // 10 delete both throwaway files (confirm → auto-backup B2 → delete)
  r = await confirmed('10', 'ptero_delete_file', { root: '/', files });
  expect(r.structuredContent?.status === 'success', 'delete succeeded');
  const B2 = r.structuredContent.backup_id;
  expect(r.structuredContent.deleted_count === 2, 'deleted_count 2');
  expect((await throwaways()).length === 0, 'no throwaway files remain');

  // 11 final backup cleanup
  r = await deleteBackup('11', B2);
  expect(r.structuredContent?.status === 'success', 'B2 deleted');
  expect((await listBackups()).length === 0, 'backups 0 at end');

  // 12 final state
  names = await listRoot();
  expect(!names.some((n) => n.startsWith(PREFIX)), 'root clean');
  const audit = readFileSync(serverEnv.PTERODACTYL_AUDIT_LOG, 'utf8');
  expect(!audit.includes(KEY), 'API key not in audit log');
  expect(!/"content"/.test(audit), 'file content not in audit log');
  console.log(`    audit lines: ${audit.trim().split('\n').length}`);
  console.log(`ALL STEPS PASSED (abort-on-backup-failure verified: ${abortVerified})`);
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
