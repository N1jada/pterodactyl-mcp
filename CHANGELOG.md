# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-09-26

First public release.

### Added

- 20 MCP tools over the Pterodactyl Client API: servers and live resources, console
  (read and send), files (list, read, write, binary upload, rename, copy, delete), power,
  backups (list, create, delete, download URL), schedules, allocations and startup
  variables.
- Guard module applied to every mutating tool: read-only mode, allowed-servers list,
  delete and kill switches, protected paths with exceptions, mutation budget, bulk-delete
  cap and power cooldown.
- Human confirmation via MCP elicitation, with a single-use, argument-bound confirmation
  token fallback.
- Automatic backup before file writes, deletes and `kill`, aborting if the backup fails.
- Append-only JSONL audit log with secret redaction.
- In-memory mock panel and MCP Inspector smoke test.

[0.1.0]: https://github.com/N1jada/pterodactyl-mcp/releases/tag/v0.1.0
