# MCP TypeScript Server — Implementation Reference

Compiled 2026-09-05 from primary sources (URLs cited per section). Written so you can
implement a stdio MCP server without re-fetching anything. Where a fact could not be
verified from a primary source it is flagged **[UNVERIFIED]**.

## 0. Critical version decision — read first

The TypeScript SDK has **two incompatible major lines** right now:

| Line | Package(s) | Status | Spec version | Notes |
|---|---|---|---|---|
| **v1.x (recommended)** | `@modelcontextprotocol/sdk` | Maintained, bug/security fixes for ≥6 months post-v2 | up to 2025-11-25 | `McpServer`, `registerTool`, `server.server.elicitInput()` — the API this doc uses below |
| v2 (new, do not use yet) | `@modelcontextprotocol/server` + `@modelcontextprotocol/client` | New stable line as of the 2026-07-28 spec | 2026-07-28 | New package names, `ctx.mcpReq.elicitInput()`, elicitation is now a multi-round-trip `InputRequiredResult` returned from the tool handler (not a simple awaited call in older client's eyes), requires clients that understand the new wire format |

**Recommendation: pin `@modelcontextprotocol/sdk` at exact version `1.30.0`.** v2 shipped
alongside a breaking spec revision (2026-07-28) that changes the tool-call wire format
itself (`resultType`, `InputRequiredResult`, mandatory `_meta` blocks); current MCP hosts'
support for that wire format was not verified at research time, whereas v1.x is what
virtually every existing host supports today. v1.x already backports URL-mode elicitation
(from 2025-11-25) via the same simple imperative `elicitInput()` call shown in §2.

Sources: `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md`,
npm registry (`@modelcontextprotocol/sdk` dist-tag `latest` = `1.30.0`;
`@modelcontextprotocol/server` dist-tag `latest` = `2.0.0`, checked live via npm registry API),
`https://ts.sdk.modelcontextprotocol.io/v2/servers/elicitation.html`,
`https://ts.sdk.modelcontextprotocol.io/capabilities.html` (v1 docs).

## 1. Packages, package.json, tsconfig.json

```bash
npm install @modelcontextprotocol/sdk@1.30.0 zod@^3.25
npm install -D typescript @types/node tsx
```

`zod` requirement per the SDK's own `package.json`: `"zod": "^3.25 || ^4.0"` — either
major works; examples below use plain `zod` (v3-style) imports since that's what the
SDK's own docs and the mcp-builder skill use for v1.x.

### package.json (ESM, Node 22, `bin` entry)

```json
{
  "name": "minecraft-mcp-server",
  "version": "0.1.0",
  "description": "MCP server for Minecraft integration",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "minecraft-mcp-server": "dist/index.js"
  },
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  }
}
```

`dist/index.js` must start with a shebang line for the `bin` entry to be directly
executable, and must be `chmod +x` after build (or set via a `postbuild` script):

```typescript
#!/usr/bin/env node
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Source: `reference/node_mcp_server.md` in the mcp-builder skill (adjusted `module`/`target`
to `NodeNext`/Node 22; the skill's own example used `Node16`/ES2022, functionally
equivalent for a pure-ESM Node 22 project).

**stdio rule:** never write to `stdout` — it is the JSON-RPC channel. All logging goes to
`stderr` (`console.error`). Source: `reference/mcp_best_practices.md`.

## 2. Minimal complete server skeleton (one tool)

```typescript
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'minecraft-mcp-server',
  version: '0.1.0'
});

const GetPlayerInputSchema = z.object({
  playerName: z.string().min(1).max(16).describe('Minecraft player username')
}).strict();

const GetPlayerOutputSchema = z.object({
  playerName: z.string(),
  online: z.boolean(),
  position: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional()
});

