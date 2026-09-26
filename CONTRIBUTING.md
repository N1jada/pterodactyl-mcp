# Contributing

Thanks for your interest in improving pterodactyl-mcp! Bug reports, fixes, new tools
and documentation improvements are all welcome.

## Getting set up

You need Node.js 22 or newer.

```bash
git clone https://github.com/N1jada/pterodactyl-mcp.git
cd pterodactyl-mcp
npm install
npm run build
npm test
```

The test suite needs no network and no real panel. For end-to-end checks there is an
in-memory mock panel (`test/mock-panel/server.mjs`) and a smoke script that drives every
tool through MCP Inspector against it (`scripts/inspector-smoke.sh`, needs `jq`).

## Before you open a pull request

- `npm run typecheck` and `npm test` pass.
- New behaviour has tests. Tests use a mocked `PteroClient` or the mock panel — never a
  live server.
- If you add or change a tool, update the tool tables in the README.
- Keep pull requests focused: one change per PR is much easier to review.

## Adding a tool

The README's [Adding a tool](README.md#adding-a-tool) section walks through it. The one
rule that matters most: **every mutating tool must go through `runMutation()`** in
`src/tools/_shared.ts`, so that the guard (read-only mode, protected paths, confirmation,
auto-backup, limits, audit log) applies. Never call a mutating Pterodactyl endpoint
outside the `execute` callback. `test/integration/guard-coverage.test.ts` checks this
structurally and will fail if a tool bypasses the guard.

## Safety changes

Changes that loosen a guardrail (a default, a limit, a refusal) need a clear rationale in
the PR description. The guardrails exist to protect people's game servers from a model
that is confidently wrong — err on the side of refusing.

## Testing against a real panel

`scripts/live-verify.mjs` and `scripts/live-verify-upload.mjs` exercise the mutating
tools against a real server configured in `.env`. They **modify that server** — only
ever point them at a throwaway test server, and never commit your `.env`.

## Reporting security issues

Please don't open a public issue for security problems — see [SECURITY.md](SECURITY.md).
