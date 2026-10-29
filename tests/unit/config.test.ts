import fs from 'fs';
import path from 'path';
import request from 'supertest';
import {
  buildKnexConfig,
  ConfigError,
  DEV_DEFAULT_API_KEY,
  KNOWN_INSECURE_SECRETS,
  loadConfig as loadConfigFromEnv,
} from '../../src/config';

describe('config module', () => {
  const originalEnv = process.env;

  function loadConfig() {
    let loaded: typeof import('../../src/config').config;
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      loaded = require('../../src/config').config;
    });
    // TypeScript narrow
    return loaded!;
  }

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      DATABASE_URL: 'sqlite://:memory:',
      API_KEY_SECRET: 'test-api-key',
      PORT: '3000',
    };
    delete process.env.ADMIN_API_KEY_SECRET;
    delete process.env.HMAC_SECRET;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('parses sqlite URL and applies default admin/hmac secrets', () => {
    const config = loadConfig();
    expect(config.database.client).toBe('sqlite3');
    expect(config.database.url).toBe(':memory:');
    expect(config.api.adminKeySecret).toBe('test-api-key');
    expect(config.api.hmacSecret).toBe('test-api-key');
  });

  it('parses postgres URL', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
    const config = loadConfig();
    expect(config.database.client).toBe('pg');
    expect(config.database.url).toContain('postgres://user:pass');
  });

  it('supports custom admin and hmac secrets', () => {
    process.env.ADMIN_API_KEY_SECRET = 'admin-key';
    process.env.HMAC_SECRET = 'hmac-key';
    const config = loadConfig();
    expect(config.api.adminKeySecret).toBe('admin-key');
    expect(config.api.hmacSecret).toBe('hmac-key');
  });

  it('throws on unsupported DB URL', () => {
    process.env.DATABASE_URL = 'mysql://localhost/db';
    expect(() => loadConfig()).toThrow('Unsupported database URL format');
  });

  it('throws on invalid NODE_ENV', () => {
    process.env.NODE_ENV = 'staging';
    expect(() => loadConfig()).toThrow('Invalid NODE_ENV');
  });
});

// Distinct, long, non-placeholder secrets for production-mode tests.
const STRONG = {
  API_KEY_SECRET: 'k1-4f9c2a7e1b3d5f60718293a4b5c6d7e8f9',
  ADMIN_API_KEY_SECRET: 'k2-9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a',
  HMAC_SECRET: 'k3-0a1b2c3d4e5f60718293a4b5c6d7e8f9aa',
};

function prodEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: 'sqlite://./prod.sqlite',
    ...STRONG,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function configIssues(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfigFromEnv(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return [...(error as ConfigError).issues];
  }
  throw new Error('expected loadConfigFromEnv to throw a ConfigError');
}

