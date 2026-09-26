# Prompt templates

Ready-to-paste prompts for common jobs. Copy one, fill in the `[BRACKETED]` parts, and send
it to Claude with pterodactyl-mcp connected.

---

## Server activity report — "What happened this day / week / month?"

Produces a one-page visual report (a Claude **artifact**) covering server health, uptime
and restarts, crashes, player activity, errors and lag, backups, scheduled tasks and
recent file changes over a period you choose.

**What you need**

- **Claude Desktop** with pterodactyl-mcp registered (see
  [Claude Desktop](../README.md#claude-desktop)) and artifacts turned on. Claude on the
  web can't launch local MCP servers like this one.
- The **read-only profile** is enough. The prompt only reads, and tells Claude not to
  change anything.
- In **Claude Code** the same prompt works. Ask for an HTML file instead of an artifact,
  and Claude can also read your local audit log (see the optional line in the template).

### The template

Replace `[PERIOD]` with something like `today`, `yesterday`, `the last 7 days`,
`September 2026` or `since Monday`, and `[SERVER]` with your server's short ID (or delete
that line to use your default server).

```text
Create an activity report for my game server covering [PERIOD], as an artifact.

Server: [SERVER]

RULES
- Read-only: use only tools that read. Do not write, upload, rename, copy or delete files,
  send console commands, change power state, or create or delete backups.
- Only report what you actually found in tool results. Never guess or fill gaps. Wherever
  data for part of the period isn't available, say so in the report.
- Don't quote player chat messages. Counts and player names are fine.

GATHER (in this order)
1. Current state: ptero_get_server and ptero_get_server_resources. Note the power state,
   uptime (so you know when it last started), CPU, memory against its limit, and disk.
2. Log files: ptero_list_files on "logs". The archived logs are named
   <date>-<n>.log.gz. You can't read them (they're compressed), but their dates and the
   <n> numbers show which days the server started up and how many times. Their sizes
   are a rough activity signal.
3. Current log: ptero_read_file on "logs/latest.log". It covers everything since the last
   start. Use its size from step 2 to choose how to read it:
   - under 400 KB: read the whole file with max_bytes 4194304.
   - 400 KB to 4 MB: make two reads with max_bytes 4194304, one with head_lines 150
     (the start-up) and one with tail_lines 4000 (the most recent activity). Say in the
     report that the middle of the log was skipped.
   - over 4 MB: it can't be read. Say so, and rely on the other sources.
   From it, extract:
   - start-ups ("Done (") and shutdowns ("Stopping server")
   - player joins and leaves ("joined the game" / "left the game"): unique players,
     total sessions, busiest hour, and who was online longest if you can tell
   - lag warnings ("Can't keep up!") with how far behind the server was
   - ERROR and WARN lines grouped by source (plugin or subsystem), with counts and the
     single most important example of each
   Log lines carry only a time, not a date. Work out dates from when the server started.
4. Crashes: ptero_list_files on "crash-reports" (skip if it doesn't exist). For any report
   dated inside the period, read the top of it (head_lines 40) and summarise the cause
   in one line.
5. Backups: ptero_list_backups, plus the backup limit from step 1. List backups created in
   the period, whether each succeeded, and their sizes. Flag it if the newest backup is
   more than 7 days old or the limit is nearly full.
6. Schedules: ptero_list_schedules. Show what ran in the period (last_run_at), what runs
   next (next_run_at), and any that are disabled.
7. File changes: ptero_list_files on "/", "plugins" and "config" (skip any that don't
   exist). List files and folders modified during the period. New or updated plugin jars
   are especially worth calling out.
[OPTIONAL — Claude Code only] 8. Read my audit log at ~/.pterodactyl-mcp/audit.jsonl and
   list every change made through pterodactyl-mcp in the period, including refused ones.

BUILD THE ARTIFACT
A single-page HTML report with:
- Title: "<server name> — activity report, [PERIOD]", with the time you generated it.
- A one-line verdict at the top (e.g. "Healthy, 2 restarts, no crashes, 1 warning to look
  at") and a traffic-light status: green / amber / red.
- Stat tiles: uptime, restarts, crashes, unique players, peak memory vs limit, lag warnings,
  errors.
- A simple timeline of the period showing start-ups, shutdowns, crashes, backups and
  scheduled runs.
- Sections for: Players, Stability (crashes, restarts, lag), Errors & warnings (a table
  grouped by source), Backups, Schedules, File changes, and (if gathered) Changes made via
  pterodactyl-mcp.
- "Worth your attention": at most 5 concrete, prioritised follow-ups, each tied to
  something you found.
- "Coverage & gaps": which days you had full logs for, which you only saw file dates for,
  and anything you couldn't check.
Clean, readable design that works in light and dark mode. No external data. Everything
in the page comes from what you gathered above.
```

### Quick versions

Once you've used the full template in a conversation, shorter follow-ups work:

- **Daily:** `Same report for today.`
- **Weekly:** `Now do the last 7 days, and compare it with the previous 7 where you can.`
- **Monthly:** `Make a monthly version for [MONTH]. Keep it to the highlights and the gaps.`
- **Focused:** `Same report, but only the stability section. I want to know why it keeps restarting.`

**Tip:** in Claude Desktop, create a **Project** and paste the template into the
project's instructions (with `[PERIOD]` left in). From then on, a new chat in that
project only needs "Weekly report, please."

### What the report can and can't see

| Source | What it tells you | Covers |
|---|---|---|
| `logs/latest.log` | Joins and leaves, errors, warnings, lag, start and stop | Since the last restart only. Very large logs are only partly read, and logs over 4 MB can't be read |
| Archived `logs/*.log.gz` | Which days the server started up, and how often | File names, dates and sizes only. The contents are compressed and can't be read |
| `crash-reports/` | Crash causes | Every crash that wrote a report |
| Backups | When backups were taken, success, size | Backups that still exist |
| Schedules | Last and next run of each task | Most recent run only, not a history |
| File listings | What was modified, and when | Latest modification time only |
| Live resources | CPU, memory, disk, uptime | Right now only. There is no history of resource use |
| Audit log (Claude Code) | Every change made through pterodactyl-mcp | The whole period |

So a **daily** report is usually detailed. For a **week or month**, anything before the
last restart comes from dates, crash reports and backups rather than full logs. The
report's "Coverage & gaps" section spells out exactly which parts are which.

The log-line patterns in the template are for Minecraft (Paper/Spigot). For another game,
replace them with that game's equivalents, or just delete them and let Claude work it out
from the log.
