import { describe, it, expect, vi } from 'vitest';
import {
  Confirmation,
  renderPreview,
  type ElicitCapableServer,
  type ElicitInputParams,
  type ElicitInputResult,
} from '../src/confirm.js';

interface Stub {
  srv: ElicitCapableServer;
  calls: ElicitInputParams[];
  setCapabilities(caps: Record<string, unknown> | undefined): void;
  setResponse(r: ElicitInputResult | (() => never)): void;
}

function stubServer(): Stub {
  const calls: ElicitInputParams[] = [];
  let caps: Record<string, unknown> | undefined = { elicitation: {} };
  let response: ElicitInputResult | (() => never) = { action: 'accept', content: { confirm: true } };
  const srv: ElicitCapableServer = {
    server: {
      getClientCapabilities: () => caps,
      elicitInput: async (params: ElicitInputParams) => {
        calls.push(params);
        if (typeof response === 'function') response();
        return response;
      },
    },
  };
  return {
    srv,
    calls,
    setCapabilities: (c) => {
      caps = c;
    },
    setResponse: (r) => {
      response = r;
    },
  };
}

function makeConfirm(opts: { stub?: Stub; now?: () => number } = {}) {
  const stub = opts.stub ?? stubServer();
  let n = 0;
  const confirm = new Confirmation({
    server: stub.srv,
    ...(opts.now ? { now: opts.now } : {}),
    random: () => `tok-${++n}`,
  });
  return { confirm, stub };
}

