import { z } from 'zod';

import { WingsSocket } from '../console/websocket.js';
import { PteroApiError } from '../errors.js';
import type { MutationRequest } from '../guard.js';
import {
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
/* Input schemas                                                             */
/* -------------------------------------------------------------------------- */

const windowSecondsSchema = z
  .number()
  .int()
  .min(1)
  .max(60)
  .default(5)
  .describe(
    'How long to stay connected collecting console output, in seconds (1-60, default 5). ' +
      'Collection stops early once `max_lines` is reached.',
  );

const maxLinesSchema = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .default(400)
  .describe(
    'Stop collecting once this many lines have been gathered (1-1000, default 400). The ' +
      "node's backlog alone is ~150 lines, so the default leaves room to also observe " +
      'lines streamed during `window_seconds`. `truncated: true` in the result means this ' +
      'cap cut collection short.',
  );

const filterSchema = z
  .string()
  .optional()
  .describe(
    'Optional case-insensitive filter applied to lines AFTER they are collected: a regular ' +
      'expression if `filter` parses as one, otherwise a plain substring match. Useful for ' +
      'pulling out e.g. Geyser lines ("geyser") from a busy console without widening the window.',
  );

/**
 * 1-4096 characters, no embedded newline (Wings sends one console line per command), and
 * never empty once surrounding whitespace is trimmed.
 */
const consoleCommandSchema = z
  .string()
  .min(1, 'command must not be empty')
  .max(4096, 'command must be 4096 characters or fewer')
  .refine((s) => !/[\r\n]/.test(s), {
    message: 'command must not contain newlines — send one command per call',
  })
  .transform((s) => s.trim())
  .refine((s) => s.length > 0, { message: 'command must not be empty or whitespace-only' })
  .describe(
    'The exact command to send, as you would type it at the console (no leading `/`). ' +
      '1-4096 characters, a single line, trimmed of surrounding whitespace.',
  );

/* -------------------------------------------------------------------------- */
/* Output schemas                                                             */
/* -------------------------------------------------------------------------- */

const getConsoleLogOutputShape = {
  server: z.string().describe('Server short identifier the log was read from.'),
  state: z
    .string()
    .describe(
      'Wings-reported power state at the time of collection (offline/starting/running/' +
        'stopping), or "unknown" if no status event arrived during the window.',
    ),
  lines: z
    .array(z.string())
    .describe(
      'Collected console lines, ANSI escape codes stripped, oldest first. Filtered by ' +
        '`filter` when one was given.',
    ),
  line_count: z.number().describe('Number of lines in `lines` (after filtering).'),
  truncated: z
    .boolean()
    .describe('True when `max_lines` cut off further backlog or streamed output.'),
  window_seconds: z.number().describe('The collection window that was actually used.'),
  duration_ms: z.number().describe('Wall-clock time the collection took, in milliseconds.'),
  note: z
    .string()
    .optional()
    .describe(
      'Caveats worth surfacing: the server was offline, the node throttled a request, or the ' +
        'filter matched nothing.',
    ),
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Case-insensitive: a regular expression if `filter` parses as one, else a substring test. */
function buildFilterTester(filter: string): (line: string) => boolean {
  try {
    const re = new RegExp(filter, 'i');
    return (line) => re.test(line);
  } catch {
    const needle = filter.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/** Phase 2: the console. Registers ptero_get_console_log and ptero_send_console_command. */
export function registerConsoleTools(ctx: ToolContext): void {
  const { server: mcp, client, config } = ctx;

  mcp.registerTool(
    'ptero_get_console_log',
    {
      title: 'Read the Pterodactyl live console',
      description:
        "Connect to the server's live console websocket and return the backlog it hands " +
        'back on connect (the node\'s ring buffer, ~150 most recent lines by default) plus ' +
        'whatever new lines stream in during the collection window, then disconnect.\n\n' +
        'Pterodactyl has no "give me the last N lines" request over REST — this websocket ' +
        'round trip is the only way to read console output, and what you get is a live ' +
        'snapshot, not a query over history.\n\n' +
        'The buffer rolls over quickly: roughly an hour after boot the plugin startup lines ' +
        'are already gone from it. For boot-time or plugin-load output, use `ptero_read_file` ' +
        'on `logs/latest.log` instead — that has the full run history.\n\n' +
        'After calling `ptero_send_console_command`, you MUST call this tool to see what the ' +
        'command did: dispatching a command never returns its output by itself.\n\n' +
        '`filter` narrows the returned lines (case-insensitive substring, or a regex if it ' +
        'parses as one) without needing a wider window — e.g. `filter: "geyser"` to isolate ' +
        'Geyser lines in a busy log.',
      inputSchema: {
        server: serverIdSchema,
        window_seconds: windowSecondsSchema,
        max_lines: maxLinesSchema,
        filter: filterSchema,
      },
      outputSchema: getConsoleLogOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ server, window_seconds, max_lines, filter }) => {
      try {
        const id = resolveServer(ctx, server);
        const socket = new WingsSocket({ creds: client, server: id, panelUrl: config.panelUrl });
        const result = await socket.collectLogs({
          windowMs: window_seconds * 1000,
          maxLines: max_lines,
        });
        const state = result.state ?? 'unknown';

        const notes: string[] = [];
        if (result.note) notes.push(result.note);

        const collected = result.lines;
        if (collected.length === 0 && state === 'offline') {
          notes.push(`${id} is offline — there is no live console to read.`);
        }

        let lines = collected;
        if (filter && filter.trim().length > 0) {
          const test = buildFilterTester(filter);
          lines = collected.filter(test);
          if (lines.length === 0 && collected.length > 0) {
            notes.push(
              `No collected lines matched filter "${filter}" (${collected.length} line(s) were collected).`,
            );
          }
        }

        const structured = {
          server: id,
          state,
          lines,
          line_count: lines.length,
          truncated: result.truncated,
          window_seconds,
          duration_ms: result.durationMs,
          ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
        };

        const header =
          `${id} console — state=${state}, ${lines.length} line${lines.length === 1 ? '' : 's'}` +
          `${result.truncated ? ' (truncated)' : ''}${filter ? ` [filter: ${filter}]` : ''}`;
        const body = lines.length > 0 ? lines.join('\n') : notes.join(' ') || '(no console output collected in the window)';

        return ok(structured, `${header}\n${body}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    'ptero_send_console_command',
    {
      title: 'Send a Pterodactyl console command',
      description:
        "Send a command to the server console via the panel's command endpoint (the panel " +
        'forwards it to the running process). This confirms DISPATCH ONLY — it does NOT return the ' +
        "command's output. Wings does not correlate console output with the command that " +
        'produced it, so there is no request/response shape to report here, faked or ' +
        'otherwise: the output is asynchronous. Call ptero_get_console_log immediately ' +
        'afterwards (a window_seconds of 3-5 is usually enough) to read what the command did.\n\n' +
        'Do not use this to stop, restart or kill the server. A command like `stop` will ' +
        'shut it down, but ptero_set_power_state is the correct, guarded way to change power ' +
        'state and should be preferred for that.\n\n' +
        'The panel answers with HTTP 502 when the target server is offline, since console ' +
        'commands require a running server — that is reported back as an actionable error ' +
        'telling you to start the server with ptero_set_power_state first.',
      inputSchema: {
        server: serverIdSchema,
        command: consoleCommandSchema,
        dry_run: dryRunSchema,
      },
      outputSchema: {
        ...mutationOutputShape,
        command: z.string().optional().describe('The exact command that was dispatched.'),
        dispatched: z
          .boolean()
          .optional()
          .describe('True once the panel accepted the command for delivery to the daemon.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ server, command, dry_run }, extra) => {
      try {
        const id = resolveServer(ctx, server);
        const req: MutationRequest = {
          tool: 'ptero_send_console_command',
          server: id,
          args: { server: id, command },
          kind: 'command',
          dryRun: dry_run,
          preview: { command },
          destructive: false,
          wantsAutoBackup: false,
        };

        return await runMutation(
          ctx,
          req,
          extra,
          async () => {
            try {
              await client.sendCommand(id, command);
            } catch (err) {
              if (err instanceof PteroApiError && err.status === 502) {
                throw new Error(
                  'Server is offline; start it with `ptero_set_power_state` first — console ' +
                    'commands require a running server.',
                );
              }
              throw err;
            }
            return { command, dispatched: true as const };
          },
          (result) =>
            `Dispatched \`${result.command}\` to ${id}. This confirms dispatch only — output ` +
            'is asynchronous and is not returned here. Call ptero_get_console_log ' +
            '(window_seconds 3-5 is usually enough) to see what happened.',
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
