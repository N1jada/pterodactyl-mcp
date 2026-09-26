import { describe, expect, it } from 'vitest';

import { PteroClient, parseRateLimitHeaders } from '../src/client.js';
import {
  PteroApiError,
  PteroHtmlResponseError,
  PteroRateLimitError,
  toActionableMessage,
} from '../src/errors.js';

const PANEL = 'https://panel.example.com';
const API_KEY = 'ptlc_supersecret_do_not_leak_0123456789';

interface Capture {
  url: string;
  init: RequestInit | undefined;
}

/** Build a client whose fetch returns a scripted response, capturing what was sent. */
function makeClient(
  respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { client: PteroClient; calls: Capture[] } {
  const calls: Capture[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return respond(url, init);
  }) as unknown as typeof fetch;

  return {
    client: new PteroClient({ panelUrl: PANEL, apiKey: API_KEY, fetch: fakeFetch }),
    calls,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('PteroClient request construction', () => {
  it('sends the documented auth and accept headers, and the correct base path', async () => {
    const { client, calls } = makeClient(() => json({ object: 'list', data: [] }));

    await client.get('/servers/1a2b3c4d');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${PANEL}/api/client/servers/1a2b3c4d`);

    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
    expect(headers['Accept']).toBe('Application/vnd.pterodactyl.v1+json');
    // No body, so no content-type should be forced.
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('sets application/json content-type for JSON bodies', async () => {
    const { client, calls } = makeClient(() => new Response(null, { status: 204 }));

    await client.post('/servers/abc/power', { signal: 'start' });

    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ signal: 'start' }));
    expect(calls[0]!.init?.method).toBe('POST');
  });

  it('postRaw sends the body verbatim as text/plain', async () => {
    const { client, calls } = makeClient(() => new Response(null, { status: 204 }));

    await client.writeFile('abc', 'plugins/Geyser-Spigot/config.yml', 'motd: "hi"\n');

    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('text/plain');
    expect(calls[0]!.init?.body).toBe('motd: "hi"\n');
    expect(calls[0]!.url).toContain('/files/write?file=');
  });

  it('URL-encodes query params containing slashes and spaces', async () => {
    const { client, calls } = makeClient(() => new Response('data', { status: 200 }));

    await client.getFileContents('abc', '/plugins/My Plugin/config file.yml');

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/client/servers/abc/files/contents');
    // Raw query string must be percent-encoded...
    expect(url.search).toContain('file=');
    expect(url.search).not.toContain(' ');
    expect(url.search).toContain('%2F');
    // ...and must decode back to exactly what we asked for.
    expect(url.searchParams.get('file')).toBe('/plugins/My Plugin/config file.yml');
  });

  it('URL-encodes directory listings the same way', async () => {
    const { client, calls } = makeClient(() => json({ object: 'list', data: [] }));

    await client.listFiles('abc', '/plugins/Geyser-Spigot');

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('directory')).toBe('/plugins/Geyser-Spigot');
    expect(url.search).not.toContain('/plugins');
  });
});

describe('PteroClient response handling', () => {
  it('returns undefined for 204 No Content', async () => {
    const { client } = makeClient(() => new Response(null, { status: 204 }));

    const result = await client.post('/servers/abc/command', { command: 'list' });
    expect(result).toBeUndefined();

    // The typed helpers over 204 endpoints must not blow up either.
    await expect(client.setPower('abc', 'start')).resolves.toBeUndefined();
    await expect(client.deleteBackup('abc', 'uuid-1')).resolves.toBeUndefined();
  });

  it('parses X-RateLimit-* headers on every response', async () => {
    const resetUnix = Math.floor(Date.now() / 1000) + 45;
    const { client } = makeClient(() =>
      json(
        { object: 'list', data: [] },
        200,
        {
          'x-ratelimit-limit': '240',
          'x-ratelimit-remaining': '198',
          'x-ratelimit-reset': String(resetUnix),
        },
      ),
    );

    expect(client.rateLimit()).toBeUndefined();
    await client.listServers();

    const rl = client.rateLimit();
    expect(rl).toBeDefined();
    expect(rl!.limit).toBe(240);
    expect(rl!.remaining).toBe(198);
    expect(rl!.resetAt.getTime()).toBe(resetUnix * 1000);
  });

  it('treats a small X-RateLimit-Reset as seconds-from-now', () => {
    const now = 1_700_000_000_000;
    const rl = parseRateLimitHeaders(new Headers({ 'x-ratelimit-reset': '30' }), now);
    expect(rl!.resetAt.getTime()).toBe(now + 30_000);
  });

  it('returns undefined rate limit when the panel sends no headers', async () => {
    const { client } = makeClient(() => json({ object: 'list', data: [] }));
    await client.listServers();
    expect(client.rateLimit()).toBeUndefined();
  });

  it('parses a getText body as raw text, not JSON', async () => {
    const contents = 'server-port=25565\nmotd=A Minecraft Server\n';
    const { client } = makeClient(
      () => new Response(contents, { status: 200, headers: { 'content-type': 'text/plain' } }),
    );

    await expect(client.getFileContents('abc', 'server.properties')).resolves.toBe(contents);
  });

  it('does not mistake file content beginning with < for an HTML error page', async () => {
    const xml = '<?xml version="1.0"?><config/>';
    const { client } = makeClient(
      () => new Response(xml, { status: 200, headers: { 'content-type': 'text/plain' } }),
    );

    await expect(client.getFileContents('abc', 'plugins/thing/config.xml')).resolves.toBe(xml);
  });
});

describe('PteroClient error mapping', () => {
  it('maps a 429 to PteroRateLimitError naming the reset time', async () => {
    const resetUnix = Math.floor(Date.now() / 1000) + 90;
    const { client } = makeClient(
      () =>
        new Response(JSON.stringify({ errors: [{ code: 'ThrottleRequestsException', status: '429' }] }), {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-limit': '240',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(resetUnix),
          },
        }),
    );

    const err = await client.listServers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PteroRateLimitError);

    const rateErr = err as PteroRateLimitError;
    expect(rateErr.resetAt.getTime()).toBe(resetUnix * 1000);

    const message = toActionableMessage(rateErr);
    expect(message).toContain(rateErr.resetAt.toISOString());
    expect(message).toMatch(/do not retry before/i);
  });

  it('falls back to Retry-After when no reset header is present', async () => {
    const before = Date.now();
    const { client } = makeClient(
      () => new Response('{}', { status: 429, headers: { 'retry-after': '60' } }),
    );

    const err = (await client.listServers().catch((e: unknown) => e)) as PteroRateLimitError;
    expect(err).toBeInstanceOf(PteroRateLimitError);
    expect(err.resetAt.getTime()).toBeGreaterThanOrEqual(before + 59_000);
  });

  it('maps an HTML body to PteroHtmlResponseError with a key/URL explanation', async () => {
    const { client } = makeClient(
      () =>
        new Response('<!DOCTYPE html><html><body>Log in to Pterodactyl</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=UTF-8' },
        }),
    );

    const err = await client.listServers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PteroHtmlResponseError);

    const message = toActionableMessage(err);
    expect(message).toMatch(/HTML/);
    expect(message).toMatch(/API key/i);
    expect(message).toMatch(/PTERODACTYL_PANEL_URL/);
  });

  it('detects HTML by body shape even without a text/html content-type', async () => {
    const { client } = makeClient(
      () => new Response('  <html><head><title>502 Bad Gateway</title></head></html>', { status: 502 }),
    );

    const err = await client.getServer('abc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PteroHtmlResponseError);
  });

  it('maps the {errors:[...]} envelope onto PteroApiError fields', async () => {
    const { client } = makeClient(() =>
      json(
        {
          errors: [
            {
              code: 'NotFoundHttpException',
              status: '404',
              detail: 'The requested resource could not be found on the server.',
            },
          ],
        },
        404,
      ),
    );

    const err = (await client.getServer('nope1234').catch((e: unknown) => e)) as PteroApiError;
    expect(err).toBeInstanceOf(PteroApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('NotFoundHttpException');
    expect(err.detail).toContain('could not be found');
    expect(err.path).toBe('/servers/nope1234');
  });

  it('gives a 404 an actionable message pointing at ptero_list_servers', async () => {
    const { client } = makeClient(() =>
      json({ errors: [{ code: 'NotFoundHttpException', status: '404', detail: 'Not found.' }] }, 404),
    );

    const err = await client.getServer('nope1234').catch((e: unknown) => e);
    const message = toActionableMessage(err);

    expect(message).toContain('ptero_list_servers');
    expect(message).toContain('/servers/nope1234');
  });

  it('gives 401/403 messages that mention key validity and host restrictions', async () => {
    for (const status of [401, 403]) {
      const { client } = makeClient(() =>
        json({ errors: [{ code: 'AccessDeniedHttpException', status: String(status) }] }, status),
      );

      const err = await client.getResources('abc').catch((e: unknown) => e);
      const message = toActionableMessage(err);

      expect(message).toContain('PTERODACTYL_API_KEY');
      expect(message).toMatch(/some hosts restrict/i);
    }
  });

  it('explains a 502 on a command as the server being offline', async () => {
    const { client } = makeClient(() =>
      json(
        {
          errors: [
            {
              code: 'HttpException',
              status: '502',
              detail: 'Server must be online in order to send commands.',
            },
          ],
        },
        502,
      ),
    );

    const err = await client.sendCommand('abc', 'list').catch((e: unknown) => e);
    const message = toActionableMessage(err);
    expect(message).toContain('ptero_get_server_resources');
    expect(message).toContain('Server must be online');
  });
});

describe('PteroClient secret hygiene', () => {
  const bodies: Array<[string, () => Response]> = [
    ['404 envelope', () => json({ errors: [{ code: 'NotFoundHttpException', detail: 'x' }] }, 404)],
    ['401 envelope', () => json({ errors: [{ code: 'AccessDeniedHttpException' }] }, 401)],
    ['429', () => new Response('{}', { status: 429 })],
    ['HTML', () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['unparsable body', () => new Response('not json at all', { status: 500 })],
  ];

  for (const [label, respond] of bodies) {
    it(`never leaks the API key for: ${label}`, async () => {
      const { client } = makeClient(respond);

      const err = await client.getServer('abc').catch((e: unknown) => e);
      const surfaces = [
        err instanceof Error ? err.message : String(err),
        err instanceof Error ? String(err) : '',
        err instanceof Error ? (err.stack ?? '') : '',
        toActionableMessage(err),
        JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})),
      ].join('\n');

      expect(surfaces).not.toContain(API_KEY);
      expect(surfaces).not.toContain('ptlc_');
      expect(surfaces).not.toMatch(/Bearer /);
    });
  }
});

describe('PteroClient typed helpers', () => {
  it('hits the documented paths', async () => {
    const routes: Array<[string, () => Promise<unknown>, string, string]> = [];
    const { client, calls } = makeClient((url) => {
      if (url.includes('/websocket')) {
        return json({ data: { token: 'jwt-value', socket: 'wss://node/api/servers/x/ws' } });
      }
      if (url.includes('/download')) {
        return json({ object: 'signed_url', attributes: { url: 'https://node/download?token=abc' } });
      }
      return json({ object: 'list', data: [] });
    });

    routes.push(
      ['listServers', () => client.listServers(2), 'GET', '/api/client/?page=2'],
      ['getServer', () => client.getServer('abc'), 'GET', '/api/client/servers/abc'],
      ['getResources', () => client.getResources('abc'), 'GET', '/api/client/servers/abc/resources'],
      ['listBackups', () => client.listBackups('abc'), 'GET', '/api/client/servers/abc/backups'],
      ['listSchedules', () => client.listSchedules('abc'), 'GET', '/api/client/servers/abc/schedules'],
      [
        'listAllocations',
        () => client.listAllocations('abc'),
        'GET',
        '/api/client/servers/abc/network/allocations',
      ],
      ['getStartup', () => client.getStartup('abc'), 'GET', '/api/client/servers/abc/startup'],
      ['getAccount', () => client.getAccount(), 'GET', '/api/client/account'],
    );

    for (const [, run] of routes) {
      await run();
    }

    const seen = calls.map((c) => c.url.replace(PANEL, ''));
    for (const [name, , , expectedPath] of routes) {
      expect(seen, `${name} should hit ${expectedPath}`).toContain(expectedPath);
    }
  });

  it('unwraps websocket credentials from the data envelope', async () => {
    const { client } = makeClient(() =>
      json({ data: { token: 'jwt-value', socket: 'wss://node/api/servers/x/ws' } }),
    );

    const creds = await client.getWebsocketCredentials('abc');
    expect(creds).toEqual({ token: 'jwt-value', socket: 'wss://node/api/servers/x/ws' });
  });

  it('unwraps a signed backup download URL', async () => {
    const { client } = makeClient(() =>
      json({ object: 'signed_url', attributes: { url: 'https://node/download/backup?token=xyz' } }),
    );

    await expect(client.getBackupDownloadUrl('abc', 'uuid-1')).resolves.toBe(
      'https://node/download/backup?token=xyz',
    );
  });

  it('unwraps a signed file upload URL', async () => {
    const { client, calls } = makeClient(() =>
      json({ object: 'signed_url', attributes: { url: 'https://node:8080/upload/file?token=jwt' } }),
    );

    await expect(client.getFileUploadUrl('abc')).resolves.toBe(
      'https://node:8080/upload/file?token=jwt',
    );
    expect(calls[0]!.url).toBe(`${PANEL}/api/client/servers/abc/files/upload`);
  });

  it('POSTs upload bytes to the signed node URL, keeping the token and adding directory', async () => {
    const { client, calls } = makeClient(() => new Response(null, { status: 200 }));

    await client.uploadToSignedUrl(
      'https://node.example.com:8080/upload/file?token=jwt-value',
      '/plugins',
      'MyPlugin.jar',
      new Uint8Array([1, 2, 3, 4]),
    );

    expect(calls).toHaveLength(1);
    const sent = new URL(calls[0]!.url);
    expect(sent.origin + sent.pathname).toBe('https://node.example.com:8080/upload/file');
    expect(sent.searchParams.get('token')).toBe('jwt-value');
    expect(sent.searchParams.get('directory')).toBe('/plugins');

    const init = calls[0]!.init!;
    expect(init.method).toBe('POST');
    // The panel key must never be sent to the node — Wings authenticates from the token.
    expect(init.headers).toBeUndefined();

    const form = await new Request(calls[0]!.url, init).formData();
    const part = form.get('files') as File;
    expect(part.name).toBe('MyPlugin.jar');
    expect(Buffer.from(new Uint8Array(await part.arrayBuffer()))).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('maps a node-side upload failure onto the usual error type without leaking the signed URL', async () => {
    const { client } = makeClient(
      () =>
        new Response(JSON.stringify({ error: 'No files were found on the request body.' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await expect(
      client.uploadToSignedUrl(
        'https://node.example.com:8080/upload/file?token=super-secret-jwt',
        '/',
        'x.bin',
        new Uint8Array([0]),
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(PteroApiError);
      const message = toActionableMessage(err);
      expect(message).toContain('/files/upload (Wings node)');
      expect(message).not.toContain('super-secret-jwt');
      return true;
    });
  });

  it('omits unset optional fields from a createBackup body', async () => {
    const { client, calls } = makeClient(() => json({ object: 'backup', attributes: {} }));

    await client.createBackup('abc', { name: 'pre-write' });
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ name: 'pre-write' }));

    await client.createBackup('abc');
    expect(calls[1]!.init?.body).toBe('{}');
  });

  it('sends rename and delete bodies in the documented shape', async () => {
    const { client, calls } = makeClient(() => new Response(null, { status: 204 }));

    await client.renameFiles('abc', '/plugins', [{ from: 'a.yml', to: 'b.yml' }]);
    expect(calls[0]!.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      root: '/plugins',
      files: [{ from: 'a.yml', to: 'b.yml' }],
    });

    await client.deleteFiles('abc', '/logs', ['old.log']);
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ root: '/logs', files: ['old.log'] });

    await client.copyFile('abc', '/server.properties');
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ location: '/server.properties' });
  });
});