describe('Confirmation.bindingHash', () => {
  it('is stable across key ordering', () => {
    const a = Confirmation.bindingHash('t', 's', { b: 2, a: 1, c: { y: 1, x: 2 } });
    const b = Confirmation.bindingHash('t', 's', { c: { x: 2, y: 1 }, a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('strips confirmation_token and dry_run, and drops undefined values', () => {
    const base = Confirmation.bindingHash('t', 's', { path: 'a.txt' });
    expect(Confirmation.bindingHash('t', 's', { path: 'a.txt', confirmation_token: 'x', dry_run: true }))
      .toBe(base);
    expect(Confirmation.bindingHash('t', 's', { path: 'a.txt', other: undefined })).toBe(base);
  });

  it('changes when the tool, server or any argument changes', () => {
    const base = Confirmation.bindingHash('t', 's', { path: 'a.txt' });
    expect(Confirmation.bindingHash('t2', 's', { path: 'a.txt' })).not.toBe(base);
    expect(Confirmation.bindingHash('t', 's2', { path: 'a.txt' })).not.toBe(base);
    expect(Confirmation.bindingHash('t', 's', { path: 'b.txt' })).not.toBe(base);
  });
});

describe('Confirmation tokens', () => {
  it('mints a token bound to the hash and consumes it once', () => {
    const { confirm } = makeConfirm();
    const hash = Confirmation.bindingHash('t', 's', { a: 1 });
    const { token, expiresAt } = confirm.mint(hash);
    expect(token).toBe('tok-1');
    expect(expiresAt).toBeGreaterThan(Date.now() - 1000);
    expect(confirm.consume(token, hash)).toEqual({ ok: true });
    expect(confirm.consume(token, hash)).toEqual({ ok: false, reason: 'used' });
  });

  it('rejects an unknown token', () => {
    const { confirm } = makeConfirm();
    expect(confirm.consume('nope', 'h')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects a token replayed against a different binding hash', () => {
    const { confirm } = makeConfirm();
    const { token } = confirm.mint(Confirmation.bindingHash('t', 's', { path: 'a.txt' }));
    const other = Confirmation.bindingHash('t', 's', { path: 'b.txt' });
    expect(confirm.consume(token, other)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a token after the 120 s TTL', () => {
    let clock = 1_000_000;
    const { confirm } = makeConfirm({ now: () => clock });
    const hash = 'h';
    const { token, expiresAt } = confirm.mint(hash);
    expect(expiresAt).toBe(1_000_000 + 120_000);
    clock += 119_999;
    expect(confirm.consume(token, hash)).toEqual({ ok: true });

    const second = confirm.mint(hash);
    clock += 120_001;
    expect(confirm.consume(second.token, hash)).toEqual({ ok: false, reason: 'expired' });
  });

  it('sweeps expired tokens on mint', () => {
    let clock = 0;
    const { confirm } = makeConfirm({ now: () => clock });
    confirm.mint('h1');
    confirm.mint('h2');
    expect(confirm.size).toBe(2);
    clock += 120_001;
    confirm.mint('h3');
    expect(confirm.size).toBe(1);
  });

  it('keeps tokens in memory only (no persistence surface)', () => {
    const { confirm } = makeConfirm();
    confirm.mint('h');
    // A fresh instance shares nothing with the old one.
    const { confirm: other } = makeConfirm();
    expect(other.consume('tok-1', 'h')).toEqual({ ok: false, reason: 'unknown' });
  });
});

describe('Confirmation.clientSupportsElicitation', () => {
  it('is true when the client declared elicitation', () => {
    const { confirm } = makeConfirm();
    expect(confirm.clientSupportsElicitation()).toBe(true);
  });

  it('is false when capabilities are absent or lack elicitation', () => {
    const stub = stubServer();
    const { confirm } = makeConfirm({ stub });
    stub.setCapabilities({});
    expect(confirm.clientSupportsElicitation()).toBe(false);
    stub.setCapabilities(undefined);
    expect(confirm.clientSupportsElicitation()).toBe(false);
  });
});

describe('Confirmation.elicit', () => {
  const preview = {
    tool: 'ptero_delete_file',
    server: '1a2b3c4d',
    fields: { path: 'plugins/old.jar', files: 1 },
    autoBackup: true,
  };

  it('maps accept + confirm=true to accepted and sends a flat boolean schema', async () => {
    const stub = stubServer();
    const { confirm } = makeConfirm({ stub });
    await expect(confirm.elicit(preview)).resolves.toBe('accepted');
    expect(stub.calls).toHaveLength(1);
    const schema = stub.calls[0]!.requestedSchema;
    expect(schema.type).toBe('object');
    expect(schema.properties['confirm']).toMatchObject({ type: 'boolean', title: 'Confirm' });
    expect(schema.required).toEqual(['confirm']);
  });

  it('maps accept + confirm=false to declined', async () => {
    const stub = stubServer();
    const { confirm } = makeConfirm({ stub });
    stub.setResponse({ action: 'accept', content: { confirm: false } });
    await expect(confirm.elicit(preview)).resolves.toBe('declined');
  });

  it('maps decline to declined and cancel to cancelled', async () => {
    const stub = stubServer();
    const { confirm } = makeConfirm({ stub });
    stub.setResponse({ action: 'decline' });
    await expect(confirm.elicit(preview)).resolves.toBe('declined');
    stub.setResponse({ action: 'cancel' });
    await expect(confirm.elicit(preview)).resolves.toBe('cancelled');
  });

  it('treats a thrown elicitInput as cancelled, never as approval', async () => {
    const stub = stubServer();
    const { confirm } = makeConfirm({ stub });
    stub.setResponse(() => {
      throw new Error('Client does not support form elicitation.');
    });
    await expect(confirm.elicit(preview)).resolves.toBe('cancelled');
  });

  it('treats an elicitation that never answers as cancelled once the TTL elapses', async () => {
    const stub = stubServer();
    const hanging: ElicitCapableServer = {
      server: {
        getClientCapabilities: () => ({ elicitation: {} }),
        elicitInput: () => new Promise<ElicitInputResult>(() => undefined),
      },
    };
    void stub;
    const confirm = new Confirmation({ server: hanging, ttlMs: 30 });
    await expect(confirm.elicit(preview)).resolves.toBe('cancelled');
  });

  it('treats an aborted elicitation as cancelled', async () => {
    const hanging: ElicitCapableServer = {
      server: {
        getClientCapabilities: () => ({ elicitation: {} }),
        elicitInput: () => new Promise<ElicitInputResult>(() => undefined),
      },
    };
    const confirm = new Confirmation({ server: hanging, ttlMs: 10_000 });
    const controller = new AbortController();
    const pending = confirm.elicit(preview, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBe('cancelled');
  });

  it('renders the preview as readable text including the backup note', async () => {
    const stub = stubServer();
    const { confirm } = makeConfirm({ stub });
    await confirm.elicit(preview);
    const message = stub.calls[0]!.message;
    expect(message).toContain('ptero_delete_file');
    expect(message).toContain('1a2b3c4d');
    expect(message).toContain('path: plugins/old.jar');
    expect(message).toContain('files: 1');
    expect(message).toContain('backup will be taken');
  });

  it('omits the backup note when no backup will be taken', () => {
    const text = renderPreview({ tool: 't', server: 's', fields: { a: 1 } });
    expect(text).not.toContain('backup will be taken');
    expect(text).toContain('a: 1');
  });
});

describe('Confirmation default randomness', () => {
  it('mints unguessable base64url tokens by default', () => {
    const confirm = new Confirmation({ server: stubServer().srv });
    const a = confirm.mint('h').token;
    const b = confirm.mint('h').token;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('does not consult the clock via Date.now spies unexpectedly', () => {
    const spy = vi.spyOn(Date, 'now');
    const confirm = new Confirmation({ server: stubServer().srv });
    confirm.mint('h');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
