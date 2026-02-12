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
