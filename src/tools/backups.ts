import { z } from 'zod';

import { createBackupAndWait } from '../backupWait.js';
import { PteroApiError } from '../errors.js';
import type { MutationRequest } from '../guard.js';
import {
  bytesToHuman,
  dryRunSchema,
  fail,
  mutationOutputShape,
  ok,
  resolveServer,
  runMutation,
  serverIdSchema,
  confirmationTokenSchema,
  type ToolContext,
} from './_shared.js';

/* -------------------------------------------------------------------------- */
/* Output schemas                                                             */
/* -------------------------------------------------------------------------- */

const backupShape = {
  uuid: z.string().describe('Pass this as `backup_uuid` to ptero_delete_backup / ptero_get_backup_download_url.'),
  name: z.string(),
  bytes: z.number(),
  bytes_human: z.string(),
  is_successful: z.boolean().describe('False means the backup finished but failed — do not rely on it.'),
  is_locked: z.boolean().describe('Locked backups reject deletion until unlocked in the panel.'),
  completed_at: z.string().nullable().describe('null while the backup is still being taken.'),
  created_at: z.string(),
  checksum: z.string().nullable().describe('null until the backup completes.'),
};

const listBackupsOutputShape = {
  server: z.string(),
  backups: z.array(z.object(backupShape)),
  count: z.number().describe('Number of backups on this call (the panel does not paginate this list further here).'),
  backup_count: z
    .number()
    .optional()
    .describe('Count of non-failed backups, from the panel (meta.backup_count), when reported.'),
  backup_limit: z
    .number()
    .optional()
    .describe('Maximum backups this server may hold at once, when the panel reports it.'),
};

const createBackupOutputShape = {
  ...mutationOutputShape,
  uuid: z.string().optional(),
  name: z.string().optional(),
  bytes: z.number().optional(),
  bytes_human: z.string().optional(),
  completed: z.boolean().optional().describe('True once the backup has finished (only when wait:true).'),
  completed_at: z.string().nullable().optional(),
  is_successful: z.boolean().optional(),
  waited_ms: z.number().optional().describe('Milliseconds spent polling for completion (only when wait:true).'),
};

const deleteBackupOutputShape = {
  ...mutationOutputShape,
  uuid: z.string().optional(),
};

