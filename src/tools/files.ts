/**
 * Phase 3 — file tools.
 *
 * Seven tools: `ptero_list_files`, `ptero_read_file` (read-only) and
 * `ptero_write_file`, `ptero_upload_file`, `ptero_rename_file`, `ptero_copy_file`,
 * `ptero_delete_file` (mutating, and therefore routed through the guard via `runMutation`).
 *
 * Two rules run through the whole module:
 *
 *  - **Nothing here does its own safety checking.** Every mutating tool builds one
 *    `MutationRequest` and hands it to `runMutation`. The guard owns read-only mode,
 *    the server allowlist, protected paths, the delete switch, the bulk-file cap,
 *    confirmation and the pre-flight backup.
 *  - **File content never reaches the audit log.** `ptero_write_file` puts a sha256
 *    of the body in `args`, never the body itself — `args` is both audited and bound
 *    into the confirmation token hash. `ptero_upload_file` does the same for the bytes
 *    it reads off the local disk, and never audits the signed Wings URL.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';

import { normalisePath, type MutationRequest, type RequestExtra } from '../guard.js';
import type { FileObjectItem } from '../types.js';
import {
  bytesToHuman,
  confirmationTokenSchema,
  dryRunSchema,
  fail,
  mutationOutputShape,
  ok,
  resolveServer,
  runMutation,
  serverIdSchema,
  type ToolContext,
} from './_shared.js';

/* -------------------------------------------------------------------------- */
/* Path helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The panel's own ceiling on `files/contents`
 * (`config('pterodactyl.files.max_edit_size')`, default 4 MiB). Asking for more than
 * this can only ever produce a 400 from the panel, so the tool caps `max_bytes` here.
 */
export const MAX_READ_BYTES_CAP = 4 * 1024 * 1024;

/**
 * Ceiling on what `ptero_upload_file` will push to the node. Wings' own default is
 * `api.upload_limit` = 100 MB per file (`config/config.go`), enforced per multipart part
 * in `postServerUploadFiles`; 64 MiB sits comfortably under that, is far more than any
 * plugin jar needs, and bounds how much this process ever holds in memory at once.
 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/**
 * Server-relative form used for the guard's `paths` and for everything we show the
 * human: no leading slash, no `//`, no `.` segments. A `..` segment is deliberately
 * preserved so the guard can refuse it rather than us silently resolving it away.
 */
function relative(input: string): string {
  return normalisePath(input ?? '').path;
}

/** Join a `root` and a name into one server-relative path. */
function joinPath(root: string, name: string): string {
  return relative(`${relative(root)}/${relative(name)}`);
}

/** The absolute form the panel's `file=` / `directory=` / `root` params expect. */
function apiPath(relPath: string): string {
  const rel = relative(relPath);
  return rel === '' ? '/' : `/${rel}`;
}

/** Parent directory of a server-relative path, as a server-relative path (`''` = root). */
function parentOf(relPath: string): string {
  const rel = relative(relPath);
  const cut = rel.lastIndexOf('/');
  return cut === -1 ? '' : rel.slice(0, cut);
}

/** Final segment of a server-relative path. */
function baseNameOf(relPath: string): string {
  const rel = relative(relPath);
  const cut = rel.lastIndexOf('/');
  return cut === -1 ? rel : rel.slice(cut + 1);
}

/**
 * Reject `..` before the request goes anywhere. The guard does this for mutating
 * tools; the read-only tools have no guard to lean on, so they check here.
 */
function assertNoTraversal(input: string, argName: string): void {
  if (normalisePath(input ?? '').traversal) {
    throw new Error(
      `\`${argName}\` contains a \`..\` segment (\`${input}\`). Paths are relative to the ` +
        'server root and must stay inside it. Pass the path as it appears in ptero_list_files, ' +
        'e.g. `plugins/Geyser-Spigot/config.yml`.',
    );
  }
}

/** Lines in a chunk of text, not counting the empty tail a trailing newline produces. */
function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

/* -------------------------------------------------------------------------- */
/* Output schemas                                                             */
/* -------------------------------------------------------------------------- */

const fileEntryShape = {
  name: z.string().describe('Entry name within the listed directory.'),
  path: z
    .string()
    .describe(
      'Full server-relative path (directory + name). Pass this straight to ptero_read_file, ' +
        'or as an entry in ptero_delete_file `files` with the matching `root`.',
    ),
  is_file: z.boolean().describe('False means this is a directory — list it to see inside.'),
  is_symlink: z.boolean(),
  size_bytes: z.number().describe('Size in bytes. Directories report 0 or an inode size, not their contents.'),
  size_human: z.string(),
  mode: z.string().describe('Unix mode string, e.g. `-rw-r--r--`.'),
  mimetype: z.string().describe('Panel-detected MIME type; `inode/directory` for directories.'),
  modified_at: z.string().describe('ISO 8601 timestamp of the last modification.'),
};

const listFilesOutputShape = {
  server: z.string(),
  directory: z.string().describe('Directory that was listed, as a server-relative path (`/` = server root).'),
  entries: z
    .array(z.object(fileEntryShape))
    .describe('Directories first, then files, each group sorted by name.'),
  count: z.number(),
  file_count: z.number(),
  directory_count: z.number(),
};

