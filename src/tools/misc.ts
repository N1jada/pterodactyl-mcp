import { z } from 'zod';

import { fail, ok, resolveServer, serverIdSchema, type ToolContext } from './_shared.js';

/* -------------------------------------------------------------------------- */
/* Output schemas                                                             */
/* -------------------------------------------------------------------------- */

const scheduleTaskShape = {
  sequence_id: z.number(),
  action: z.enum(['command', 'power', 'backup']),
  payload: z.string(),
  time_offset: z.number().describe('Seconds to wait after the previous task before running this one.'),
  continue_on_failure: z.boolean(),
};

const scheduleShape = {
  id: z.number(),
  name: z.string(),
  cron: z
    .string()
    .describe('Standard 5-field cron string: "minute hour day_of_month month day_of_week".'),
  is_active: z.boolean(),
  is_processing: z.boolean().describe('True while this schedule is currently mid-run.'),
  only_when_online: z.boolean().describe('When true, the schedule skips its run if the server is offline.'),
  last_run_at: z.string().nullable(),
  next_run_at: z.string().nullable(),
  tasks: z.array(z.object(scheduleTaskShape)).describe('Ordered tasks this schedule executes on each run.'),
};

const listSchedulesOutputShape = {
  server: z.string(),
  schedules: z.array(z.object(scheduleShape)),
  count: z.number(),
};

const allocationShape = {
  id: z.number(),
  ip: z.string(),
  ip_alias: z.string().nullable(),
  port: z.number(),
  notes: z.string().nullable(),
  is_default: z.boolean().describe('True for the primary allocation players/clients connect to.'),
};

const listAllocationsOutputShape = {
  server: z.string(),
  allocations: z.array(z.object(allocationShape)),
  count: z.number(),
};

const eggVariableShape = {
  name: z.string(),
  env_variable: z.string(),
  description: z.string(),
  server_value: z.string().nullable(),
  default_value: z.string(),
  is_editable: z.boolean(),
  rules: z.string().describe('Laravel validation rule string for this variable, e.g. "required|string|max:20".'),
};

