# What can you do with pterodactyl-mcp?

Short, real-world stories showing what it's like to run a game server with an AI
assistant connected through pterodactyl-mcp. Each story gives something you might
actually type, and what happens behind the scenes.

The examples use a Minecraft server because that's the most common thing people host on
Pterodactyl. The status, console, file, backup and power tools work the same for any
game, though the default protected paths are aimed at Minecraft.

> **Two profiles.** Most people register the server twice: a **read-only** profile for
> everyday questions, and a **maintenance** profile they switch on only when they mean to
> change something. Stories that change the server are marked 🔧. Everything else
> works in read-only mode.

---

## Checking in

### "Is everything OK?"
*As a server owner, I want a quick health check without opening the panel, so I can
answer "is it up?" in five seconds.*

> **You:** Is the server up, and how's the memory looking?

The assistant reads the live power state, CPU, memory, disk, network and uptime, then
answers in plain English: *"It's running, up 3 hours, using 3.2 GiB of its 8 GiB. CPU
is at 42%."*

### "Show me the setup"
*As someone who inherited a server from a friend, I want a summary of how it's
configured, so I know what I'm working with.*

> **You:** Give me an overview of this server: limits, ports, Java version and startup
> command.

The assistant pulls the server's limits, network allocations (ports), Docker image, egg
variables and resolved startup command, and summarises them in one answer.

### "Which server was that?"
*As someone with several servers on one panel, I want to see them all at once, so I can
pick the right one.*

> **You:** List all my servers and tell me which ones are offline.

---

## Troubleshooting

### "Why did it crash?"
*As a server owner woken up by a "server's down" message, I want to know what went wrong
before I restart anything.*

> **You:** The server went down overnight. Look at the logs and tell me what happened.

The assistant reads the end of `logs/latest.log` (or the newest report in `crash-reports/`) and
points at the relevant stack trace or error. It won't dump the whole file into the chat.

### "What's spamming the console?"
*As an admin, I want to filter a noisy console so I can find one plugin's messages.*

> **You:** Show me recent console output, just the lines mentioning Geyser.

The assistant collects a few seconds of live console output and filters it. The console
only keeps about 150 lines, so the assistant knows to check `logs/latest.log` for anything
older, such as startup messages, instead of wrongly telling you "nothing found".

### "Did my plugin actually load?"
*As someone who just added a plugin, I want to confirm it started and bound its port.*

> **You:** Did Geyser bind to its Bedrock port on the last boot? Check the config and
> the startup log.

The assistant reads `plugins/Geyser-Spigot/config.yml` to find the configured port,
compares it with the server's allocations, and searches the startup log for the "Started
Geyser on…" line.

### "Is it lagging?"
*As an admin hearing lag complaints, I want a first look at resource usage and recent
warnings in one go.*

> **You:** Players say it's laggy. Check resource usage and look for "Can't keep up"
> warnings in the log.

---

## Changing configuration 🔧

### Tweak a plugin config
*As a server owner, I want to change a setting without juggling SFTP.*

> **You:** Change the Bedrock MOTD in the Geyser config to "Welcome, Bedrock players!"

The assistant reads the file, edits just that line and asks you to confirm before
overwriting it, showing exactly which file will change. A backup is taken automatically
before the write. If the backup fails, the change is cancelled.

### Try it first
*As a cautious admin, I want to see what would change before anything happens.*

> **You:** Do a dry run of changing `username-prefix` to `"*"` in the Floodgate config.

With `dry_run`, the assistant gets a full preview of the change and nothing on the server
is touched.

### Protected files stay protected
*As a server owner, I want my world and core files to be off-limits to the assistant
unless I say otherwise.*

> **You:** Set max-players to 50 in server.properties.

This is **refused** by default. `server.properties`, `ops.json`, `whitelist.json`, the
ban lists and the world folders are protected paths. The refusal names the setting
(`PTERODACTYL_PROTECTED_PATHS`) you'd change if you really want to allow it. The assistant
can still *read* those files.

---

## Plugins and files 🔧

### Install a plugin
*As a server owner, I want to drop a plugin jar I downloaded onto the server.*

> **You:** Upload `/home/me/Downloads/LuckPerms-5.4.jar` to the plugins folder, then
> restart the server.

The assistant uploads the jar (up to 64 MiB), lists the plugins folder to check the size
matches, then asks you to confirm the restart. Binary uploads go straight from your
machine to the server. They never pass through the chat. Give the file's full path on the
machine running pterodactyl-mcp, because shortcuts like `~` aren't accepted.