describe('loadConfig validation', () => {
  describe('production secrets fail closed', () => {
    it('accepts explicit, long, distinct secrets and disables the demo by default', () => {
      const config = loadConfigFromEnv(prodEnv());
      expect(config.server.env).toBe('production');
      expect(config.server.demoUiEnabled).toBe(false);
      expect(config.api.keySecret).toBe(STRONG.API_KEY_SECRET);
      expect(config.api.adminKeySecret).toBe(STRONG.ADMIN_API_KEY_SECRET);
      expect(config.api.hmacSecret).toBe(STRONG.HMAC_SECRET);
      expect(config.database).toEqual({
        url: './prod.sqlite',
        client: 'sqlite3',
        pool: { min: 2, max: 10 },
        ssl: false,
        sslRejectUnauthorized: true,
      });
    });

    it('lists every missing secret and DATABASE_URL in one error', () => {
      const issues = configIssues({ NODE_ENV: 'production' });
      expect(issues).toEqual(expect.arrayContaining([
        'DATABASE_URL is required in production',
        'API_KEY_SECRET is required in production',
        'ADMIN_API_KEY_SECRET is required in production',
        'HMAC_SECRET is required in production',
      ]));
      expect(issues).toHaveLength(4);
    });

    it('does not fall back to the dev key or reuse API_KEY_SECRET in production', () => {
      const issues = configIssues(prodEnv({ ADMIN_API_KEY_SECRET: undefined, HMAC_SECRET: undefined }));
      expect(issues).toEqual([
        'ADMIN_API_KEY_SECRET is required in production',
        'HMAC_SECRET is required in production',
      ]);
    });

    it('rejects short secrets', () => {
      const issues = configIssues(prodEnv({ HMAC_SECRET: 'x'.repeat(31) }));
      expect(issues).toEqual(['HMAC_SECRET must be at least 32 characters in production']);
      expect(() => loadConfigFromEnv(prodEnv({ HMAC_SECRET: 'x'.repeat(32) }))).not.toThrow();
    });

    it('rejects duplicate secrets pairwise', () => {
      const shared = 'shared-secret-0123456789abcdef0123456789';
      expect(configIssues(prodEnv({ API_KEY_SECRET: shared, ADMIN_API_KEY_SECRET: shared }))).toEqual([
        'API_KEY_SECRET and ADMIN_API_KEY_SECRET must be different in production',
      ]);
      expect(configIssues(prodEnv({ API_KEY_SECRET: shared, HMAC_SECRET: shared }))).toEqual([
        'API_KEY_SECRET and HMAC_SECRET must be different in production',
      ]);
      expect(configIssues(prodEnv({ ADMIN_API_KEY_SECRET: shared, HMAC_SECRET: shared }))).toEqual([
        'ADMIN_API_KEY_SECRET and HMAC_SECRET must be different in production',
      ]);
      expect(configIssues(prodEnv({
        API_KEY_SECRET: shared, ADMIN_API_KEY_SECRET: shared, HMAC_SECRET: shared,
      }))).toHaveLength(3);
    });

    it('rejects the dev default key', () => {
      const issues = configIssues(prodEnv({ API_KEY_SECRET: DEV_DEFAULT_API_KEY }));
      expect(issues).toEqual([
        'API_KEY_SECRET must be at least 32 characters in production',
        'API_KEY_SECRET must not be the development default or an .env.example placeholder',
      ]);
    });

    it('rejects every secret placeholder shipped in .env.example', () => {
      const template = fs.readFileSync(path.join(__dirname, '../../.env.example'), 'utf8');
      const placeholders = [...template.matchAll(
        /^#?\s*(API_KEY_SECRET|ADMIN_API_KEY_SECRET|HMAC_SECRET)=(\S+)\s*$/gm
      )];
      expect(placeholders.map((match) => match[1]).sort()).toEqual(
        ['ADMIN_API_KEY_SECRET', 'API_KEY_SECRET', 'HMAC_SECRET']
      );
      for (const [, name, value] of placeholders) {
        expect(KNOWN_INSECURE_SECRETS.has(value)).toBe(true);
        expect(configIssues(prodEnv({ [name]: value }))).toContain(
          `${name} must not be the development default or an .env.example placeholder`
        );
      }
    });

    it('never includes secret values or database credentials in the error', () => {
      const leaked = 'tooShortSecretValue';
      let message = '';
      try {
        loadConfigFromEnv(prodEnv({
          API_KEY_SECRET: leaked,
          ADMIN_API_KEY_SECRET: leaked,
          HMAC_SECRET: DEV_DEFAULT_API_KEY,
          DATABASE_URL: 'mysql://operator:hunter2-db-password@db.internal/app',
        }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('Invalid configuration');
      expect(message).toContain('API_KEY_SECRET');
      expect(message).toContain('Unsupported database URL format (scheme "mysql")');
      expect(message).not.toContain(leaked);
      expect(message).not.toContain(DEV_DEFAULT_API_KEY);
      expect(message).not.toContain('hunter2');
      expect(message).not.toContain('operator');
    });
  });

  describe('secrets in every environment', () => {
    it.each(['development', 'test', 'production'])('rejects empty secrets when NODE_ENV=%s', (nodeEnv) => {
      const issues = configIssues({
        ...prodEnv(),
        NODE_ENV: nodeEnv,
        API_KEY_SECRET: '',
        ADMIN_API_KEY_SECRET: '   ',
        HMAC_SECRET: '',
      });
      expect(issues).toEqual(expect.arrayContaining([
        'API_KEY_SECRET must not be empty',
        'ADMIN_API_KEY_SECRET must not be empty',
        'HMAC_SECRET must not be empty',
      ]));
      expect(issues).toHaveLength(3);
    });

    it('keeps convenient defaults in development', () => {
      const config = loadConfigFromEnv({ NODE_ENV: 'development' });
      expect(config.api.keySecret).toBe(DEV_DEFAULT_API_KEY);
      expect(config.api.adminKeySecret).toBe(DEV_DEFAULT_API_KEY);
      expect(config.api.hmacSecret).toBe(DEV_DEFAULT_API_KEY);
      expect(config.database).toMatchObject({ client: 'sqlite3', url: './dev.db' });
      expect(config.server).toEqual({ port: 3000, env: 'development', demoUiEnabled: true });
      expect(config.api.hmacMaxSkewMs).toBe(300000);
      expect(config.api.hmacReplayCacheSize).toBe(10000);
      expect(config.ride).toEqual({ minDurationSeconds: 2, maxDurationSeconds: 15, minCrashSeconds: 2 });
    });

    it('defaults NODE_ENV to development', () => {
      expect(loadConfigFromEnv({}).server.env).toBe('development');
    });
  });

  describe('numeric values must be finite and in range', () => {
    it.each([
      ['PORT', 'abc', 'PORT must be a whole number'],
      ['PORT', '', 'PORT must be a whole number'],
      ['PORT', '80.5', 'PORT must be a whole number'],
      ['PORT', '-1', 'PORT must be a whole number'],
      ['PORT', '0', 'PORT must be at least 1'],
      ['PORT', '65536', 'PORT must be at most 65535'],
      ['HMAC_MAX_SKEW_MS', 'NaN', 'HMAC_MAX_SKEW_MS must be a whole number'],
      ['HMAC_MAX_SKEW_MS', '0', 'HMAC_MAX_SKEW_MS must be at least 1'],
      ['HMAC_MAX_SKEW_MS', '1e3', 'HMAC_MAX_SKEW_MS must be a whole number'],
      ['HMAC_MAX_SKEW_MS', '99999999999999999999', `HMAC_MAX_SKEW_MS must be at most ${Number.MAX_SAFE_INTEGER}`],
      ['HMAC_REPLAY_CACHE_SIZE', '0', 'HMAC_REPLAY_CACHE_SIZE must be at least 1'],
      ['HMAC_REPLAY_CACHE_SIZE', '1.5', 'HMAC_REPLAY_CACHE_SIZE must be a whole number'],
      ['RIDE_MIN_DURATION_SECONDS', 'NaN', 'RIDE_MIN_DURATION_SECONDS must be a number'],
      ['RIDE_MIN_DURATION_SECONDS', '', 'RIDE_MIN_DURATION_SECONDS must be a number'],
      ['RIDE_MAX_DURATION_SECONDS', 'Infinity', 'RIDE_MAX_DURATION_SECONDS must be a finite number'],
      ['RIDE_MIN_CRASH_SECONDS', 'soon', 'RIDE_MIN_CRASH_SECONDS must be a number'],
      ['DATABASE_POOL_MIN', 'x', 'DATABASE_POOL_MIN must be a whole number'],
      ['DATABASE_POOL_MAX', '0', 'DATABASE_POOL_MAX must be at least 1'],
    ])('rejects %s=%p', (name, value, expected) => {
      expect(configIssues({ NODE_ENV: 'development', [name]: value })).toEqual([expected]);
    });

    it('parses valid numeric values', () => {
      const config = loadConfigFromEnv({
        NODE_ENV: 'development',
        PORT: ' 8080 ',
        HMAC_MAX_SKEW_MS: '60000',
        HMAC_REPLAY_CACHE_SIZE: '1',
        RIDE_MIN_DURATION_SECONDS: '0.5',
        RIDE_MAX_DURATION_SECONDS: '0.5',
        RIDE_MIN_CRASH_SECONDS: '0',
      });
      expect(config.server.port).toBe(8080);
      expect(config.api.hmacMaxSkewMs).toBe(60000);
      expect(config.api.hmacReplayCacheSize).toBe(1);
      expect(config.ride).toEqual({ minDurationSeconds: 0.5, maxDurationSeconds: 0.5, minCrashSeconds: 0 });
    });

    it('enforces ride timing relationships', () => {
      expect(configIssues({
        NODE_ENV: 'development',
        RIDE_MIN_DURATION_SECONDS: '20',
        RIDE_MAX_DURATION_SECONDS: '10',
        RIDE_MIN_CRASH_SECONDS: '11',
      })).toEqual([
        'RIDE_MIN_DURATION_SECONDS must be less than or equal to RIDE_MAX_DURATION_SECONDS',
        'RIDE_MIN_CRASH_SECONDS must be less than or equal to RIDE_MAX_DURATION_SECONDS',
      ]);
      expect(configIssues({ NODE_ENV: 'development', RIDE_MIN_DURATION_SECONDS: '0' })).toEqual([
        'RIDE_MIN_DURATION_SECONDS must be greater than 0',
      ]);
      expect(configIssues({ NODE_ENV: 'development', RIDE_MIN_CRASH_SECONDS: '-1' })).toEqual([
        'RIDE_MIN_CRASH_SECONDS must be at least 0',
      ]);
      expect(configIssues({ NODE_ENV: 'development', DATABASE_POOL_MIN: '5', DATABASE_POOL_MAX: '2' })).toEqual([
        'DATABASE_POOL_MIN must be less than or equal to DATABASE_POOL_MAX',
      ]);
    });

    it('reports every problem together, including with an invalid NODE_ENV', () => {
      const issues = configIssues({
        NODE_ENV: 'staging',
        PORT: 'eighty',
        HMAC_MAX_SKEW_MS: 'NaN',
        RIDE_MAX_DURATION_SECONDS: 'Infinity',
        DEMO_UI_ENABLED: 'maybe',
      });
      expect(issues).toEqual([
        'Invalid NODE_ENV "staging": must be development, production, or test',
        'HMAC_MAX_SKEW_MS must be a whole number',
        'RIDE_MAX_DURATION_SECONDS must be a finite number',
        'PORT must be a whole number',
        'DEMO_UI_ENABLED must be true or false',
      ]);
      expect(() => loadConfigFromEnv({ NODE_ENV: 'staging', PORT: 'eighty' })).toThrow(
        /^Invalid configuration \(2 problems\):\n {2}- Invalid NODE_ENV/
      );
    });
  });

  describe('DEMO_UI_ENABLED', () => {
    it.each([
      ['development', undefined, true],
      ['test', undefined, true],
      ['production', undefined, false],
      ['production', 'true', true],
      ['production', '1', true],
      ['development', 'false', false],
      ['development', ' FALSE ', false],
      ['test', '0', false],
    ])('NODE_ENV=%s DEMO_UI_ENABLED=%p -> %p', (nodeEnv, flag, expected) => {
      const env = prodEnv({ NODE_ENV: nodeEnv, DEMO_UI_ENABLED: flag });
      expect(loadConfigFromEnv(env).server.demoUiEnabled).toBe(expected);
    });

    it.each(['', 'yes', 'on'])('rejects DEMO_UI_ENABLED=%p', (flag) => {
      expect(configIssues({ NODE_ENV: 'development', DEMO_UI_ENABLED: flag })).toEqual([
        'DEMO_UI_ENABLED must be true or false',
      ]);
    });
  });

  describe('database settings', () => {
    it('requires a SQLite file path', () => {
      expect(configIssues({ NODE_ENV: 'development', DATABASE_URL: 'sqlite://' })).toEqual([
        'DATABASE_URL must include a SQLite file path, e.g. sqlite://./dev.db',
      ]);
    });

    it('rejects a URL without a scheme', () => {
      expect(configIssues({ NODE_ENV: 'development', DATABASE_URL: './dev.db' })).toEqual([
        'DATABASE_URL: Unsupported database URL format; use sqlite:// or postgres(ql)://',
      ]);
    });

    it('reads PostgreSQL pool and TLS settings', () => {
      const config = loadConfigFromEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://app@db.internal/app',
        DATABASE_POOL_MIN: '0',
        DATABASE_POOL_MAX: '4',
        DATABASE_SSL: 'true',
        DATABASE_SSL_REJECT_UNAUTHORIZED: 'false',
      });
      expect(config.database).toEqual({
        url: 'postgresql://app@db.internal/app',
        client: 'pg',
        pool: { min: 0, max: 4 },
        ssl: true,
        sslRejectUnauthorized: false,
      });
    });
  });
});

describe('buildKnexConfig', () => {
  it('chooses the client from DATABASE_URL, not NODE_ENV', () => {
    const sqliteInProduction = buildKnexConfig(loadConfigFromEnv(prodEnv()));
    expect(sqliteInProduction).toMatchObject({
      client: 'sqlite3',
      connection: { filename: './prod.sqlite' },
      useNullAsDefault: true,
      migrations: { directory: './migrations', extension: 'ts' },
      seeds: { directory: './seeds', extension: 'ts' },
    });

    const pgInDevelopment = buildKnexConfig(loadConfigFromEnv({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://app@db.internal/app',
    }));
    expect(pgInDevelopment).toMatchObject({
      client: 'pg',
      connection: { connectionString: 'postgres://app@db.internal/app' },
      pool: { min: 2, max: 10 },
    });
    expect((pgInDevelopment.connection as Record<string, unknown>).ssl).toBeUndefined();
  });

  it('passes PostgreSQL TLS settings through', () => {
    const knexConfig = buildKnexConfig(loadConfigFromEnv({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://app@db.internal/app',
      DATABASE_SSL: 'true',
    }));
    expect(knexConfig.connection).toEqual({
      connectionString: 'postgres://app@db.internal/app',
      ssl: { rejectUnauthorized: true },
    });
  });

  it('always uses in-memory SQLite in the test environment', () => {
    const knexConfig = buildKnexConfig(loadConfigFromEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'sqlite://./dev.db',
    }));
    expect(knexConfig).toMatchObject({ client: 'sqlite3', connection: { filename: ':memory:' } });
  });
});