const startupOutputShape = {
  server: z.string(),
  startup_command: z.string().describe('The startup command with egg variable placeholders resolved.'),
  raw_startup_command: z.string().describe('The startup command template before placeholder substitution.'),
  docker_image: z.string().optional().describe('The container image currently in use, when the panel reports one.'),
  variables: z.array(z.object(eggVariableShape)).describe('User-viewable egg variables only; hidden ones never appear here.'),
};

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Phase 5 (part 2): schedules, allocations, startup — all read-only. */
export function registerMiscTools(ctx: ToolContext): void {
  const { server: mcp, client } = ctx;

  mcp.registerTool(
    'ptero_list_schedules',
    {
      title: 'List Pterodactyl schedules',
      description:
        "List a server's scheduled tasks (the panel's Schedules feature): cron timing, " +
        'whether each is active or currently running, whether it only fires while the server ' +
        'is online, last/next run time, and the ordered tasks each run executes ' +
        '(command/power/backup, with their payload and delay).\n\n' +
        'Use this to find out what automation is already configured — e.g. a nightly restart ' +
        'or an automatic backup — before assuming a state change was manual, or before adding ' +
        'a new schedule by hand through the panel to avoid a clash.\n\n' +
        'This is read-only: creating, editing, or deleting schedules is not exposed by this ' +
        'server. Use the panel UI for that.',
      inputSchema: { server: serverIdSchema },
      outputSchema: listSchedulesOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ server }) => {
      try {
        const id = resolveServer(ctx, server);
        const response = await client.listSchedules(id);
        const items = response.data ?? [];

        const schedules = items.map((item) => {
          const a = item.attributes;
          const c = a.cron;
          const tasks = (a.relationships?.tasks?.data ?? []).map((t) => {
            const ta = t.attributes;
            return {
              sequence_id: ta.sequence_id,
              action: ta.action,
              payload: ta.payload,
              time_offset: ta.time_offset,
              continue_on_failure: Boolean(ta.continue_on_failure),
            };
          });

          return {
            id: a.id,
            name: a.name,
            cron: `${c.minute} ${c.hour} ${c.day_of_month} ${c.month} ${c.day_of_week}`,
            is_active: Boolean(a.is_active),
            is_processing: Boolean(a.is_processing),
            only_when_online: Boolean(a.only_when_online),
            last_run_at: a.last_run_at ?? null,
            next_run_at: a.next_run_at ?? null,
            tasks,
          };
        });

        const structured = { server: id, schedules, count: schedules.length };

        const lines =
          schedules.length === 0
            ? ['No schedules are configured for this server.']
            : schedules.map(
                (s) =>
                  `- ${s.name} [${s.cron}]${s.is_active ? '' : ' (inactive)'}` +
                  `${s.is_processing ? ' (running now)' : ''}` +
                  `, ${s.tasks.length} task${s.tasks.length === 1 ? '' : 's'}` +
                  `, next run: ${s.next_run_at ?? 'unknown'}`,
              );

        return ok(structured, lines.join('\n'));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    'ptero_list_allocations',
    {
      title: 'List Pterodactyl network allocations',
      description:
        'List the network allocations (ip:port pairs) assigned to this server, and which one ' +
        'is the default/primary.\n\n' +
        'Use this to find out which port a particular service is meant to use — for example, ' +
        'which port Geyser/Bedrock should bind to — before checking whether it actually bound, ' +
        'which you confirm separately via the console log or `logs/latest.log` ' +
        '(ptero_read_file). A port being allocated here does not mean anything is actually ' +
        'listening on it.\n\n' +
        'This is read-only: adding, removing, or repointing allocations is not exposed by this ' +
        'server.',
      inputSchema: { server: serverIdSchema },
      outputSchema: listAllocationsOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ server }) => {
      try {
        const id = resolveServer(ctx, server);
        const response = await client.listAllocations(id);
        const items = response.data ?? [];

        const allocations = items.map((item) => {
          const a = item.attributes;
          return {
            id: a.id,
            ip: a.ip,
            ip_alias: a.ip_alias ?? null,
            port: a.port,
            notes: a.notes ?? null,
            is_default: Boolean(a.is_default),
          };
        });

        const structured = { server: id, allocations, count: allocations.length };

        const lines =
          allocations.length === 0
            ? ['No allocations are visible to this API key.']
            : allocations.map(
                (a) =>
                  `${a.ip}:${a.port}${a.is_default ? ' (default)' : ''}` +
                  `${a.ip_alias ? ` alias ${a.ip_alias}` : ''}` +
                  `${a.notes ? ` — ${a.notes}` : ''}`,
              );

        return ok(structured, lines.join('\n'));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    'ptero_get_startup_variables',
    {
      title: 'Get Pterodactyl startup command and egg variables',
      description:
        'Get the resolved startup command, the raw (unsubstituted) command template, the ' +
        "Docker image, and every user-viewable egg variable — name, env-var name, description, " +
        "current and default values, whether it's editable, and its validation rule string.\n\n" +
        'Use this to see how the server is configured to start — e.g. which jar file, memory ' +
        'flags, or Geyser toggle are set — before troubleshooting a boot failure or explaining ' +
        'current configuration.\n\n' +
        'Hidden (non-user-viewable) variables are never returned by the panel and so never ' +
        'appear here. This tool is read-only: it cannot change a variable, and this server does ' +
        'not currently expose a tool that does — that has to be done through the panel UI.',
      inputSchema: { server: serverIdSchema },
      outputSchema: startupOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ server }) => {
      try {
        const id = resolveServer(ctx, server);
        const response = await client.getStartup(id);
        const items = response.data ?? [];
        const meta = response.meta as
          | { startup_command?: string; raw_startup_command?: string; docker_images?: Record<string, string> }
          | undefined;

        const variables = items.map((item) => {
          const a = item.attributes;
          return {
            name: a.name,
            env_variable: a.env_variable,
            description: a.description,
            server_value: a.server_value ?? null,
            default_value: a.default_value,
            is_editable: Boolean(a.is_editable),
            rules: a.rules,
          };
        });

        const dockerImages = meta?.docker_images;
        const dockerImageValues = dockerImages ? Object.values(dockerImages) : [];
        // The endpoint reports the *available* images keyed by friendly name, not which one is
        // currently running. Only surface a value when there is exactly one candidate.
        const docker_image = dockerImageValues.length === 1 ? dockerImageValues[0] : undefined;

        const structured = {
          server: id,
          startup_command: meta?.startup_command ?? '',
          raw_startup_command: meta?.raw_startup_command ?? '',
          ...(docker_image !== undefined ? { docker_image } : {}),
          variables,
        };

        const lines = [
          `Startup: ${structured.startup_command || '(not reported)'}`,
          ...(structured.docker_image ? [`Image: ${structured.docker_image}`] : []),
          `${variables.length} variable${variables.length === 1 ? '' : 's'}:`,
          ...variables.map(
            (v) => `  ${v.env_variable} = ${v.server_value ?? v.default_value}${v.is_editable ? '' : ' (locked)'}`,
          ),
        ];

        return ok(structured, lines.join('\n'));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
