import { describe, expect, it } from 'vitest';

import { createBackupAndWait, type BackupWaitClient } from '../src/backupWait.js';
import type { BackupItem } from '../src/types.js';

function backupItem(over: Partial<BackupItem['attributes']> = {}): BackupItem {
  return {
    object: 'backup',
    attributes: {
      uuid: 'bk-1',
      is_successful: false,
      is_locked: false,
      name: 'pre-change',
      ignored_files: [],
      checksum: null,
      bytes: 0,
      created_at: '2024-01-01T00:00:00+00:00',
      completed_at: null,
      ...over,
    },
  };
}

/** A fake clock + fake sleep that advances the clock instead of waiting for real. */
function fakeClock(start = 1_700_000_000_000) {
  let clock = start;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('createBackupAndWait', () => {
  it('polls getBackup until completed_at is set, using the injected sleep (no real timers)', async () => {
    const clock = fakeClock();
    const getBackupCalls: string[] = [];
    let pollCount = 0;

    const client: BackupWaitClient = {
      createBackup: async () => backupItem({ completed_at: null }),
      getBackup: async (_id, uuid) => {
        getBackupCalls.push(uuid);
        pollCount += 1;
        // Completes on the third poll.
        if (pollCount < 3) return backupItem({ completed_at: null });
        return backupItem({ completed_at: '2024-01-01T00:00:10+00:00', is_successful: true, bytes: 12345 });
      },
    };

    const result = await createBackupAndWait(client, 'srv1', {
      sleep: clock.sleep,
      now: clock.now,
      intervalMs: 2000,
    });

    expect(pollCount).toBe(3);
    expect(getBackupCalls).toEqual(['bk-1', 'bk-1', 'bk-1']);
    expect(result).toMatchObject({
      uuid: 'bk-1',
      name: 'pre-change',
      bytes: 12345,
      completed_at: '2024-01-01T00:00:10+00:00',
      is_successful: true,
    });
    expect(result.waited_ms).toBe(6000); // 3 sleeps of 2000ms on the fake clock
  });

  it('resolves immediately with waited_ms 0 when the panel reports completion on creation', async () => {
    const clock = fakeClock();
    const client: BackupWaitClient = {
      createBackup: async () =>
        backupItem({ completed_at: '2024-01-01T00:00:00+00:00', is_successful: true, bytes: 99 }),
      getBackup: async () => {
        throw new Error('should not poll when already complete');
      },
    };

    const result = await createBackupAndWait(client, 'srv1', { sleep: clock.sleep, now: clock.now });
    expect(result.waited_ms).toBe(0);
    expect(result.bytes).toBe(99);
  });

  it('throws when the backup completes but is not successful', async () => {
    const clock = fakeClock();
    const client: BackupWaitClient = {
      createBackup: async () => backupItem({ completed_at: null }),
      getBackup: async () => backupItem({ completed_at: '2024-01-01T00:00:05+00:00', is_successful: false }),
    };

    await expect(
      createBackupAndWait(client, 'srv1', { sleep: clock.sleep, now: clock.now, intervalMs: 1000 }),
    ).rejects.toThrow(/bk-1.*NOT successful/s);
  });

  it('throws a timeout error naming the uuid and pointing at ptero_list_backups', async () => {
    const clock = fakeClock();
    const client: BackupWaitClient = {
      createBackup: async () => backupItem({ completed_at: null }),
      getBackup: async () => backupItem({ completed_at: null }),
    };

    await expect(
      createBackupAndWait(client, 'srv1', {
        sleep: clock.sleep,
        now: clock.now,
        timeoutMs: 5000,
        intervalMs: 2000,
      }),
    ).rejects.toThrow(/bk-1/);

    await expect(
      createBackupAndWait(client, 'srv1', {
        sleep: clock.sleep,
        now: clock.now,
        timeoutMs: 5000,
        intervalMs: 2000,
      }),
    ).rejects.toThrow(/ptero_list_backups/);
  });

  it('passes name and ignored through to createBackup', async () => {
    const clock = fakeClock();
    let seenOpts: unknown;
    const client: BackupWaitClient = {
      createBackup: async (_id, opts) => {
        seenOpts = opts;
        return backupItem({ completed_at: '2024-01-01T00:00:00+00:00', is_successful: true });
      },
      getBackup: async () => backupItem({ completed_at: '2024-01-01T00:00:00+00:00', is_successful: true }),
    };

    await createBackupAndWait(client, 'srv1', {
      sleep: clock.sleep,
      now: clock.now,
      name: 'my-backup',
      ignored: 'cache/**',
    });

    expect(seenOpts).toEqual({ name: 'my-backup', ignored: 'cache/**' });
  });
});
