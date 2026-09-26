# Security Policy

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, use GitHub's private reporting: go to the
[Security tab](https://github.com/N1jada/pterodactyl-mcp/security) of this repository
and click **Report a vulnerability**. Include steps to reproduce, the affected version or
commit, and the impact you expect.

You should get an initial response within a week. Once a fix is available it will be
released and the advisory published, crediting you unless you'd rather stay anonymous.

## Scope

In scope, for example:

- A way to make a mutating tool act without passing through the guard.
- Bypassing protected paths, read-only mode, the allowed-servers list, or confirmation
  token binding.
- The API key, websocket JWT, or signed URLs leaking into logs, the audit trail, error
  messages or tool output where they shouldn't.

Out of scope: the guardrails are documented as protection against *mistakes*, not a
security boundary against whoever holds the API key. Anything that key can already do
directly in the Pterodactyl panel is not a vulnerability in this project. Issues in
Pterodactyl Panel or Wings themselves should be reported to the
[Pterodactyl project](https://github.com/pterodactyl/panel/security).

## Keeping your key safe

- Use a **Client** API key (`ptlc_...`), never an Application key.
- Consider restricting the key to specific IPs in the panel.
- Never commit your `.env` file. The repository's `.gitignore` excludes it.
