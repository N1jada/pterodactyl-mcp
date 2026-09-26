/**
 * Error hierarchy for pterodactyl-mcp.
 *
 * Hard rule: the API key never appears in any error message, `toString()`, or property
 * of any error defined here. Nothing in this module ever receives the key, and the
 * client is responsible for keeping it out of the `path`/`detail` it passes in.
 */

/** Base class for every error this server raises deliberately. */
export class PteroError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Bad/missing environment configuration. Fatal at startup. */
export class ConfigError extends PteroError {
  /** The environment variable the operator needs to set/fix, when there is one. */
  readonly variable?: string;

  constructor(message: string, variable?: string) {
    super(message);
    this.variable = variable;
  }
}

/** A non-2xx JSON response from the panel, mapped from the `{errors:[...]}` envelope. */
export class PteroApiError extends PteroError {
  readonly status: number;
  /** Panel exception short-name, e.g. `NotFoundHttpException`. */
  readonly code: string | undefined;
  /** Human-readable `detail` from the envelope, when present. */
  readonly detail: string | undefined;
  /** API path (relative to `/api/client`) that produced this error. Never includes the key. */
  readonly path: string;

  constructor(opts: { status: number; code?: string; detail?: string; path: string }) {
    super(
      `Pterodactyl API error ${opts.status}${opts.code ? ` (${opts.code})` : ''} on ${opts.path}` +
        (opts.detail ? `: ${opts.detail}` : ''),
    );
    this.status = opts.status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.path = opts.path;
  }
}

/**
 * The panel returned HTML where JSON was expected — almost always a wrong API key
 * (login redirect), a wrong panel URL, or a path that isn't an API route at all.
 */
export class PteroHtmlResponseError extends PteroError {
  readonly status: number;
  readonly path: string;
  /** First bytes of the body, for diagnostics. Truncated, never logged wholesale. */
  readonly snippet: string;

  constructor(opts: { status: number; path: string; snippet: string }) {
    super(
      `The panel returned an HTML page instead of JSON for ${opts.path} (HTTP ${opts.status}).`,
    );
    this.status = opts.status;
    this.path = opts.path;
    this.snippet = opts.snippet;
  }
}

/** HTTP 429 from the panel's throttle middleware. */
export class PteroRateLimitError extends PteroError {
  readonly status = 429;
  readonly path: string;
  /** When the current rate-limit window resets. Do not retry before this. */
  readonly resetAt: Date;
  readonly limit: number | undefined;

  constructor(opts: { path: string; resetAt: Date; limit?: number }) {
    super(
      `Rate limited by the panel on ${opts.path}. The limit resets at ${opts.resetAt.toISOString()}.`,
    );
    this.path = opts.path;
    this.resetAt = opts.resetAt;
    this.limit = opts.limit;
  }
}

/**
 * Some hosts sit in front of Pterodactyl and disable parts of
 * the Client API. A consistent 401/403 is as likely to be that as a bad key.
 */
const HOST_RESTRICTION_NOTE =
  'Note that some hosts restrict or disable parts of the Pterodactyl Client API, so a ' +
  'consistently-failing endpoint may be blocked by the host rather than by your key.';

function secondsUntil(resetAt: Date, now: number): number {
  return Math.max(0, Math.ceil((resetAt.getTime() - now) / 1000));
}

/**
 * Turn any thrown value into a message a calling model can act on: what went wrong,
 * why, and the concrete next step. Never contains the API key.
 */
export function toActionableMessage(err: unknown): string {
  if (err instanceof PteroRateLimitError) {
    const secs = secondsUntil(err.resetAt, Date.now());
    return (
      `Rate limited by the Pterodactyl panel (HTTP 429) on \`${err.path}\`. ` +
      `The limit resets at ${err.resetAt.toISOString()} (about ${secs}s from now). ` +
      `Do not retry before then — retrying sooner will only be rejected again and can extend the block. ` +
      `Wait for the reset, then reissue the call.`
    );
  }

  if (err instanceof PteroHtmlResponseError) {
    return (
      `The panel returned an HTML page instead of JSON for \`${err.path}\` (HTTP ${err.status}). ` +
      `That almost always means the API key is wrong, revoked, or is an *application* key ` +
      `rather than a client key, or that PTERODACTYL_PANEL_URL points somewhere that is not the ` +
      `panel root (so the request landed on a web page, not \`/api/client\`). ` +
      `Ask the user to check PTERODACTYL_PANEL_URL and regenerate a Client API key under ` +
      `Account -> API Credentials. This is not something to retry.`
    );
  }

  if (err instanceof ConfigError) {
    return err.message;
  }

  if (err instanceof PteroApiError) {
    const detail = err.detail ? ` Panel said: ${err.detail}` : '';

    if (err.status === 404) {
      return (
        `Not found (HTTP 404) at \`${err.path}\`.${detail} ` +
        `The server identifier, file path or resource ID probably does not exist or is not ` +
        `visible to this API key. Call \`ptero_list_servers\` to see the server identifiers this ` +
        `key can access, and check the identifier you used against that list before retrying.`
      );
    }

    if (err.status === 401 || err.status === 403) {
      const which =
        err.status === 401
          ? 'The API key is missing, invalid, or expired'
          : 'The API key is valid but lacks permission for this action';
      return (
        `${which} (HTTP ${err.status}) at \`${err.path}\`.${detail} ` +
        `Check that PTERODACTYL_API_KEY is a current *Client* API key (Account -> API Credentials ` +
        `in the panel; application/admin keys are rejected on client routes) and that the account ` +
        `has the relevant permission on this server. ${HOST_RESTRICTION_NOTE} ` +
        `Do not retry without changing something — tell the user what to check.`
      );
    }

    if (err.status === 422) {
      return (
        `The panel rejected the request as invalid (HTTP 422) at \`${err.path}\`.${detail} ` +
        `Fix the arguments and call again — retrying unchanged will fail identically.`
      );
    }

    if (err.status === 502) {
      return (
        `The panel could not reach the game server daemon (HTTP 502) at \`${err.path}\`.${detail} ` +
        `The most common cause is the server being offline — console commands require a running ` +
        `server. Check the power state with \`ptero_get_server_resources\` first.`
      );
    }

    if (err.status >= 500) {
      return (
        `The panel returned a server error (HTTP ${err.status}) at \`${err.path}\`.${detail} ` +
        `This is a panel-side or node-side fault, not something the arguments can fix. ` +
        `Retry once after a short pause; if it persists, report it to the user.`
      );
    }

    return (
      `The panel returned HTTP ${err.status} at \`${err.path}\`.${detail} ` +
      `Check the arguments against the tool description before retrying.`
    );
  }

  if (err instanceof PteroError) {
    return err.message;
  }

  if (err instanceof Error) {
    // Network-level failures from fetch land here.
    const cause =
      err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return `${err.message}${cause}`;
  }

  return String(err);
}
