#!/usr/bin/env node
/**
 * pterodactyl-mcp — entrypoint.
 *
 * stdout is the MCP transport. Never write anything else to it; diagnostics go to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { AuditLog } from './audit.js';
import { createBackupAndWait } from './backupWait.js';
import { PteroClient } from './client.js';
import { Confirmation } from './confirm.js';
import { loadConfig } from './config.js';
import { Guard } from './guard.js';
import type { ToolContext } from './tools/_shared.js';
import { registerServerTools } from './tools/servers.js';
import { registerConsoleTools } from './tools/console.js';
import { registerFileTools } from './tools/files.js';
import { registerPowerTools } from './tools/power.js';
import { registerBackupTools } from './tools/backups.js';
import { registerMiscTools } from './tools/misc.js';

export function buildServer(env: Record<string, string | undefined> = process.env): {
  server: McpServer;
  ctx: ToolContext;
} {
  const config = loadConfig(env);
  const server = new McpServer(
    { name: 'pterodactyl-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Tools for inspecting and operating a Pterodactyl-hosted game server. ' +
        'Read-only tools are safe to call freely. Mutating tools are guarded: they may return ' +
        'status "needs_confirmation" with a preview and a confirmation_token — show the preview ' +
        'to the human and only call again with the token if they agree. Prefer "stop" over "kill". ' +
        'Take a backup (ptero_create_backup) before risky changes. Console history is limited; ' +
        'for boot-time output read logs/latest.log with ptero_read_file.',
    },
  );

  const client = new PteroClient({ panelUrl: config.panelUrl, apiKey: config.apiKey });
  // Value-scrub the API key out of every audit line, on top of key-name redaction.
  const audit = new AuditLog(config.auditLog, { secrets: [config.apiKey] });
  const confirm = new Confirmation({ server });
  const guard = new Guard({
    config,
    audit,
    confirm,
    // Layer 3: the backup must actually COMPLETE before the destructive change runs.
    // createBackupAndWait throws on failure or timeout, which makes the guard abort.
    createBackup: async (serverId, name) => {
      const backup = await createBackupAndWait(client, serverId, { name });
      return { uuid: backup.uuid };
    },
  });

  const ctx: ToolContext = { server, client, guard, config, audit };
  registerServerTools(ctx);
  registerConsoleTools(ctx);
  registerFileTools(ctx);
  registerPowerTools(ctx);
  registerBackupTools(ctx);
  registerMiscTools(ctx);
  return { server, ctx };
}

async function main(): Promise<void> {
  const { server, ctx } = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = ctx.config.readOnly ? 'READ-ONLY' : 'read-write';
  console.error(
    `[pterodactyl-mcp] connected (${mode}, panel ${ctx.config.panelUrl}, default server ${ctx.config.defaultServer ?? 'none'})`,
  );
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun || process.argv[1]?.endsWith('dist/index.js')) {
  main().catch((err: unknown) => {
    console.error(`[pterodactyl-mcp] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
