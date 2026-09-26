import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_MUTATIONS,
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_PROTECTED_PATHS,
  expandTilde,
  loadConfig,
} from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const MINIMAL = {
  PTERODACTYL_PANEL_URL: 'https://panel.example.com',
  PTERODACTYL_API_KEY: 'ptlc_testkey',
};

describe('loadConfig required variables', () => {
  it('throws an actionable ConfigError when PANEL_URL is missing', () => {
    const err = (() => {
      try {
        loadConfig({ PTERODACTYL_API_KEY: 'ptlc_x' });
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(ConfigError);
    const configErr = err as ConfigError;
    expect(configErr.variable).toBe('PTERODACTYL_PANEL_URL');
    expect(configErr.message).toContain('PTERODACTYL_PANEL_URL');
    expect(configErr.message).toContain('https://');
  });

  it('throws an actionable ConfigError when API_KEY is missing', () => {
    const err = (() => {
      try {
        loadConfig({ PTERODACTYL_PANEL_URL: 'https://panel.example.com' });
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(ConfigError);
    const configErr = err as ConfigError;
    expect(configErr.variable).toBe('PTERODACTYL_API_KEY');
    expect(configErr.message).toContain('API Credentials');
  });

  it('treats an empty or whitespace-only value as missing', () => {
    expect(() => loadConfig({ ...MINIMAL, PTERODACTYL_API_KEY: '   ' })).toThrow(ConfigError);
  });

  it('rejects a panel URL without a scheme', () => {
    expect(() => loadConfig({ ...MINIMAL, PTERODACTYL_PANEL_URL: 'panel.example.com' })).toThrow(
      ConfigError,
    );
  });
});

describe('loadConfig defaults', () => {
  it('applies every documented default', () => {
    const config = loadConfig(MINIMAL);

    expect(config.panelUrl).toBe('https://panel.example.com');
    expect(config.apiKey).toBe('ptlc_testkey');
    expect(config.defaultServer).toBeUndefined();
    expect(config.readOnly).toBe(false);
    expect(config.allowedServers).toEqual([]);
    expect(config.allowDelete).toBe(false);
    expect(config.allowKill).toBe(false);
    expect(config.protectedPaths).toEqual([...DEFAULT_PROTECTED_PATHS]);
    expect(config.maxMutations).toBe(DEFAULT_MAX_MUTATIONS);
    expect(config.autoBackup).toBe(true);
    expect(config.maxReadBytes).toBe(DEFAULT_MAX_READ_BYTES);
    expect(config.auditLog).toBe(join(homedir(), '.pterodactyl-mcp', 'audit.jsonl'));
  });

  it('strips trailing slashes from the panel URL', () => {
    expect(loadConfig({ ...MINIMAL, PTERODACTYL_PANEL_URL: 'https://p.example.com///' }).panelUrl).toBe(
      'https://p.example.com',
    );
  });

  it('protects the Minecraft worlds by default', () => {
    const config = loadConfig(MINIMAL);
    expect(config.protectedPaths).toContain('world/**');
    expect(config.protectedPaths).toContain('server.properties');
    expect(config.protectedPaths).toContain('banned-*.json');
  });

  it('returns a frozen object', () => {
    const config = loadConfig(MINIMAL);
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe('loadConfig boolean parsing', () => {
  for (const value of ['1', 'true', 'TRUE', 'Yes', 'on', 'ON']) {
    it(`parses "${value}" as true`, () => {
      expect(loadConfig({ ...MINIMAL, PTERODACTYL_READ_ONLY: value }).readOnly).toBe(true);
    });
  }

  for (const value of ['0', 'false', 'FALSE', 'no', 'Off']) {
    it(`parses "${value}" as false`, () => {
      expect(loadConfig({ ...MINIMAL, PTERODACTYL_AUTO_BACKUP: value }).autoBackup).toBe(false);
    });
  }

  it('rejects a value that is neither', () => {
    const err = (() => {
      try {
        loadConfig({ ...MINIMAL, PTERODACTYL_ALLOW_KILL: 'maybe' });
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).variable).toBe('PTERODACTYL_ALLOW_KILL');
    expect((err as ConfigError).message).toContain('maybe');
  });
});

describe('loadConfig allowedServers', () => {
  it('defaults to the default server when the allowlist is unset', () => {
    const config = loadConfig({ ...MINIMAL, PTERODACTYL_DEFAULT_SERVER: '1a2b3c4d' });
    expect(config.defaultServer).toBe('1a2b3c4d');
    expect(config.allowedServers).toEqual(['1a2b3c4d']);
  });

  it('defaults to an empty allowlist when there is no default server either', () => {
    expect(loadConfig(MINIMAL).allowedServers).toEqual([]);
  });

  it('parses a comma-separated allowlist, trimming whitespace', () => {
    const config = loadConfig({
      ...MINIMAL,
      PTERODACTYL_DEFAULT_SERVER: '1a2b3c4d',
      PTERODACTYL_ALLOWED_SERVERS: ' 1a2b3c4d , abcd1234,,  efef5656 ',
    });
    expect(config.allowedServers).toEqual(['1a2b3c4d', 'abcd1234', 'efef5656']);
  });

  it('lets an explicit allowlist exclude the default server', () => {
    const config = loadConfig({
      ...MINIMAL,
      PTERODACTYL_DEFAULT_SERVER: '1a2b3c4d',
      PTERODACTYL_ALLOWED_SERVERS: 'abcd1234',
    });
    expect(config.allowedServers).toEqual(['abcd1234']);
  });
});

describe('loadConfig numeric parsing', () => {
  it('parses max mutations and max read bytes', () => {
    const config = loadConfig({
      ...MINIMAL,
      PTERODACTYL_MAX_MUTATIONS: '5',
      PTERODACTYL_MAX_READ_BYTES: '1024',
    });
    expect(config.maxMutations).toBe(5);
    expect(config.maxReadBytes).toBe(1024);
  });

  it('rejects a non-integer or negative value', () => {
    expect(() => loadConfig({ ...MINIMAL, PTERODACTYL_MAX_MUTATIONS: 'lots' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...MINIMAL, PTERODACTYL_MAX_MUTATIONS: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...MINIMAL, PTERODACTYL_MAX_READ_BYTES: '2.5' })).toThrow(ConfigError);
  });
});

describe('audit log path', () => {
  it('expands a leading tilde to the home directory', () => {
    const config = loadConfig({ ...MINIMAL, PTERODACTYL_AUDIT_LOG: '~/logs/ptero/audit.jsonl' });
    expect(config.auditLog).toBe(join(homedir(), 'logs', 'ptero', 'audit.jsonl'));
    expect(config.auditLog).not.toContain('~');
  });

  it('expands a bare tilde', () => {
    expect(expandTilde('~', '/home/alex')).toBe('/home/alex');
    expect(expandTilde('~/x/y', '/home/alex')).toBe('/home/alex/x/y');
  });

  it('leaves an absolute path alone', () => {
    const config = loadConfig({ ...MINIMAL, PTERODACTYL_AUDIT_LOG: '/var/log/ptero.jsonl' });
    expect(config.auditLog).toBe('/var/log/ptero.jsonl');
  });

  it('does not expand a tilde that is not a path prefix', () => {
    expect(expandTilde('/tmp/back~up.jsonl', '/home/alex')).toBe('/tmp/back~up.jsonl');
  });

  it('resolves a relative path to an absolute one', () => {
    const config = loadConfig({ ...MINIMAL, PTERODACTYL_AUDIT_LOG: 'audit.jsonl' });
    expect(config.auditLog.startsWith('/')).toBe(true);
    expect(config.auditLog.endsWith('audit.jsonl')).toBe(true);
  });
});

describe('protected paths override', () => {
  it('replaces the defaults entirely when set', () => {
    const config = loadConfig({ ...MINIMAL, PTERODACTYL_PROTECTED_PATHS: 'secret/**, other.txt' });
    expect(config.protectedPaths).toEqual(['secret/**', 'other.txt']);
  });
});
