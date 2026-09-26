import { z } from 'zod';

import type { ServerAttributes, AllocationAttributes } from '../types.js';
import {
  bytesToHuman,
  fail,
  formatUptime,
  ok,
  resolveServer,
  serverIdSchema,
  type ToolContext,
} from './_shared.js';

/* -------------------------------------------------------------------------- */
/* Output schemas                                                             */
/* -------------------------------------------------------------------------- */

const allocationShape = {
  id: z.number().describe('Panel allocation ID.'),
  ip: z.string().describe('IP address the server listens on.'),
  ip_alias: z.string().nullable().describe('Friendly hostname for the IP, if the node sets one.'),
  port: z.number().describe('Port number.'),
  is_default: z.boolean().describe('True for the primary allocation players connect to.'),
  notes: z.string().nullable().describe('Operator notes, e.g. which service uses this port.'),
};

const listServersOutputShape = {
  servers: z
    .array(
      z.object({
        identifier: z.string().describe('Short identifier to pass as `server` to other tools.'),
        uuid: z.string().describe('Full server UUID.'),
        name: z.string(),
        node: z.string().describe('Name of the node hosting the server.'),
        description: z.string().nullable(),
        status: z
          .string()
          .nullable()
          .describe('null when normal; otherwise installing/suspended/restoring_backup etc.'),
        is_suspended: z.boolean(),
        is_installing: z.boolean(),
        primary_allocation: z
          .string()
          .nullable()
          .describe('`ip:port` of the default allocation, when visible to this API key.'),
        memory_limit_mb: z.number().describe('Memory limit in MiB. 0 means unlimited.'),
        disk_limit_mb: z.number().describe('Disk limit in MiB. 0 means unlimited.'),
      }),
    )
    .describe('Servers this API key can access, for the requested page.'),
  count: z.number().describe('Number of servers on this page.'),
  total: z.number().optional().describe('Total servers across all pages, when the panel reports it.'),
  page: z.number().optional().describe('Current page number.'),
  total_pages: z.number().optional().describe('Total number of pages.'),
  has_more: z.boolean().describe('True when further pages exist; request them with `page`.'),
};

const getServerOutputShape = {
  identifier: z.string(),
  uuid: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  node: z.string().describe('Name of the node hosting the server.'),
  status: z
    .string()
    .nullable()
    .describe(
      'Panel lifecycle status: null when normal, else installing/install_failed/' +
        'reinstall_failed/suspended/restoring_backup. This is NOT the power state — ' +
        'use ptero_get_server_resources for running/offline.',
    ),
  is_suspended: z.boolean().describe('Suspended servers reject power and console actions.'),
  is_installing: z.boolean(),
  is_transferring: z.boolean().describe('True while the server is being moved between nodes.'),
  is_node_under_maintenance: z.boolean().optional(),
  limits: z
    .object({
      memory: z.number().describe('MiB; 0 = unlimited.'),
      swap: z.number().describe('MiB; 0 = disabled, -1 = unlimited.'),
      disk: z.number().describe('MiB; 0 = unlimited.'),
      io: z.number().describe('Block IO weight, 10-1000.'),
      cpu: z.number().describe('Percent of a single core; 100 = one full core, 0 = unlimited.'),
      threads: z.string().nullable().optional().describe('Pinned CPU threads, if set.'),
      oom_disabled: z.boolean().optional(),
    })
    .describe('Resource ceilings configured on the panel.'),
  feature_limits: z.object({
    databases: z.number(),
    allocations: z.number(),
    backups: z.number().describe('Maximum simultaneous backups. 0 disables backups entirely.'),
  }),
  allocations: z.array(z.object(allocationShape)).describe('Ports assigned to this server.'),
  sftp_details: z.object({
    ip: z.string(),
    port: z.number(),
  }),
  docker_image: z.string().describe('Container image the server runs in.'),
  invocation: z
    .string()
    .describe('Resolved startup command. Redacted by the panel without startup:read permission.'),
  egg_features: z.array(z.string()).nullable().optional(),
  server_owner: z.boolean().optional().describe('True when the API key owns the server rather than being a subuser.'),
};