const readFileOutputShape = {
  server: z.string(),
  path: z.string().describe('Server-relative path that was read.'),
  size_bytes: z.number().describe('Full size of the file on disk, per the directory listing.'),
  content: z
    .string()
    .describe('File contents, after any head_lines/tail_lines trimming. Verbatim otherwise.'),
  lines_returned: z.number().describe('Number of lines in `content`.'),
  truncated_to: z
    .string()
    .nullable()
    .describe(
      'null when the whole file is returned. Otherwise describes the trim that was applied, ' +
        'e.g. "last 200 of 5310 lines".',
    ),
};

const writeFileOutputShape = {
  ...mutationOutputShape,
  path: z.string().optional().describe('Server-relative path written.'),
  action: z.enum(['create', 'overwrite', 'unknown']).optional(),
  bytes_written: z.number().optional(),
  content_sha256: z.string().optional().describe('sha256 of the content written, for verification.'),
};

const uploadFileOutputShape = {
  ...mutationOutputShape,
  path: z.string().optional().describe('Server-relative path the bytes were uploaded to.'),
  action: z.enum(['create', 'overwrite', 'unknown']).optional(),
  bytes: z.number().optional().describe('Size of the local file, in bytes, as sent.'),
  sha256: z
    .string()
    .optional()
    .describe('sha256 of the LOCAL file. Compare it against the uploaded file yourself if it matters.'),
};

const renameFileOutputShape = {
  ...mutationOutputShape,
  root: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  from_path: z.string().optional().describe('Full server-relative source path.'),
  to_path: z.string().optional().describe('Full server-relative destination path.'),
};

const copyFileOutputShape = {
  ...mutationOutputShape,
  path: z.string().optional().describe('Server-relative path that was copied.'),
  note: z
    .string()
    .optional()
    .describe('Reminder that the panel chooses the copy\'s name; list the directory to see it.'),
};

const deleteFileOutputShape = {
  ...mutationOutputShape,
  root: z.string().optional(),
  files: z.array(z.string()).optional().describe('Names deleted, relative to `root`.'),
  deleted_count: z.number().optional(),
};