const downloadUrlOutputShape = {
  uuid: z.string(),
  url: z.string().describe('Signed, short-lived Wings URL. Never logged or audited.'),
  note: z.string(),
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * The panel enforces a per-server backup-count limit and rejects creation with HTTP 400
 * once it's full. Turn that specific case into guidance rather than a bare status code.
 */
function mapCreateBackupError(err: unknown): unknown {
  if (err instanceof PteroApiError && err.status === 400) {
    const detail = err.detail ? ` Panel said: ${err.detail}` : '';
    return new Error(
      `Could not create the backup (HTTP 400).${detail} This usually means the server has reached ` +
        'its configured backup-count limit. Call `ptero_list_backups` to see what already exists, ' +
        'then `ptero_delete_backup` one you no longer need before retrying — or raise the limit on ' +
        'the panel.',
    );
  }
  return err;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/** Phase 5 (part 1): backup management. */
export function registerBackupTools(ctx: ToolContext): void {
  const { server: mcp, client } = ctx;

  mcp.registerTool(
    'ptero_list_backups',
    {
      title: 'List Pterodactyl backups',
      description:
        "List a server's backups: uuid, name, size, whether each one completed " +
        'successfully, whether it is locked against deletion, and its created/completed ' +
        'timestamps.\n\n' +
        'Use this to find a rollback point before or after a risky change, or to check ' +
        'whether a backup started with `ptero_create_backup wait:false` has finished yet ' +
        '(`completed_at` is null until it has). Call `ptero_create_backup` BEFORE any risky ' +
        'file write, delete, or power kill — this tool only reports what already exists, it ' +
        'does not take one for you.',
      inputSchema: {
        server: serverIdSchema,
        per_page: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Backups per page; the panel clamps this to 50. Omit for the panel default (20).'),
      },
      outputSchema: listBackupsOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ server, per_page }) => {
      try {
        const id = resolveServer(ctx, server);
        const response = await client.listBackups(id, per_page);
        const items = response.data ?? [];

        const backups = items.map((item) => {
          const a = item.attributes;
          return {
            uuid: a.uuid,
            name: a.name,
            bytes: a.bytes,
            bytes_human: bytesToHuman(a.bytes),
            is_successful: a.is_successful,
            is_locked: a.is_locked,
            completed_at: a.completed_at,
            created_at: a.created_at,
            checksum: a.checksum,
          };
        });

        const meta = response.meta as
          | { backup_count?: number; backup_limit?: number }
          | undefined;

        const structured = {
          server: id,
          backups,
          count: backups.length,
          ...(meta?.backup_count !== undefined ? { backup_count: meta.backup_count } : {}),
          ...(meta?.backup_limit !== undefined ? { backup_limit: meta.backup_limit } : {}),
        };

        const lines =
          backups.length === 0
            ? ['No backups exist for this server yet. Call ptero_create_backup before a risky change.']
            : backups.map(
                (b) =>
                  `- ${b.uuid}  ${b.name}  ${b.bytes_human}` +
                  `${b.is_locked ? ' [locked]' : ''}` +
                  `${b.completed_at ? (b.is_successful ? '' : ' [FAILED]') : ' [in progress]'}`,
              );

        return ok(structured, lines.join('\n'));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    'ptero_create_backup',
    {
      title: 'Create a Pterodactyl backup',
      description:
        'Take a backup of the server right now. Safe. The natural thing to do BEFORE any ' +
        'file write, delete, or power kill — it gives you a rollback point.\n\n' +
        'By default (`wait: true`) this blocks until the panel reports the backup complete ' +
        '(polling for up to two minutes) and returns its final size and success state. Pass ' +
        '`wait: false` to return immediately with just the uuid if you do not want to block; ' +
        'check completion later with `ptero_list_backups`.\n\n' +
        "The panel enforces a per-server backup-count limit; creation fails with an actionable " +
        'error when the server is full — the fix is `ptero_delete_backup` on an old one, not a retry.',
      inputSchema: {
        server: serverIdSchema,
        name: z
          .string()
          .max(191)
          .optional()
          .describe('Backup name. Omit to let the panel assign a default name.'),
        ignored: z
          .string()
          .optional()
          .describe('Newline-separated list of glob patterns to exclude from the backup, e.g. "cache/**\\n*.log".'),
        wait: z
          .boolean()
          .default(true)
          .describe(
            'Wait for the backup to finish before returning (up to ~2 minutes). false returns ' +
              'immediately with just the uuid — check ptero_list_backups for completion.',
          ),
        dry_run: dryRunSchema,
      },
      outputSchema: createBackupOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ server, name, ignored, wait, dry_run }, extra) => {
      try {
        const id = resolveServer(ctx, server);

        const preview: Record<string, unknown> = {
          name: name ?? '(panel default name)',
          wait,
        };
        if (ignored !== undefined) preview['ignored'] = ignored;

        const req: MutationRequest = {
          tool: 'ptero_create_backup',
          server: id,
          args: { name, ignored, wait },
          kind: 'backup_create',
          dryRun: dry_run,
          preview,
          destructive: false,
          wantsAutoBackup: false,
        };

        return await runMutation(
          ctx,
          req,
          extra,
          async () => {
            try {
              if (wait) {
                const result = await createBackupAndWait(client, id, { name, ignored });
                return {
                  uuid: result.uuid,
                  name: result.name,
                  bytes: result.bytes,
                  bytes_human: bytesToHuman(result.bytes),
                  completed: true,
                  completed_at: result.completed_at,
                  is_successful: result.is_successful,
                  waited_ms: result.waited_ms,
                };
              }

              const created = await client.createBackup(id, {
                ...(name !== undefined ? { name } : {}),
                ...(ignored !== undefined ? { ignored } : {}),
              });
              const a = created.attributes;
              return {
                uuid: a.uuid,
                name: a.name,
                bytes: a.bytes,
                bytes_human: bytesToHuman(a.bytes),
                completed: false,
                completed_at: a.completed_at,
                is_successful: a.is_successful,
              };
            } catch (err) {
              throw mapCreateBackupError(err);
            }
          },
          (result) => {
            const r = result as { uuid: string; bytes_human: string; completed: boolean };
            return r.completed
              ? `Backup ${r.uuid} completed (${r.bytes_human}).`
              : `Backup ${r.uuid} started; still running in the background — check ptero_list_backups for completion.`;
          },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    'ptero_delete_backup',
    {
      title: 'Delete a Pterodactyl backup',
      description:
        'Permanently delete one backup. IRREVERSIBLE — there is no undo and no confirmation ' +
        'from the panel beyond this tool.\n\n' +
        'Requires `PTERODACTYL_ALLOW_DELETE=true`. Requires confirmation: the first call without ' +
        '`confirmation_token` returns a preview (name, size, created_at) and a token instead of ' +
        'deleting anything — THAT PREVIEW IS FOR THE HUMAN, show it and wait for approval before ' +
        'calling again with the token. A locked backup cannot be deleted here at all; unlock it in ' +
        'the panel first.',
      inputSchema: {
        server: serverIdSchema,
        backup_uuid: z.string().describe('UUID of the backup to delete (from ptero_list_backups).'),
        dry_run: dryRunSchema,
        confirmation_token: confirmationTokenSchema,
      },
      outputSchema: deleteBackupOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ server, backup_uuid, dry_run, confirmation_token }, extra) => {
      try {
        const id = resolveServer(ctx, server);

        let backup;
        try {
          backup = await client.getBackup(id, backup_uuid);
        } catch (err) {
          return fail(err);
        }
        const a = backup.attributes;

        if (a.is_locked) {
          return fail(
            new Error(
              `Backup ${backup_uuid} ("${a.name}") is locked and cannot be deleted through this tool. ` +
                'Unlock it in the panel (Backups -> the backup -> Unlock) first, then retry ' +
                '`ptero_delete_backup`.',
            ),
          );
        }

        const preview = {
          uuid: a.uuid,
          name: a.name,
          bytes: a.bytes,
          bytes_human: bytesToHuman(a.bytes),
          created_at: a.created_at,
          is_locked: a.is_locked,
        };

        const req: MutationRequest = {
          tool: 'ptero_delete_backup',
          server: id,
          args: { backup_uuid },
          kind: 'backup_delete',
          dryRun: dry_run,
          confirmationToken: confirmation_token,
          preview,
          destructive: true,
          wantsAutoBackup: false,
        };

        return await runMutation(
          ctx,
          req,
          extra,
          async () => {
            await client.deleteBackup(id, backup_uuid);
            return { uuid: backup_uuid };
          },
          () => `Deleted backup ${backup_uuid}.`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    'ptero_get_backup_download_url',
    {
      title: 'Get a signed backup download URL',
      description:
        'Get a signed, short-lived URL for downloading one backup archive directly from ' +
        'storage.\n\n' +
        'Use this when the human wants to pull a backup down outside the panel. The URL grants ' +
        'access to the archive to whoever holds it, expires quickly, and is never written to the ' +
        'audit log — treat it as a bearer credential: do not store it, paste it into a chat log ' +
        'you will keep, or reuse it after it expires (request a fresh one instead).',
      inputSchema: {
        server: serverIdSchema,
        backup_uuid: z.string().describe('UUID of the backup to download (from ptero_list_backups).'),
      },
      outputSchema: downloadUrlOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ server, backup_uuid }) => {
      try {
        const id = resolveServer(ctx, server);
        const url = await client.getBackupDownloadUrl(id, backup_uuid);
        const structured = {
          uuid: backup_uuid,
          url,
          note: 'Signed URL, short-lived. Do not store it.',
        };
        return ok(structured, `Download URL for backup ${backup_uuid} (short-lived): ${url}`);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