### Keep a copy before editing
*As an admin, I want a quick copy of a config file before I experiment.*

> **You:** Make a copy of the EssentialsX config, then rename the copy to
> `config-backup.yml`.

### Clean up old files
*As an owner with a messy server, I want to remove plugins I no longer use.*

> **You:** Delete `plugins/OldPlugin.jar` and its config folder.

Deleting is **off by default**. With deletes switched on in your maintenance profile, the
assistant always shows you the list of files and waits for your OK. It takes a backup
first, and it refuses to delete more than 10 files in one go.

---

## Backups 🔧

### Backup before a big change
*As a server owner about to update, I want a backup I can roll back to.*

> **You:** Take a backup called "before 1.21 update" and tell me when it's done.

The assistant starts the backup and waits (up to about two minutes) until the panel
reports it complete, then gives you its size.

### What backups do I have?
*As an admin, I want to see existing backups and whether I'm near my host's limit.*

> **You:** List my backups and tell me how many slots I have left.

### Download a backup
*As an owner, I want a copy of my world on my own computer.*

> **You:** Give me a download link for the latest backup.

You get a signed, short-lived link. The link is never written to the audit log.

---

## Restarts and power 🔧

### Restart safely
*As an admin, I want to restart the server and know when it's back.*

> **You:** Restart the server and let me know once it's running again.

The assistant asks you to confirm the restart, sends it, then watches the power state for
up to a minute. If the server is still starting after that (big modpacks can take a
while), it checks again.

### Warn players first
*As a considerate admin, I want to give players notice before a restart.*

> **You:** Tell everyone in chat the server restarts in 5 minutes.

The assistant sends a `say` command to the console. Console commands only confirm that
the command was sent, so the assistant reads the console afterwards to see the result.

### No accidental hard stops
*As an owner, I never want the assistant to force-kill the server and corrupt the world.*

> **You:** The server's frozen, kill it.

`kill` is **refused** unless you've explicitly enabled it. The assistant will suggest a
normal `stop` instead, which saves the world first. Repeated power actions within 30
seconds are also refused, which stops restart loops.

---

## Players and console 🔧

### Who's online?
> **You:** Who's online right now?

The assistant runs `list` in the console and reads the reply from the console output.

### Run admin commands
> **You:** Whitelist the player "Steve" and give them op.

The assistant sends `whitelist add Steve` and `op Steve`, then checks the console to
confirm both worked.

---

## Scheduling and network

### What runs automatically?
*As a new admin, I want to know what the server does on its own.*

> **You:** What scheduled tasks does this server have, and when do they next run?

### What address do players use?
> **You:** What IP and port should my friends connect to? And the Bedrock one?

The assistant lists the server's allocations and tells you which one is the default
(Java) and which is used for Bedrock.

---

## Staying in control

### Everyday mode is read-only
*As a cautious owner, I want the assistant to look but not touch unless I choose.*

With the read-only profile, every change is refused outright, so you can ask anything
without worrying. Switch to the maintenance profile only when you mean to make changes.

### Only the servers I choose
*As someone with several servers, I want changes limited to my test server.*

Set `PTERODACTYL_ALLOWED_SERVERS` and any change aimed at another server is refused, even
if the assistant picks the wrong ID.

### A record of everything
*As an owner, I want to know exactly what the assistant did while I was away.*

Every attempted, refused and completed change is written to an audit log
(`~/.pterodactyl-mcp/audit.jsonl` by default), with secrets removed.

> **You:** What changes did you make to the server today?

The assistant can only answer from its own conversation. The audit log is the permanent
record, and you can open it yourself any time.

### A budget per session
*As an owner, I want a hard cap on how much the assistant can change in one go.*

By default the assistant can make 20 changes per run of the MCP server (usually one
chat session) before everything is refused. Restarting it resets the budget.

---

## What it can't do

- **Admin-level panel tasks.** It can't create servers, manage users or change nodes. It
  uses a normal Client API key, so it can only do what your account can do in the panel.
- **Run while nobody's watching.** It acts when you ask it to in a conversation. For
  things that should happen on a timer, use the panel's own schedules.
- **See old console output.** The live console only keeps recent lines. Older output
  comes from the log files.
- **Stop someone who has your key.** The guardrails prevent *mistakes* by the assistant.
  They are not a security barrier. Anyone with the API key can do all of this in the
  panel directly.