server.registerTool(
  'get_player_status',
  {
    title: 'Get Player Status',
    description: 'Look up whether a Minecraft player is online and their current position.',
    inputSchema: GetPlayerInputSchema.shape,   // registerTool wants a raw Zod shape (or a Zod object)
    outputSchema: GetPlayerOutputSchema.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async ({ playerName }) => {
    try {
      const status = await lookupPlayer(playerName); // your implementation
      const output = { playerName, online: status.online, position: status.position };
      return {
        // structuredContent SHOULD be mirrored as serialized JSON text too (spec rule, §4)
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      };
    }
  }
);

async function lookupPlayer(name: string) {
  // ... real implementation ...
  return { online: true, position: { x: 0, y: 64, z: 0 } };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('minecraft-mcp-server running on stdio');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

Notes verified against the SDK v1.x source (`src/server/mcp.ts`, `registerTool` config
type): `inputSchema`/`outputSchema` accept either a raw Zod shape object
(`{ field: z.string() }` / `MySchema.shape`) or a full schema object — both compile.
`annotations` is a plain object of the four boolean hints (see §4). Returning
`isError: true` alongside a `content` array is the exact tool-execution-error shape
(`src/server/mcp.ts`; matches spec, §4). Sources: `reference/node_mcp_server.md`,
v1.x SDK source at `github.com/modelcontextprotocol/typescript-sdk` (`v1.x` branch,
`src/server/mcp.ts`, `src/server/index.ts`).

## 3. Elicitation from inside a tool handler (v1.x API)

The **low-level `Server`** (accessible as `server.server` on an `McpServer`) exposes
`elicitInput()` and `getClientCapabilities()`. Confirmed verbatim from
`src/server/index.ts` on the `v1.x` branch of `modelcontextprotocol/typescript-sdk`:

```typescript
class Server {
  getClientCapabilities(): ClientCapabilities | undefined; // populated after initialize
  async elicitInput(
    params: ElicitRequestFormParams | ElicitRequestURLParams,
    options?: RequestOptions
  ): Promise<ElicitResult>;
  createElicitationCompletionNotifier(elicitationId: string, options?: NotificationOptions): () => Promise<void>;
}
```

`elicitInput` throws `Error('Client does not support form elicitation.')` /
`'... url elicitation.'` itself if the connected client never declared that capability
mode — an explicit pre-check is optional but recommended so you can degrade gracefully
instead of throwing out of the handler.

```typescript
server.registerTool(
  'teleport_player_confirm',
  {
    title: 'Teleport Player (with confirmation)',
    description: 'Ask the user to confirm before teleporting a player to new coordinates.',
    inputSchema: z.object({
      playerName: z.string(),
      x: z.number(), y: z.number(), z: z.number()
    }).shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  },
  async ({ playerName, x, y, z }) => {
    // Capability check — client must have declared elicitation.form during initialize
    const caps = server.server.getClientCapabilities();
    if (!caps?.elicitation?.form) {
      return {
        content: [{ type: 'text', text: 'Client does not support elicitation; cannot confirm teleport.' }],
        isError: true
      };
    }

    const result = await server.server.elicitInput({
      mode: 'form', // optional for form mode, defaults to 'form' if omitted
      message: `Teleport ${playerName} to (${x}, ${y}, ${z})?`,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', title: 'Yes, teleport' }
        },
        required: ['confirm']
      }
    });

    switch (result.action) {
      case 'accept':
        if (result.content?.confirm !== true) {
          return { content: [{ type: 'text', text: 'Confirmation box left unchecked — nothing done.' }] };
        }
        await doTeleport(playerName, x, y, z); // your implementation
        return { content: [{ type: 'text', text: `Teleported ${playerName} to (${x}, ${y}, ${z}).` }] };
      case 'decline':
        return { content: [{ type: 'text', text: 'User declined the teleport.' }] };
      case 'cancel':
      default:
        return { content: [{ type: 'text', text: 'User dismissed the confirmation dialog.' }] };
    }
  }
);
```

**Declaring your own server's capabilities**: `McpServer` auto-derives `capabilities.tools`
etc. from what you register — you don't hand-declare `tools` yourself. Elicitation is a
*client* capability the server merely calls into (see the check above), not something the
server declares.

**Never elicit credentials/PII via form mode** — see spec rule in §4. Use URL mode
(`mode: 'url'`, pass `url` + `elicitationId` instead of `requestedSchema`) for anything
sensitive; `server.server.createElicitationCompletionNotifier(elicitationId)` sends
`notifications/elicitation/complete` once an out-of-band (e.g. OAuth) flow finishes.

Sources: `https://ts.sdk.modelcontextprotocol.io/capabilities.html` (v1 docs, "Elicitation"
section), v1.x SDK source `src/server/index.ts` (`elicitInput`, `getClientCapabilities`,
`createElicitationCompletionNotifier` — read directly from
`raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/src/server/index.ts`).

## 4. Spec facts (protocol 2025-06-18; latest is 2026-07-28 — see §0)

Per `https://modelcontextprotocol.io/sitemap.xml` the published spec revisions are
`2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`, `2026-07-28` (latest). The task
sources specify `2025-06-18`; facts below are drawn from that revision except where noted,
because that's the revision the recommended v1.x SDK line targets most solidly.

### Tool annotations (`server/tools.md`, `schema.md`)
All four are **hints only** — "clients **MUST** consider tool annotations to be untrusted
unless they come from trusted servers" and they must never be used for security decisions.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `readOnlyHint` | boolean | `false` | tool does not modify its environment |
| `destructiveHint` | boolean | `true` | may perform destructive updates (meaningful only if `readOnlyHint == false`) |
| `idempotentHint` | boolean | `false` | repeat calls with same args have no additional effect (meaningful only if `readOnlyHint == false`) |
| `openWorldHint` | boolean | `true` | tool interacts with an open-ended external world (e.g. web search) vs. a closed domain (e.g. local memory) |

Defaults confirmed identically in the spec's TypeDoc schema page and the SDK's own
`ToolAnnotationsSchema` doc-comments (`src/types.ts`).

### structuredContent / outputSchema (`server/tools.md`)
- `outputSchema` is optional JSON Schema for the tool's structured result.
- If declared, the server **MUST** produce `structuredContent` conforming to it; clients
  **SHOULD** validate against it.
- **"For backwards compatibility, a tool that returns structured content SHOULD also
  return the serialized JSON in a TextContent block."** — i.e. mirror `structuredContent`
  as `JSON.stringify(...)` inside `content[0].text` (as done in §2's skeleton).
- `structuredContent` can be any JSON value (object, array, string, number, boolean,
  null), not only objects.

### Tool result errors (`server/tools.md`)
Two distinct mechanisms:
1. **Protocol errors** — malformed request / unknown tool — returned as JSON-RPC
   `error` objects (e.g. code `-32602`). Less likely for a model to self-correct from.
2. **Tool execution errors** — API failures, validation errors, business logic — returned
   as a normal tool **result** with `isError: true` and an explanatory `content` block.
   Clients **SHOULD** surface these to the model so it can retry with adjusted input.

### Elicitation (`client/elicitation.md`, 2025-06-18)
- Request method: `elicitation/create`, with `message` (human-readable reason) and
  `requestedSchema`.
- **`requestedSchema` restriction: flat objects of primitive properties only** — string,
  number/integer, boolean, and enum (single- or multi-select) fields. No nested objects,
  no arrays-of-objects, no `$ref`. Supported string `format`s: `email`, `uri`, `date`,
  `date-time`. Fields may carry `default`.
- Response shape: `{ "action": "accept" | "decline" | "cancel", "content"?: {...} }`.
  `content` is populated only on `accept`, and only for form mode.
  - **accept**: user submitted the form — `content` has the schema-matching data.
  - **decline**: user explicitly rejected the request — no data.
  - **cancel**: user dismissed without an explicit choice (closed dialog, pressed Escape) — no data.
- **"Servers MUST NOT use elicitation to request sensitive information"** — no passwords,
  API keys, tokens, or payment credentials via elicitation forms, ever (2025-06-18 has no
  escape hatch for this; the later 2025-11-25 revision adds a URL mode specifically so
  sensitive interactions can happen out-of-band in a browser instead of via form fields —
  the v1.x SDK backports this URL mode, see §3).
- Clients **MUST** allow the user to review/modify a form response before submitting, and
  must always provide a way to decline/cancel.

Sources: `https://modelcontextprotocol.io/specification/2025-06-18/server/tools.md`,
`https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation.md`,
`https://modelcontextprotocol.io/specification/2025-06-18/schema.md` (annotation
defaults), `https://modelcontextprotocol.io/sitemap.xml`.

## 5. mcp-builder skill guidance (Anthropic `skills` repo, `skills/mcp-builder/`)

Source: `raw.githubusercontent.com/anthropics/skills/main/skills/mcp-builder/SKILL.md`
+ `reference/mcp_best_practices.md` + `reference/node_mcp_server.md`.

- **Naming**: server package `{service}-mcp-server` (lowercase-hyphen, no version in
  name); tools `snake_case`, prefixed with the service: `slack_send_message`,
  `github_create_issue`, not bare `send_message`.
- **API coverage vs. workflow tools**: default to broad API coverage (flexibility to
  compose calls) over bespoke high-level workflow tools, unless the target client
  benefits from the latter.
- **Descriptions**: must be explicit — SDK does **not** auto-extract JSDoc. Include args,
  return schema, "Use when... / Don't use when..." examples, and error-condition text
  directly in the `description` string (worked example in `reference/node_mcp_server.md`).
- **Response format**: support both human `markdown` and machine `json`
  `response_format` params for non-trivial data; always also set `structuredContent`.
- **Pagination**: respect `limit`, return `has_more`/`next_offset`/`total_count`, default
  page size 20–50, never load unbounded result sets.
- **Character limit**: cap response size (skill convention: `CHARACTER_LIMIT = 25000`),
  truncate and say so explicitly if exceeded.
- **Annotations**: always set all four hints explicitly (§4 table) — don't rely on defaults.
- **Zod**: `.strict()` on input schemas to reject unknown fields; `.describe()` every
  field; derive the TS type via `z.infer<typeof Schema>`.
- **Quality gate**: `npm run build` succeeds, produces `dist/index.js`, tools tested with
  `npx @modelcontextprotocol/inspector`.
- **Four-phase workflow**: research → implement → review/build/test → evaluations (§6).

## 6. Evaluation XML format (verbatim, from `reference/evaluation.md`)

After building the server, hand-write ~10 read-only, independent, realistic,
single-verifiable-answer questions that exercise the tools, verify each answer yourself,
then save them in this exact structure:

```xml
<evaluation>
   <qa_pair>
      <question>Find the project created in Q2 2024 with the highest number of completed tasks. What is the project name?</question>
      <answer>Website Redesign</answer>
   </qa_pair>
   <qa_pair>
      <question>Search for issues labeled as "bug" that were closed in March 2024. Which user closed the most issues? Provide their username.</question>
      <answer>sarah_dev</answer>
   </qa_pair>
</evaluation>
```

Requirements (from the same file):
- Questions must be **independent**, **read-only/non-destructive**, **complex** (may take
  dozens of tool calls), **realistic**, and must not be solvable by naive keyword search.
- Answers must be a **single verifiable value** checkable by **direct string comparison**
  — never a list or a complex structure — and must be **stable** (based on closed/historical
  data, not a live count that will drift, e.g. never "how many open issues exist now").
- Prefer human-readable answers (names, usernames, dates, titles) over opaque IDs; specify
  the exact expected format in the question itself if ambiguity is possible (e.g. "Use
  YYYY/MM/DD.").
- Optional harness: `python scripts/evaluation.py -t stdio -c node -a dist/index.js
  evaluation.xml` (script ships in the skill; requires `pip install anthropic mcp` and
  `ANTHROPIC_API_KEY`) — reports accuracy, tool-call counts, and per-question pass/fail.

## 7. Unverified / flagged items

- Whether current production MCP hosts (Claude Desktop, Claude Code CLI, etc.) fully
  support the 2026-07-28 spec / v2 SDK's `InputRequiredResult` elicitation flow — **not
  verified**; this is the basis for recommending v1.x in §0.
- zod pin: SDK 1.30.0 accepts `^3.25 || ^4.0`; this doc pins `^3.25` to match the
  mcp-builder skill's v3-style syntax (`z.string()`, not the `zod/v4` namespace import)
  — either major works.
- `openWorldHint` wasn't restated in the 2026-07-28 `server/tools.md` prose (unlike
  2025-06-18); it's still present in the current `schema.md` TypeDoc and v1.x SDK types,
  so treated as unchanged, but the omission itself wasn't explained in sources reviewed.