const getResourcesOutputShape = {
  server: z.string().describe('Server short identifier these figures describe.'),
  current_state: z
    .string()
    .describe('Daemon power state: offline, starting, running, or stopping.'),
  is_suspended: z.boolean(),
  memory_bytes: z.number(),
  memory_human: z.string(),
  cpu_absolute: z
    .number()
    .describe('CPU percent across all cores: 100 = one full core, 200 = two cores.'),
  disk_bytes: z.number(),
  disk_human: z.string(),
  network_rx_bytes: z.number(),
  network_rx_human: z.string(),
  network_tx_bytes: z.number(),
  network_tx_human: z.string(),
  uptime_ms: z.number().describe('Milliseconds since the process started. 0 when offline.'),
  uptime_human: z.string(),
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

/** Phase 1: the read-only core. Registers the three server-inspection tools. */
export function registerServerTools(ctx: ToolContext): void {
  const { server: mcp, client } = ctx;

  mcp.registerTool(
    'ptero_list_servers',
    {
      title: 'List Pterodactyl servers',
      description:
        'List the game servers this Pterodactyl API key can access, with their short ' +
        'identifiers, node, primary allocation and resource limits.\n\n' +
        'Use this first when you do not already know a server identifier, or when a call ' +
        'fails with "not found" — every other ptero_* tool takes that identifier as its ' +
        '`server` argument.\n\n' +
        'This does NOT report whether a server is running: `status` here is the panel ' +
        'lifecycle field (installing/suspended/etc.) and is null for a normal server ' +
        'whether it is up or down. Call ptero_get_server_resources for the live power state.\n\n' +
        'Results are paginated by the panel (50 per page). Pass `page` to fetch further pages; ' +
        '`has_more` tells you whether any remain.',
      inputSchema: {
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('1-based page number. Omit for the first page.'),
      },
      outputSchema: listServersOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ page }) => {
      try {
        const response = await client.listServers(page);
        const items = response.data ?? [];

        const servers = items.map((item) => {
          const a = item.attributes;
          const primary = findPrimaryAllocation(a);
          return {
            identifier: a.identifier,
            uuid: a.uuid,
            name: a.name,
            node: a.node,
            description: a.description ?? null,
            status: a.status ?? null,
            is_suspended: Boolean(a.is_suspended),
            is_installing: Boolean(a.is_installing),
            primary_allocation: primary ? `${primary.ip}:${primary.port}` : null,
            memory_limit_mb: a.limits?.memory ?? 0,
            disk_limit_mb: a.limits?.disk ?? 0,
          };
        });

        const pagination = response.meta?.pagination;
        const currentPage = pagination?.current_page ?? page ?? 1;
        const totalPages = pagination?.total_pages;
        const structured = {
          servers,
          count: servers.length,
          ...(pagination?.total !== undefined ? { total: pagination.total } : {}),
          page: currentPage,
          ...(totalPages !== undefined ? { total_pages: totalPages } : {}),
          has_more: totalPages !== undefined ? currentPage < totalPages : false,
        };

        const lines =
          servers.length === 0
            ? ['No servers are visible to this API key.']
            : servers.map(
                (s) =>
                  `- ${s.identifier}  ${s.name} (node ${s.node}` +
                  `${s.primary_allocation ? `, ${s.primary_allocation}` : ''})` +
                  `${s.status ? ` [${s.status}]` : ''}` +
                  `${s.is_suspended ? ' [suspended]' : ''}`,
              );

        const header =
          servers.length === 0
            ? ''
            : `${servers.length} server${servers.length === 1 ? '' : 's'}` +
              `${structured.total !== undefined ? ` of ${structured.total}` : ''}` +
              `${structured.has_more ? ` (page ${currentPage} of ${totalPages}; more pages available)` : ''}:\n`;

        return ok(structured, `${header}${lines.join('\n')}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    'ptero_get_server',
    {
      title: 'Get Pterodactyl server details',
      description:
        'Get the full configuration of one server: name, node, panel lifecycle status, ' +
        'resource limits, feature limits, every network allocation (ip/port/notes, and ' +
        'which is primary), SFTP host and port, Docker image and the resolved startup ' +
        'command.\n\n' +
        'Use this to answer "how is this server configured", "what ports does it have", ' +
        '"how much memory is it allowed", or "what is it running".\n\n' +
        'This is static configuration. It does NOT tell you whether the server is up or ' +
        'what it is currently consuming — use ptero_get_server_resources for that. For ' +
        'the ports alone, ptero_list_allocations is narrower. Note that a port being ' +
        'allocated does not mean a service actually bound to it; confirm that in the ' +
        'console log or the relevant plugin config file.',
      inputSchema: { server: serverIdSchema },
      outputSchema: getServerOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ server }) => {
      try {
        const id = resolveServer(ctx, server);
        const response = await client.getServer(id);
        const a = response.attributes;

        const allocations = (a.relationships?.allocations?.data ?? []).map((item) => ({
          id: item.attributes.id,
          ip: item.attributes.ip,
          ip_alias: item.attributes.ip_alias ?? null,
          port: item.attributes.port,
          is_default: Boolean(item.attributes.is_default),
          notes: item.attributes.notes ?? null,
        }));

        const structured = {
          identifier: a.identifier,
          uuid: a.uuid,
          name: a.name,
          description: a.description ?? null,
          node: a.node,
          status: a.status ?? null,
          is_suspended: Boolean(a.is_suspended),
          is_installing: Boolean(a.is_installing),
          is_transferring: Boolean(a.is_transferring),
          ...(a.is_node_under_maintenance !== undefined
            ? { is_node_under_maintenance: Boolean(a.is_node_under_maintenance) }
            : {}),
          limits: {
            memory: a.limits?.memory ?? 0,
            swap: a.limits?.swap ?? 0,
            disk: a.limits?.disk ?? 0,
            io: a.limits?.io ?? 0,
            cpu: a.limits?.cpu ?? 0,
            threads: a.limits?.threads ?? null,
            ...(a.limits?.oom_disabled !== undefined
              ? { oom_disabled: Boolean(a.limits.oom_disabled) }
              : {}),
          },
          feature_limits: {
            databases: a.feature_limits?.databases ?? 0,
            allocations: a.feature_limits?.allocations ?? 0,
            backups: a.feature_limits?.backups ?? 0,
          },
          allocations,
          sftp_details: {
            ip: a.sftp_details?.ip ?? '',
            port: a.sftp_details?.port ?? 0,
          },
          docker_image: a.docker_image,
          invocation: a.invocation,
          egg_features: a.egg_features ?? null,
          ...(a.server_owner !== undefined ? { server_owner: Boolean(a.server_owner) } : {}),
        };

        const flags = [
          a.is_suspended ? 'suspended' : null,
          a.is_installing ? 'installing' : null,
          a.is_transferring ? 'transferring' : null,
          a.status ?? null,
        ].filter((f): f is string => f !== null);

        const allocationLines =
          allocations.length === 0
            ? ['  (none visible to this API key)']
            : allocations.map(
                (al) =>
                  `  ${al.ip}:${al.port}${al.is_default ? ' (primary)' : ''}` +
                  `${al.ip_alias ? ` alias ${al.ip_alias}` : ''}` +
                  `${al.notes ? ` — ${al.notes}` : ''}`,
              );

        const text = [
          `${a.name} (${a.identifier}) on node ${a.node}${flags.length ? ` [${flags.join(', ')}]` : ''}`,
          a.description ? `Description: ${a.description}` : null,
          `Limits: ${structured.limits.memory} MiB memory, ${structured.limits.disk} MiB disk, ` +
            `${structured.limits.cpu}% CPU, swap ${structured.limits.swap} MiB, io ${structured.limits.io}`,
          `Feature limits: ${structured.feature_limits.backups} backups, ` +
            `${structured.feature_limits.databases} databases, ${structured.feature_limits.allocations} allocations`,
          'Allocations:',
          ...allocationLines,
          `SFTP: ${structured.sftp_details.ip}:${structured.sftp_details.port}`,
          `Image: ${a.docker_image}`,
          `Invocation: ${a.invocation}`,
          `UUID: ${a.uuid}`,
        ]
          .filter((line): line is string => line !== null)
          .join('\n');

        return ok(structured, text);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    'ptero_get_server_resources',
    {
      title: 'Get Pterodactyl server resource usage',
      description:
        'Get the live power state and current resource usage of a server: whether it is ' +
        'running, memory and disk in use, CPU percentage, network bytes in and out, and ' +
        'process uptime.\n\n' +
        'Use this to answer "is the server up?", "what is the memory doing?" or "how long ' +
        'has it been up?". This is the tool that reports running vs offline — ' +
        'ptero_get_server reports panel lifecycle status, which is a different thing.\n\n' +
        'Figures are cached by the panel for about 20 seconds, so calling repeatedly in ' +
        'quick succession returns identical numbers; that is the cache, not a frozen ' +
        'server. `cpu_absolute` is a percentage across all cores (200 means two full ' +
        'cores), and compares against the `limits.cpu` from ptero_get_server. When the ' +
        'server is offline every figure is 0. This tool does not explain *why* something ' +
        'is wrong — use ptero_get_console_log for that.',
      inputSchema: { server: serverIdSchema },
      outputSchema: getResourcesOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ server }) => {
      try {
        const id = resolveServer(ctx, server);
        const response = await client.getResources(id);
        const a = response.attributes;
        const r = a.resources;

        const structured = {
          server: id,
          current_state: a.current_state,
          is_suspended: Boolean(a.is_suspended),
          memory_bytes: r?.memory_bytes ?? 0,
          memory_human: bytesToHuman(r?.memory_bytes ?? 0),
          cpu_absolute: r?.cpu_absolute ?? 0,
          disk_bytes: r?.disk_bytes ?? 0,
          disk_human: bytesToHuman(r?.disk_bytes ?? 0),
          network_rx_bytes: r?.network_rx_bytes ?? 0,
          network_rx_human: bytesToHuman(r?.network_rx_bytes ?? 0),
          network_tx_bytes: r?.network_tx_bytes ?? 0,
          network_tx_human: bytesToHuman(r?.network_tx_bytes ?? 0),
          uptime_ms: r?.uptime ?? 0,
          uptime_human: formatUptime(r?.uptime ?? 0),
        };

        const text = [
          `${id} is ${structured.current_state}${structured.is_suspended ? ' (SUSPENDED)' : ''}.`,
          `Memory: ${structured.memory_human} | CPU: ${structured.cpu_absolute.toFixed(2)}% | Disk: ${structured.disk_human}`,
          `Network: ${structured.network_rx_human} in / ${structured.network_tx_human} out`,
          `Uptime: ${structured.uptime_human}`,
        ].join('\n');

        return ok(structured, text);
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/**
 * The panel includes allocations on the server list by default, but a key without
 * `allocation.read` gets only the primary one (with notes nulled). Fall back to the
 * first allocation when none is flagged default.
 */
function findPrimaryAllocation(a: ServerAttributes): AllocationAttributes | undefined {
  const items = a.relationships?.allocations?.data ?? [];
  const primary = items.find((item) => item.attributes.is_default);
  return (primary ?? items[0])?.attributes;
}