describe('database connection module', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  function pgInstalled(): boolean {
    try {
      require.resolve('pg');
      return true;
    } catch {
      return false;
    }
  }

  (pgInstalled() ? it.skip : it)('fails with a clear message when a postgres URL is used without pg', () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://app:pw@127.0.0.1:1/app',
    };
    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line global-require
        require('../../src/db/connection');
      });
    }).toThrow(/"pg" driver is not installed.*npm install pg/s);
  });
});

describe('DEMO_UI_ENABLED gating of /demo', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  async function demoStatus(env: Record<string, string | undefined>): Promise<number> {
    process.env = { ...originalEnv, DATABASE_URL: 'sqlite://:memory:' };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    let app!: import('express').Express;
    let db!: import('knex').Knex;
    // Outside NODE_ENV=test the config module loads .env; keep these tests hermetic.
    jest.doMock('dotenv', () => ({ config: jest.fn() }));
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line global-require
        app = require('../../src/index').app;
        // eslint-disable-next-line global-require
        db = require('../../src/db/connection').default;
      });
    } finally {
      jest.dontMock('dotenv');
    }
    try {
      const res = await request(app).get('/demo/');
      if (res.status === 200) {
        expect(res.text).toContain('<html');
      }
      return res.status;
    } finally {
      await db.destroy();
    }
  }

  it('serves /demo by default outside production', async () => {
    expect(await demoStatus({ NODE_ENV: 'test', DEMO_UI_ENABLED: undefined })).toBe(200);
  });

  it('hides /demo when DEMO_UI_ENABLED=false', async () => {
    expect(await demoStatus({ NODE_ENV: 'test', DEMO_UI_ENABLED: 'false' })).toBe(404);
  });

  it('hides /demo by default in production', async () => {
    expect(await demoStatus({ ...STRONG, NODE_ENV: 'production', DEMO_UI_ENABLED: undefined })).toBe(404);
  });

  it('serves /demo in production only when explicitly enabled', async () => {
    expect(await demoStatus({ ...STRONG, NODE_ENV: 'production', DEMO_UI_ENABLED: 'true' })).toBe(200);
  });
});

describe('sample seed', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('refuses to run when NODE_ENV=production', async () => {
    // eslint-disable-next-line global-require
    const { seed } = require('../../seeds/001_sample_profile');
    const knex = jest.fn(() => {
      throw new Error('the seed must not touch the database');
    });
    process.env.NODE_ENV = 'production';
    await expect(seed(knex)).rejects.toThrow('Refusing to run seeds with NODE_ENV=production');
    expect(knex).not.toHaveBeenCalled();
  });
});
