/**
 * `createBackupAndWait` — POST a backup, then poll until the panel reports it complete.
 *
 * Used by `ptero_create_backup` (Phase 5) and by the guard's Layer 3 pre-flight backup
 * (`src/index.ts` wires `Guard.createBackup` to this function), so a destructive change
 * only proceeds once the panel reports the backup complete. Failure here MUST throw
 * rather than return a "maybe" result — the guard turns a throw into an abort.
 */
import type { PteroClient } from './client.js';
import type { BackupAttributes } from './types.js';

/** Default: give up waiting after two minutes. The backup may still finish in the background. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Default poll interval. */
export const DEFAULT_INTERVAL_MS = 2_000;

export interface CreateBackupAndWaitOptions {
  /** Passed straight through to `POST /backups`. */
  name?: string;
  /** Newline-delimited glob list of paths to exclude, passed straight through. */
  ignored?: string;
  /** Give up waiting after this many milliseconds. Default 120_000. */
  timeoutMs?: number;
  /** Delay between polls. Default 2_000. */
  intervalMs?: number;
  /** Injection point for tests: replace real timers with an instant, clock-advancing fake. */
  sleep?: (ms: number) => Promise<void>;
  /** Injection point for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface CreateBackupAndWaitResult {
  uuid: string;
  name: string;
  bytes: number;
  completed_at: string | null;
  is_successful: boolean;
  /** Milliseconds actually spent polling (0 if the panel reported completion immediately). */
  waited_ms: number;
}

/** The slice of `PteroClient` this needs. Deliberately narrow so tests need no real client. */
export type BackupWaitClient = Pick<PteroClient, 'createBackup' | 'getBackup'>;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a backup and poll `getBackup` until `completed_at` is set.
 *
 * - Backup registers but finishes unsuccessfully (`is_successful: false`) -> throws.
 * - Still running when `timeoutMs` elapses -> throws, naming the uuid and pointing at
 *   `ptero_list_backups` so the caller can check on it later rather than assuming failure.
 * - Never resolves to a "maybe" result: a resolved promise always means a successful,
 *   completed backup.
 */
export async function createBackupAndWait(
  client: BackupWaitClient,
  server: string,
  opts: CreateBackupAndWaitOptions = {},
): Promise<CreateBackupAndWaitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());

  const created = await client.createBackup(server, {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.ignored !== undefined ? { ignored: opts.ignored } : {}),
  });
  const uuid = created.attributes.uuid;
  const startedAt = now();

  let attrs: BackupAttributes = created.attributes;
  while (attrs.completed_at === null) {
    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) {
      throw new Error(
        `Backup ${uuid} is still running after ${Math.round(elapsed / 1000)}s and has not completed ` +
          `yet. It may finish in the background — call \`ptero_list_backups\` to check its status ` +
          'before proceeding with whatever this backup was meant to protect.',
      );
    }
    await sleep(intervalMs);
    const fetched = await client.getBackup(server, uuid);
    attrs = fetched.attributes;
  }

  if (!attrs.is_successful) {
    throw new Error(
      `Backup ${uuid} completed but was NOT successful. Check the panel for details before ` +
        'relying on it as a rollback point.',
    );
  }

  return {
    uuid,
    name: attrs.name,
    bytes: attrs.bytes,
    completed_at: attrs.completed_at,
    is_successful: attrs.is_successful,
    waited_ms: now() - startedAt,
  };
}