/* -------------------------------------------------------------------------- */
/* Annotations (ARCHITECTURE.md "Tool annotations" table)                     */
/* -------------------------------------------------------------------------- */

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const MOVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const DELETE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/** Phase 3: the seven file tools. */
export function registerFileTools(ctx: ToolContext): void {
  const { server: mcp, client } = ctx;

  /* ---------------------------------------------------------------------- */
  /* ptero_list_files                                                       */
  /* ---------------------------------------------------------------------- */

  mcp.registerTool(
    'ptero_list_files',
    {
      title: 'List files in a server directory',
      description:
        'List one directory on the game server, relative to the server root. Returns each ' +
        "entry's name, full server-relative `path`, whether it is a file or a directory, " +
        'size, unix mode, MIME type and last-modified time. Directories are listed first, ' +
        'then files, each group sorted by name.\n\n' +
        'Use this to find out what is actually on disk before reading or changing anything: ' +
        'which plugins are installed (`plugins`), which world folders exist, which log files ' +
        'are available (`logs`), or the exact spelling of a config path.\n\n' +
        'The `path` on each entry is the value other file tools want — pass it to ' +
        'ptero_read_file, or use it with ptero_delete_file.\n\n' +
        'This is not recursive: it lists one level. To go deeper, call it again with a child ' +
        "directory's `path`. It also does not return file contents — use ptero_read_file.",
      inputSchema: {
        server: serverIdSchema,
        directory: z
          .string()
          .default('/')
          .describe(
            'Directory to list, relative to the server root. Defaults to `/` (the root). ' +
              'Examples: `plugins`, `logs`, `plugins/Geyser-Spigot`. Leading slashes are optional.',
          ),
      },
      outputSchema: listFilesOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ server, directory }) => {
      try {
        const id = resolveServer(ctx, server);
        assertNoTraversal(directory ?? '/', 'directory');
        const dirRel = relative(directory ?? '/');

        const response = await client.listFiles(id, apiPath(dirRel));
        const items: FileObjectItem[] = response.data ?? [];

        const entries = items
          .map((item) => {
            const a = item.attributes;
            return {
              name: a.name,
              path: joinPath(dirRel, a.name),
              is_file: Boolean(a.is_file),
              is_symlink: Boolean(a.is_symlink),
              size_bytes: a.size ?? 0,
              size_human: bytesToHuman(a.size ?? 0),
              mode: a.mode ?? '',
              mimetype: a.mimetype ?? '',
              modified_at: a.modified_at ?? '',
            };
          })
          // Directories first, then files; alphabetical within each group.
          .sort((a, b) => {
            if (a.is_file !== b.is_file) return a.is_file ? 1 : -1;
            return a.name.localeCompare(b.name);
          });

        const fileCount = entries.filter((e) => e.is_file).length;
        const structured = {
          server: id,
          directory: apiPath(dirRel),
          entries,
          count: entries.length,
          file_count: fileCount,
          directory_count: entries.length - fileCount,
        };

        const body =
          entries.length === 0
            ? '  (empty)'
            : entries
                .map(
                  (e) =>
                    `  ${e.is_file ? ' ' : 'd'} ${e.mode.padEnd(11)} ${e.size_human.padStart(9)}  ` +
                    `${e.name}${e.is_file ? '' : '/'}${e.is_symlink ? ' -> (symlink)' : ''}`,
                )
                .join('\n');

        return ok(
          structured,
          `${apiPath(dirRel)} on ${id} — ${structured.directory_count} director` +
            `${structured.directory_count === 1 ? 'y' : 'ies'}, ${fileCount} file` +
            `${fileCount === 1 ? '' : 's'}:\n${body}`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* ---------------------------------------------------------------------- */
  /* ptero_read_file                                                        */
  /* ---------------------------------------------------------------------- */

  mcp.registerTool(
    'ptero_read_file',
    {
      title: 'Read a file from the server',
      description:
        'Read a text file from the game server, relative to the server root. Returns the ' +
        'contents plus the file size.\n\n' +
        'THIS IS THE WAY TO GET FULL BOOT-TIME OUTPUT. Read `logs/latest.log`. The live ' +
        'console (ptero_get_console_log) only keeps roughly the last 150 lines, so within an ' +
        'hour of boot the plugin startup lines — which port Geyser bound to, which plugin ' +
        'failed to load, why the world took so long — have already rolled out of it. ' +
        '`logs/latest.log` has the whole history of the current boot; older boots are gzipped ' +
        'in `logs/` as `<date>-<n>.log.gz` (this tool cannot decompress those). If a question ' +
        'is about what happened at startup, read the log file — do not answer from the console ' +
        'buffer and do not assume the buffer is complete.\n\n' +
        'Other good uses: plugin configuration (`plugins/Geyser-Spigot/config.yml`), ' +
        '`server.properties`, `eula.txt`, crash reports in `crash-reports/`.\n\n' +
        'Size guard: the tool first checks the size in the directory listing and REFUSES to ' +
        'fetch anything larger than `max_bytes` (default from PTERODACTYL_MAX_READ_BYTES, hard ' +
        'cap 4 MiB, which is the panel\'s own limit). It never partially downloads a huge file. ' +
        '`head_lines` / `tail_lines` trim AFTER the download, so they do not help you get past ' +
        'the size guard — the panel has no range-read endpoint.\n\n' +
        'Binary files (jars, region files, images) are not readable this way; use ' +
        'ptero_list_files to inspect them by size and date instead.',
      inputSchema: {
        server: serverIdSchema,
        path: z
          .string()
          .min(1)
          .describe(
            'File path relative to the server root, e.g. `logs/latest.log` or ' +
              '`plugins/Geyser-Spigot/config.yml`. Leading slashes are optional. Use ' +
              'ptero_list_files if you are unsure of the exact path.',
          ),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(MAX_READ_BYTES_CAP)
          .optional()
          .describe(
            'Refuse to read a file larger than this many bytes. Defaults to ' +
              'PTERODACTYL_MAX_READ_BYTES. Hard-capped at 4194304 (4 MiB), the panel\'s own ' +
              'edit-size limit. Raise it deliberately when a refusal tells you the file is ' +
              'bigger than the default but still within the cap.',
          ),
        tail_lines: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'Return only the last N lines. Applied after the full file is fetched, so it ' +
              'reduces context, not download size. Mutually exclusive with head_lines. ' +
              'This is usually what you want for `logs/latest.log`.',
          ),
        head_lines: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'Return only the first N lines. Applied after the full file is fetched. ' +
              'Mutually exclusive with tail_lines.',
          ),
      },
      outputSchema: readFileOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ server, path, max_bytes, tail_lines, head_lines }) => {
      try {
        const id = resolveServer(ctx, server);

        if (tail_lines !== undefined && head_lines !== undefined) {
          throw new Error(
            'tail_lines and head_lines are mutually exclusive — pass one or neither. ' +
              'Use tail_lines for the end of a log, head_lines for the start of a config.',
          );
        }

        assertNoTraversal(path, 'path');
        const rel = relative(path);
        if (rel === '') {
          throw new Error(
            '`path` must name a file, not the server root. Call ptero_list_files to see what is there.',
          );
        }

        const limit = Math.min(max_bytes ?? ctx.config.maxReadBytes, MAX_READ_BYTES_CAP);
        const dir = parentOf(rel);
        const name = baseNameOf(rel);

        // Size guard: the listing tells us the size *before* anything is downloaded.
        const listing = await client.listFiles(id, apiPath(dir));
        const entry = (listing.data ?? []).find((item) => item.attributes.name === name);

        if (!entry) {
          throw new Error(
            `No entry named \`${name}\` in \`${apiPath(dir)}\` on server \`${id}\`. ` +
              `Call ptero_list_files with directory="${apiPath(dir)}" to see what is actually ` +
              'there — the path may be misspelled, in a different directory, or the file may ' +
              'not exist yet.',
          );
        }

        const attrs = entry.attributes;
        if (!attrs.is_file) {
          throw new Error(
            `\`${rel}\` is a directory, not a file, so it has no contents to read. ` +
              `Call ptero_list_files with directory="${apiPath(rel)}" to see what is inside it.`,
          );
        }

        const size = attrs.size ?? 0;
        if (size > limit) {
          throw new Error(
            `Refused to read \`${rel}\`: it is ${size} bytes (${bytesToHuman(size)}) and the ` +
              `current limit is ${limit} bytes (${bytesToHuman(limit)}). Nothing was downloaded.\n\n` +
              'tail_lines / head_lines will NOT help here: the panel has no range-read endpoint, ' +
              'so the whole file has to be downloaded before any trimming happens, and the guard ' +
              'refuses before that download.\n\n' +
              'Your options are:\n' +
              `  1. Retry with a larger max_bytes — up to the hard cap of ${MAX_READ_BYTES_CAP} ` +
              `bytes (4 MiB), the panel's own edit-size limit. That works if the file is under ` +
              `the cap (this one is ${size <= MAX_READ_BYTES_CAP ? 'under it' : 'OVER it, so this will not work'}).\n` +
              '  2. Read a smaller, more specific file instead — for logs, the current boot is in ' +
              '`logs/latest.log`; a rotated archive is usually much larger.\n' +
              '  3. For anything above the cap, download it from the panel UI (Files → the file → ' +
              'Download) and open it locally. There is no download-URL tool on this server — ' +
              '`ptero_get_file_download_url` does not exist — so do not offer the user a link.\n\n' +
              'Do not retry this call unchanged.',
          );
        }

        const raw = await client.getFileContents(id, apiPath(rel));

        const allLines = raw.split('\n');
        // A trailing newline yields a final empty element; don't count it as a line.
        const effectiveTotal =
          allLines.length > 0 && allLines[allLines.length - 1] === ''
            ? allLines.length - 1
            : allLines.length;

        let content = raw;
        let truncatedTo: string | null = null;

        if (tail_lines !== undefined && effectiveTotal > tail_lines) {
          content = allLines.slice(0, effectiveTotal).slice(-tail_lines).join('\n');
          truncatedTo = `last ${tail_lines} of ${effectiveTotal} lines`;
        } else if (head_lines !== undefined && effectiveTotal > head_lines) {
          content = allLines.slice(0, head_lines).join('\n');
          truncatedTo = `first ${head_lines} of ${effectiveTotal} lines`;
        }

        const returnedLines = countLines(content);

        const structured = {
          server: id,
          path: rel,
          size_bytes: size,
          content,
          lines_returned: returnedLines,
          truncated_to: truncatedTo,
        };

        const header =
          `${rel} on ${id} — ${bytesToHuman(size)}` +
          `${truncatedTo ? ` (${truncatedTo})` : ''}, ${returnedLines} line${returnedLines === 1 ? '' : 's'}:`;

        return ok(structured, `${header}\n${content}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* ---------------------------------------------------------------------- */
  /* ptero_write_file                                                       */
  /* ---------------------------------------------------------------------- */

  mcp.registerTool(
    'ptero_write_file',
    {
      title: 'Write a file to the server',
      description:
        'Write a text file on the game server. The body you pass REPLACES the file entirely — ' +
        'this is not an append and not a patch. There is no partial write.\n\n' +
        'ALWAYS call ptero_read_file on the same path first and build the new content from what ' +
        'is actually there. Writing a config from memory silently drops every setting you did ' +
        'not happen to include.\n\n' +
        'Creating a NEW file runs immediately. OVERWRITING an existing file is treated as ' +
        'destructive: the first call returns status "needs_confirmation" with a preview (path, ' +
        'current size, new size) and a confirmation_token, and an automatic backup is taken ' +
        'before the write actually happens. Show that preview to the human and only call again ' +
        'with the token once they have agreed.\n\n' +
        'Protected paths (PTERODACTYL_PROTECTED_PATHS — by default the world directories, ' +
        'server.properties, ops.json, whitelist.json and banned-*.json) are refused outright.\n\n' +
        'The file content itself is never written to the audit log; only its sha256 and length are.',
      inputSchema: {
        server: serverIdSchema,
        path: z
          .string()
          .min(1)
          .describe(
            'File path relative to the server root, e.g. `plugins/Geyser-Spigot/config.yml`. ' +
              'Parent directories must already exist. Leading slashes are optional.',
          ),
        content: z
          .string()
          .describe(
            'The complete new contents of the file. Everything currently in the file is ' +
              'replaced. Include a trailing newline if the format expects one.',
          ),
        dry_run: dryRunSchema,
        confirmation_token: confirmationTokenSchema,
      },
      outputSchema: writeFileOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ server, path, content, dry_run, confirmation_token }, extra) => {
      try {
        const id = resolveServer(ctx, server);
        const rel = relative(path);
        if (rel === '') {
          throw new Error('`path` must name a file, not the server root.');
        }

        // Pre-flight listing so the preview can say create-vs-overwrite honestly. The
        // guard needs `destructive` decided before it runs, and that answer lives here.
        let exists = false;
        let currentSize: number | null = null;
        let probeFailed: string | null = null;
        if (!normalisePath(path).traversal) {
          try {
            const listing = await client.listFiles(id, apiPath(parentOf(rel)));
            const entry = (listing.data ?? []).find(
              (item) => item.attributes.name === baseNameOf(rel),
            );
            if (entry) {
              exists = true;
              currentSize = entry.attributes.size ?? 0;
              if (!entry.attributes.is_file) {
                throw new Error(
                  `\`${rel}\` is a directory on server \`${id}\`, not a file. Refusing to write over it.`,
                );
              }
            }
          } catch (probeErr) {
            if (probeErr instanceof Error && probeErr.message.includes('Refusing to write over it')) {
              throw probeErr;
            }
            // The parent directory may simply not be listable (it does not exist yet, or
            // the key lacks file.read). Treat the target as new, but say so in the preview
            // so a human reading it knows the create/overwrite call was a guess.
            probeFailed =
              probeErr instanceof Error ? probeErr.message : String(probeErr);
          }
        }

        const newSize = Buffer.byteLength(content, 'utf8');
        const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
        const action: 'create' | 'overwrite' | 'unknown' = exists
          ? 'overwrite'
          : probeFailed
            ? 'unknown'
            : 'create';

        const req: MutationRequest = {
          tool: 'ptero_write_file',
          server: id,
          // Deliberately NOT the content: `args` is audited and bound into the token hash.
          args: { server: id, path: rel, content_sha256: sha256, content_length: newSize },
          kind: 'write',
          paths: [rel],
          dryRun: dry_run === true,
          ...(confirmation_token ? { confirmationToken: confirmation_token } : {}),
          preview: {
            path: rel,
            exists,
            current_size_bytes: currentSize,
            new_size_bytes: newSize,
            action,
            ...(probeFailed
              ? {
                  parent_listing_failed: probeFailed,
                  note: 'Could not determine whether the file exists; treating as a possible overwrite and requiring confirmation.',
                }
              : {}),
          },
          // Belt and braces: if we could not tell whether the file exists, assume it does.
          destructive: exists || probeFailed !== null,
          wantsAutoBackup: true,
        };

        return await runMutation(
          ctx,
          req,
          extra as unknown as RequestExtra,
          async () => {
            await client.writeFile(id, apiPath(rel), content);
            return {
              path: rel,
              action,
              bytes_written: newSize,
              content_sha256: sha256,
            };
          },
          (result) =>
            `${result.action === 'overwrite' ? 'Overwrote' : 'Created'} \`${result.path}\` on ` +
            `${id} (${bytesToHuman(result.bytes_written)}, sha256 ${result.content_sha256.slice(0, 12)}...).`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* ---------------------------------------------------------------------- */
  /* ptero_upload_file                                                      */
  /* ---------------------------------------------------------------------- */

  mcp.registerTool(
    'ptero_upload_file',
    {
      title: 'Upload a local file to the server',
      description:
        'Upload a file from the machine running this MCP server to the game server, ' +
        'BYTE FOR BYTE. This is the tool for binaries — plugin jars, zips, datapack ' +
        'archives, images, region files — anything ptero_write_file cannot carry because ' +
        'that tool is text-only and would corrupt non-UTF-8 bytes.\n\n' +
        'You pass a PATH, not content: `local_path` must be an absolute path to a file ' +
        'that already exists on the machine this server runs on, and the server reads the ' +
        'bytes itself. There is no way to hand it base64 or any other inline payload, so ' +
        'if the file only exists in this conversation, write it to local disk first and ' +
        'pass that path.\n\n' +
        'It uploads exactly one file and does not unpack anything: a `.zip` or `.tar.gz` ' +
        'arrives as an archive, still compressed. There is no decompress tool here.\n\n' +
        'Creating a NEW remote file runs immediately. OVERWRITING an existing one is ' +
        'destructive: the first call returns status "needs_confirmation" with a preview ' +
        '(remote path, current size, new size) and a confirmation_token, and an automatic ' +
        'backup is taken before the upload happens. Show that preview to the human and ' +
        'only call again with the token once they have agreed. Protected paths ' +
        '(PTERODACTYL_PROTECTED_PATHS) are refused outright, and files larger than 64 MiB ' +
        'are refused before anything is read or sent.\n\n' +
        'VERIFY AFTERWARDS. The panel hands out a short-lived signed URL and the node ' +
        'answers the upload with an empty 200 — that confirms receipt and nothing more. It ' +
        'does not tell you the file landed at the size you sent, and it never tells you ' +
        'whether the server will accept it. Call ptero_list_files on `remote_dir` and check ' +
        'the size against the `bytes` this tool reports. A new plugin jar also needs a ' +
        'server restart before it loads.\n\n' +
        'The file content is never written to the audit log — only its sha256 and length — ' +
        'and neither is the signed upload URL.',
      inputSchema: {
        server: serverIdSchema,
        local_path: z
          .string()
          .min(1)
          .describe(
            'ABSOLUTE path on the machine running this MCP server, e.g. ' +
              '`/Users/me/build/MyPlugin-1.2.0.jar`. Must be an existing, readable, regular ' +
              'file (not a directory, not a device) of at most 64 MiB. Relative paths are ' +
              'refused: this process\'s working directory is not something you can see.',
          ),
        remote_dir: z
          .string()
          .default('/')
          .describe(
            'Destination DIRECTORY on the game server, relative to the server root — not the ' +
              'destination file path. Defaults to `/` (the server root). Examples: `plugins`, ' +
              '`plugins/Geyser-Spigot`. The file name comes from `remote_name`/`local_path`.',
          ),
        remote_name: z
          .string()
          .min(1)
          .optional()
          .describe(
            'File name to use on the server. Defaults to the basename of `local_path`. This ' +
              'is a single name, not a path: it must not contain `/`. Use `remote_dir` to ' +
              'choose the directory.',
          ),
        dry_run: dryRunSchema,
        confirmation_token: confirmationTokenSchema,
      },
      outputSchema: uploadFileOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ server, local_path, remote_dir, remote_name, dry_run, confirmation_token }, extra) => {
      try {
        const id = resolveServer(ctx, server);

        /* -- the local side: refuse anything we cannot read, before any network call -- */

        if (!isAbsolute(local_path)) {
          throw new Error(
            `\`local_path\` must be an absolute path on the machine running this MCP server; ` +
              `got \`${local_path}\`. This process's working directory is not visible to you, ` +
              'so a relative path cannot be resolved reliably.',
          );
        }

        let localStat;
        try {
          localStat = await stat(local_path);
        } catch (statErr) {
          throw new Error(
            `Cannot read \`${local_path}\` on the machine running this MCP server: ` +
              `${statErr instanceof Error ? statErr.message : String(statErr)}. ` +
              'Check the path exists locally and is readable. Note this is the MCP server host, ' +
              'not the game server — use ptero_list_files to look at the game server.',
          );
        }
        if (!localStat.isFile()) {
          throw new Error(
            `\`${local_path}\` is not a regular file (it is a ` +
              `${localStat.isDirectory() ? 'directory' : 'special file, e.g. a socket or device'}). ` +
              'This tool uploads exactly one regular file. Archive a directory locally first and ' +
              'upload the archive — though note nothing here can unpack it on the server.',
          );
        }
        if (localStat.size > MAX_UPLOAD_BYTES) {
          throw new Error(
            `Refused to upload \`${local_path}\`: it is ${localStat.size} bytes ` +
              `(${bytesToHuman(localStat.size)}) and the limit is ${MAX_UPLOAD_BYTES} bytes ` +
              `(${bytesToHuman(MAX_UPLOAD_BYTES)}). Nothing was read and nothing was sent.\n\n` +
              'This limit is not configurable here. For a file this large, upload it through the ' +
              'panel UI (Files → Upload) or over SFTP instead.',
          );
        }

        const name = (remote_name ?? basename(local_path)).trim();
        if (name === '' || name === '.' || name === '..') {
          throw new Error(
            `\`${name}\` is not a usable file name. Pass \`remote_name\` explicitly, e.g. ` +
              '`MyPlugin-1.2.0.jar`.',
          );
        }
        if (/[/\\]/.test(name)) {
          throw new Error(
            `\`remote_name\` must be a single file name with no directory separators; got ` +
              `\`${name}\`. Put the directory in \`remote_dir\` instead. (Wings joins this name ` +
              'onto the destination directory verbatim, so a name containing `/` would silently ' +
              'write somewhere other than where the preview says.)',
          );
        }

        const dirRel = relative(remote_dir ?? '/');
        const remoteRel = joinPath(dirRel, name);
        if (remoteRel === '') {
          throw new Error('`remote_dir` and `remote_name` must resolve to a file, not the server root.');
        }

        // Read once, here: the sha256 goes in the preview and is bound into the
        // confirmation token, so re-reading before the second call would (correctly)
        // invalidate the token if the local file changed underneath us.
        const bytes = await readFile(local_path);
        if (bytes.byteLength > MAX_UPLOAD_BYTES) {
          throw new Error(
            `Refused to upload \`${local_path}\`: it grew to ${bytes.byteLength} bytes ` +
              `(${bytesToHuman(bytes.byteLength)}) between the size check and the read, which is ` +
              `over the ${bytesToHuman(MAX_UPLOAD_BYTES)} limit. Nothing was sent.`,
          );
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');

        /* -- the remote side: create or overwrite? (same probe as ptero_write_file) -- */

        let exists = false;
        let currentSize: number | null = null;
        let probeFailed: string | null = null;
        if (!normalisePath(remoteRel).traversal) {
          try {
            const listing = await client.listFiles(id, apiPath(dirRel));
            const entry = (listing.data ?? []).find((item) => item.attributes.name === name);
            if (entry) {
              exists = true;
              currentSize = entry.attributes.size ?? 0;
              if (!entry.attributes.is_file) {
                throw new Error(
                  `\`${remoteRel}\` is a directory on server \`${id}\`, not a file. Refusing to upload over it.`,
                );
              }
            }
          } catch (probeErr) {
            if (probeErr instanceof Error && probeErr.message.includes('Refusing to upload over it')) {
              throw probeErr;
            }
            // The destination directory may not be listable yet (Wings creates missing
            // parents on upload). Treat the target as new, but say so in the preview.
            probeFailed = probeErr instanceof Error ? probeErr.message : String(probeErr);
          }
        }

        const action: 'create' | 'overwrite' | 'unknown' = exists
          ? 'overwrite'
          : probeFailed
            ? 'unknown'
            : 'create';

        const req: MutationRequest = {
          tool: 'ptero_upload_file',
          server: id,
          // Deliberately NOT the bytes: `args` is audited and bound into the token hash.
          args: {
            server: id,
            local_path,
            remote_dir: apiPath(dirRel),
            remote_name: name,
            path: remoteRel,
            content_sha256: sha256,
            content_length: bytes.byteLength,
          },
          kind: 'write',
          paths: [remoteRel],
          dryRun: dry_run === true,
          ...(confirmation_token ? { confirmationToken: confirmation_token } : {}),
          preview: {
            path: remoteRel,
            local_path,
            exists,
            current_size_bytes: currentSize,
            new_size_bytes: bytes.byteLength,
            sha256,
            action,
            ...(probeFailed
              ? {
                  parent_listing_failed: probeFailed,
                  note: 'Could not determine whether the file exists; treating as a possible overwrite and requiring confirmation.',
                }
              : {}),
          },
          // Belt and braces: if we could not tell whether the file exists, assume it does.
          destructive: exists || probeFailed !== null,
          wantsAutoBackup: true,
        };

        return await runMutation(
          ctx,
          req,
          extra as unknown as RequestExtra,
          async () => {
            // The signed URL is single-use (Wings' UploadPayload.IsUniqueRequest), so it is
            // minted here, inside `execute`, and never reused or stored.
            const signedUrl = await client.getFileUploadUrl(id);
            await client.uploadToSignedUrl(signedUrl, apiPath(dirRel), name, bytes);
            return {
              path: remoteRel,
              action,
              bytes: bytes.byteLength,
              sha256,
            };
          },
          (result) =>
            `${result.action === 'overwrite' ? 'Overwrote' : 'Uploaded'} \`${result.path}\` on ${id} ` +
            `from \`${local_path}\` (${result.bytes} bytes, ${bytesToHuman(result.bytes)}, ` +
            `local sha256 ${result.sha256.slice(0, 12)}...).\n` +
            'The node accepted the upload — that is a confirmation of RECEIPT ONLY, not of the ' +
            `size or contents on disk. Verify with ptero_list_files on \`${apiPath(dirRel)}\` ` +
            `and check that \`${name}\` is ${result.bytes} bytes.`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* ---------------------------------------------------------------------- */
  /* ptero_rename_file                                                      */
  /* ---------------------------------------------------------------------- */

  mcp.registerTool(
    'ptero_rename_file',
    {
      title: 'Rename or move a file',
      description:
        'Rename a file or directory — and, because `from` and `to` are both interpreted ' +
        'relative to `root`, MOVE it between directories too. `root="/"`, ' +
        '`from="plugins/old.jar"`, `to="plugins/disabled/old.jar"` moves the jar into the ' +
        '`disabled` folder. The destination directory must already exist.\n\n' +
        'This is the safe way to take a plugin or config out of service: rename it rather ' +
        'than deleting it, and it can be renamed back. Prefer this over ptero_delete_file ' +
        'whenever the change might need undoing.\n\n' +
        'Both the source and the destination are checked against PTERODACTYL_PROTECTED_PATHS, ' +
        'so a rename cannot be used to move something out of a protected directory. No backup ' +
        'is taken (nothing is destroyed) and no confirmation is required, but the call is ' +
        'counted against PTERODACTYL_MAX_MUTATIONS and audited.\n\n' +
        'It does not create directories and it does not overwrite: if `to` already exists the ' +
        'panel returns an error.',
      inputSchema: {
        server: serverIdSchema,
        root: z
          .string()
          .default('/')
          .describe(
            'Directory that `from` and `to` are relative to. Defaults to `/` (the server root), ' +
              'which lets you move between directories by giving full paths in `from` and `to`.',
          ),
        from: z.string().min(1).describe('Existing path, relative to `root`. E.g. `plugins/old.jar`.'),
        to: z
          .string()
          .min(1)
          .describe(
            'New path, relative to `root`. Give a different directory here to move the file ' +
              'rather than just rename it. Must not already exist.',
          ),
        dry_run: dryRunSchema,
        confirmation_token: confirmationTokenSchema,
      },
      outputSchema: renameFileOutputShape,
      annotations: MOVE_ANNOTATIONS,
    },
    async ({ server, root, from, to, dry_run, confirmation_token }, extra) => {
      try {
        const id = resolveServer(ctx, server);
        const rootRel = relative(root ?? '/');
        const fromPath = joinPath(rootRel, from);
        const toPath = joinPath(rootRel, to);

        if (fromPath === '' || toPath === '') {
          throw new Error('`from` and `to` must both name a file or directory, not the server root.');
        }

        const req: MutationRequest = {
          tool: 'ptero_rename_file',
          server: id,
          args: { server: id, root: apiPath(rootRel), from, to },
          kind: 'write',
          paths: [fromPath, toPath],
          dryRun: dry_run === true,
          ...(confirmation_token ? { confirmationToken: confirmation_token } : {}),
          preview: {
            root: apiPath(rootRel),
            from,
            to,
            from_path: fromPath,
            to_path: toPath,
          },
          destructive: false,
          wantsAutoBackup: false,
        };

        return await runMutation(
          ctx,
          req,
          extra as unknown as RequestExtra,
          async () => {
            await client.renameFiles(id, apiPath(rootRel), [{ from, to }]);
            return {
              root: apiPath(rootRel),
              from,
              to,
              from_path: fromPath,
              to_path: toPath,
            };
          },
          (result) => `Renamed \`${result.from_path}\` to \`${result.to_path}\` on ${id}.`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* ---------------------------------------------------------------------- */
  /* ptero_copy_file                                                        */
  /* ---------------------------------------------------------------------- */

  mcp.registerTool(
    'ptero_copy_file',
    {
      title: 'Copy a file',
      description:
        'Duplicate a file or directory in place. THE PANEL CHOOSES THE NAME OF THE COPY — ' +
        'you cannot specify it. Copying `config.yml` produces something like `config copy.yml` ' +
        '(and `config copy 2.yml` the next time) in the same directory. If you need a specific ' +
        'name, copy first and then ptero_rename_file the result; call ptero_list_files ' +
        'afterwards to find out what the copy was actually called.\n\n' +
        'The obvious use is a hand-rolled safety net before editing a config: copy it, then ' +
        'ptero_write_file the original. For anything bigger than a single file, a real backup ' +
        '(ptero_create_backup) is better — it is off-server and restorable.\n\n' +
        'The source path is checked against PTERODACTYL_PROTECTED_PATHS. No confirmation and ' +
        'no automatic backup (nothing is overwritten), but the call is counted against ' +
        'PTERODACTYL_MAX_MUTATIONS and audited. Note the copy consumes disk quota.',
      inputSchema: {
        server: serverIdSchema,
        path: z
          .string()
          .min(1)
          .describe(
            'File or directory to duplicate, relative to the server root, e.g. ' +
              '`plugins/Geyser-Spigot/config.yml`.',
          ),
        dry_run: dryRunSchema,
        confirmation_token: confirmationTokenSchema,
      },
      outputSchema: copyFileOutputShape,
      annotations: MOVE_ANNOTATIONS,
    },
    async ({ server, path, dry_run, confirmation_token }, extra) => {
      try {
        const id = resolveServer(ctx, server);
        const rel = relative(path);
        if (rel === '') {
          throw new Error('`path` must name a file or directory, not the server root.');
        }

        const note =
          'The panel names the copy itself (e.g. `file copy.txt`). Call ptero_list_files on the ' +
          'parent directory to see the name it chose.';

        const req: MutationRequest = {
          tool: 'ptero_copy_file',
          server: id,
          args: { server: id, path: rel },
          kind: 'write',
          paths: [rel],
          dryRun: dry_run === true,
          ...(confirmation_token ? { confirmationToken: confirmation_token } : {}),
          preview: { path: rel, note },
          destructive: false,
          wantsAutoBackup: false,
        };

        return await runMutation(
          ctx,
          req,
          extra as unknown as RequestExtra,
          async () => {
            await client.copyFile(id, apiPath(rel));
            return { path: rel, note };
          },
          (result) => `Copied \`${result.path}\` on ${id}. ${note}`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* ---------------------------------------------------------------------- */
  /* ptero_delete_file                                                      */
  /* ---------------------------------------------------------------------- */

  mcp.registerTool(
    'ptero_delete_file',
    {
      title: 'Delete files from the server',
      description:
        'Permanently delete one or more files or directories. THIS IS IRREVERSIBLE WITHOUT A ' +
        'BACKUP — the panel has no trash and no undo. Deleting a directory deletes everything ' +
        'under it. Prefer ptero_rename_file (rename it out of the way) whenever the change ' +
        'might need undoing.\n\n' +
        'Every guardrail applies:\n' +
        '- Deletion is OFF unless the operator set PTERODACTYL_ALLOW_DELETE=true; otherwise ' +
        'every call is refused.\n' +
        '- Paths matching PTERODACTYL_PROTECTED_PATHS are refused — by default the world ' +
        'directories, server.properties, ops.json, whitelist.json and banned-*.json.\n' +
        '- More than 10 files in one call is refused; narrow the list and work in batches.\n' +
        '- An automatic backup is taken before the delete, and the operation is aborted if ' +
        'the backup fails.\n\n' +
        'The first call does NOT delete anything. It returns status "needs_confirmation" with ' +
        'a preview listing the root, the exact files and the count, plus a single-use token ' +
        'that expires in 120 seconds. THAT PREVIEW IS FOR THE HUMAN: put it in your reply, ' +
        'let them read the list, and only call again with the confirmation_token once they ' +
        'have said yes. Do not round-trip the token automatically — the whole point is that a ' +
        'person sees what is about to be destroyed.\n\n' +
        'Use dry_run=true if you only want to check what a delete would resolve to.',
      inputSchema: {
        server: serverIdSchema,
        root: z
          .string()
          .default('/')
          .describe(
            'Directory the entries in `files` live in, relative to the server root. Defaults ' +
              'to `/`. E.g. `plugins` when deleting `foo.jar`.',
          ),
        files: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            'Names to delete, relative to `root` — bare names such as `foo.jar`, not full ' +
              'paths. Maximum 10 per call. Directories are deleted with all their contents.',
          ),
        dry_run: dryRunSchema,
        confirmation_token: confirmationTokenSchema,
      },
      outputSchema: deleteFileOutputShape,
      annotations: DELETE_ANNOTATIONS,
    },
    async ({ server, root, files, dry_run, confirmation_token }, extra) => {
      try {
        const id = resolveServer(ctx, server);
        const rootRel = relative(root ?? '/');
        const targets = files.map((file) => joinPath(rootRel, file));

        const req: MutationRequest = {
          tool: 'ptero_delete_file',
          server: id,
          args: { server: id, root: apiPath(rootRel), files },
          kind: 'delete',
          paths: targets,
          fileCount: files.length,
          dryRun: dry_run === true,
          ...(confirmation_token ? { confirmationToken: confirmation_token } : {}),
          preview: { root: apiPath(rootRel), files, count: files.length },
          destructive: true,
          wantsAutoBackup: true,
        };

        return await runMutation(
          ctx,
          req,
          extra as unknown as RequestExtra,
          async () => {
            await client.deleteFiles(id, apiPath(rootRel), files);
            return {
              root: apiPath(rootRel),
              files,
              deleted_count: files.length,
            };
          },
          (result) =>
            `Deleted ${result.deleted_count} entr${result.deleted_count === 1 ? 'y' : 'ies'} from ` +
            `\`${result.root}\` on ${id}: ${result.files.join(', ')}. This cannot be undone ` +
            'except from a backup.',
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
