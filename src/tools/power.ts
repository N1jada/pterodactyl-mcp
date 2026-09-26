import { z } from 'zod';

import type { PteroClient } from '../client.js';
import type { MutationRequest } from '../guard.js';
import type { PowerSignal } from '../types.js';
import {
  confirmationTokenSchema,
  dryRunSchema,
  fail,
  mutationOutputShape,
  resolveServer,
  runMutation,
  serverIdSchema,
  type ToolContext,
} from './_shared.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** How often to re-check the power state while `wait_seconds` is polling. */
const POLL_INTERVAL_MS = 2_000;

/** Upper bound accepted for `wait_seconds`. */
const MAX_WAIT_SECONDS = 60;

const POWER_SIGNALS = ['start', 'stop', 'restart', 'kill'] as const;

/* -------------------------------------------------------------------------- */
/* Output schema                                                             */
/* -------------------------------------------------------------------------- */

const powerOutputShape = {
  ...mutationOutputShape,
  signal: z
    .enum(POWER_SIGNALS)
    .optional()
    .describe('The power signal that was sent. Present only on `status: "success"`.'),
  previous_state: z
    .string()
    .optional()
    .describe(
      'Daemon power state captured immediately before the signal was dispatched ' +
        '(offline/starting/running/stopping/unknown). Present only on `status: "success"`.',
    ),
  state_after: z
    .string()
    .optional()
    .describe(
      'Daemon power state after polling for `wait_seconds`. Only present when ' +
        '`wait_seconds` was greater than 0.',
    ),
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What each signal does and why, shown to the human in the preview. */
function noteFor(signal: PowerSignal): string {
  switch (signal) {
    case 'start':
      return 'Boots the server from offline. No players are connected while it is offline, so nothing is disconnected.';
    case 'stop':
      return 'Gracefully stops the server, saving the world first. Any connected players will be disconnected.';
    case 'restart':
      return 'Stops then starts the server again. Any connected players will be disconnected while it restarts.';
    case 'kill':
      return (
        'Hard-kills the process without saving. Unsaved world data may be lost or ' +
        'corrupted — prefer `stop` unless the server is hung and unresponsive to it.'
      );
  }
}

/**
 * Poll `getResources` every `POLL_INTERVAL_MS` until the reported state differs from
 * `previousState` or `waitSeconds` elapses, whichever comes first. A transient failure
 * fetching resources mid-poll is swallowed — the power signal itself already succeeded,
 * so a flaky status check should not turn that into a tool error.
 */
async function pollForStateChange(
  client: PteroClient,
  serverId: string,
  previousState: string,
  waitSeconds: number,
): Promise<string> {
  const deadlineMs = waitSeconds * 1000;
  let elapsedMs = 0;
  let state = previousState;

  while (elapsedMs < deadlineMs) {
    const step = Math.min(POLL_INTERVAL_MS, deadlineMs - elapsedMs);
    await sleep(step);
    elapsedMs += step;

    try {
      const response = await client.getResources(serverId);
      state = response.attributes.current_state;
    } catch {
      // Keep the last known state and keep polling; report whatever we have when time is up.
    }

    if (state !== previousState) break;
  }

  return state;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                              */
/* -------------------------------------------------------------------------- */

const POWER_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/** Phase 4: power and lifecycle. Registers `ptero_set_power_state`. */
export function registerPowerTools(ctx: ToolContext): void {
  const { server: mcp, client } = ctx;

  mcp.registerTool(
    'ptero_set_power_state',
    {
      title: 'Set Pterodactyl server power state',
      description:
        'Send a power signal to the server. `start` boots it from offline. `stop` gracefully ' +
        'shuts it down, saving the world first, and disconnects any connected players. ' +
        '`restart` stops then starts it again, briefly disconnecting players. `kill` forcibly ' +
        'terminates the process immediately, without saving.\n\n' +
        '`kill` is a hard stop and risks world corruption: prefer `stop` in almost every case, ' +
        'and reach for `kill` only when the server is hung and unresponsive to a normal stop. ' +
        '`kill` additionally refuses to run unless `PTERODACTYL_ALLOW_KILL=true` is set, and ' +
        'when it does proceed an automatic backup is taken first (the kill is aborted if that ' +
        'backup fails).\n\n' +
        '`stop`, `restart` and `kill` are destructive and require explicit human confirmation ' +
        'before they run — via MCP elicitation where the client supports it, otherwise a ' +
        'two-phase `confirmation_token`. On the first call (no token) nothing changes: you get ' +
        'back a preview of the current state and what the signal will do. THIS PREVIEW IS FOR ' +
        'THE HUMAN — show it in your reply and wait for their decision; do not silently call ' +
        'the tool again with the token yourself. Only call again, with the same arguments plus ' +
        '`confirmation_token`, once the human has approved it. `start` needs no confirmation.\n\n' +
        'Power actions are rate-limited to one per 30 seconds regardless of signal, to stop ' +
        'restart loops — a second power call inside that window is refused, naming how long to ' +
        'wait.\n\n' +
        'Set `wait_seconds` (0-60, default 0) to poll the live power state every 2 seconds ' +
        'after the signal is dispatched and report it back as `state_after`, instead of ' +
        'returning immediately with only the signal that was sent.',
      inputSchema: {
        server: serverIdSchema,
        signal: z
          .enum(POWER_SIGNALS)
          .describe(
            'Power signal to send. start = boot; stop = graceful shutdown (disconnects ' +
              'players); restart = stop then start (disconnects players); kill = hard-kill ' +
              'the process (risks world corruption — prefer stop).',
          ),
        dry_run: dryRunSchema,
        confirmation_token: confirmationTokenSchema,
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_SECONDS)
          .default(0)
          .describe(
            'After dispatching the signal, poll the power state every 2 seconds for up to ' +
              'this many seconds (0-60, default 0 = do not wait) and report the final state ' +
              'as `state_after`.',
          ),
      },
      outputSchema: powerOutputShape,
      annotations: POWER_ANNOTATIONS,
    },
    async ({ server, signal, dry_run, confirmation_token, wait_seconds }, extra) => {
      try {
        const id = resolveServer(ctx, server);

        // Capture the state before the guard runs, for the human-facing preview. A failed
        // read here is not fatal — the power action itself does not depend on it.
        let previousState = 'unknown';
        try {
          const resources = await client.getResources(id);
          previousState = resources.attributes.current_state;
        } catch {
          // fall through with 'unknown'
        }

        const preview = {
          signal,
          current_state: previousState,
          note: noteFor(signal),
        };

        const req: MutationRequest = {
          tool: 'ptero_set_power_state',
          server: id,
          args: { signal },
          kind: 'power',
          powerSignal: signal,
          dryRun: dry_run,
          ...(confirmation_token !== undefined ? { confirmationToken: confirmation_token } : {}),
          preview,
          destructive: signal !== 'start',
          wantsAutoBackup: signal === 'kill',
        };

        return await runMutation(
          ctx,
          req,
          extra,
          async () => {
            await client.setPower(id, signal);

            let stateAfter: string | undefined;
            if (wait_seconds > 0) {
              stateAfter = await pollForStateChange(client, id, previousState, wait_seconds);
            }

            return {
              signal,
              previous_state: previousState,
              ...(stateAfter !== undefined ? { state_after: stateAfter } : {}),
            };
          },
          (result) => {
            const base = `Sent \`${result.signal}\` to ${id} (was ${result.previous_state}).`;
            return result.state_after ? `${base} Now ${result.state_after}.` : base;
          },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
