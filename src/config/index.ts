import dotenv from 'dotenv';
import type { Knex } from 'knex';
import { z } from 'zod';

// Tests never read a developer's .env file, so test runs stay deterministic.
// Every other environment loads .env without overriding variables already set.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}

export type NodeEnv = 'development' | 'production' | 'test';
export type DatabaseClient = 'sqlite3' | 'pg';

export interface Config {
  database: {
    /** SQLite file path (or :memory:) for sqlite3, connection string for pg. */
    url: string;
    client: DatabaseClient;
    /** Connection pool, applied to PostgreSQL only. */
    pool: { min: number; max: number };
    /** TLS for PostgreSQL connections. */
    ssl: boolean;
    sslRejectUnauthorized: boolean;
  };
  api: {
    keySecret: string;
    adminKeySecret: string;
    hmacSecret: string;
    hmacMaxSkewMs: number;
    hmacReplayCacheSize: number;
  };
  ride: {
    minDurationSeconds: number;
    maxDurationSeconds: number;
    minCrashSeconds: number;
  };
  server: {
    port: number;
    env: NodeEnv;
    /** Serve the local demo UI at /demo. */
    demoUiEnabled: boolean;
  };
  rewards: {
    /** Seconds between in-process expiry runs; 0 disables the interval. */
    expiryIntervalSeconds: number;
    /**
     * Seconds an unlocked ride must have been over (crashed or ended) before the
     * expiry job moves its ENTERED reward to EXPIRED.
     */
    rideExpiryGraceSeconds: number;
  };
}

/** Development/test API key; it is pre-filled in the demo and refused in production. */
export const DEV_DEFAULT_API_KEY = 'dev-secret-key';
export const MIN_PRODUCTION_SECRET_LENGTH = 32;

/**
 * Values that can never be production secrets: the development default plus the
 * placeholders shipped in .env.example (current and earlier versions).
 */
export const KNOWN_INSECURE_SECRETS: ReadonlySet<string> = new Set([
  DEV_DEFAULT_API_KEY,
  'change-me-api-key-secret-at-least-32-chars',
  'change-me-admin-api-key-secret-at-least-32-chars',
  'change-me-hmac-secret-at-least-32-characters',
  'your-secret-key-here',
  'your-admin-key-here',
  'your-hmac-secret-here',
]);

const DEFAULT_DATABASE_URL = 'sqlite://./dev.db';
const SECRET_NAMES = ['API_KEY_SECRET', 'ADMIN_API_KEY_SECRET', 'HMAC_SECRET'] as const;
type SecretName = (typeof SECRET_NAMES)[number];

/** Thrown when the environment is invalid. Lists every problem, never secret values. */
export class ConfigError extends Error {
  declare readonly issues: readonly string[];

  constructor(issues: string[]) {
    const count = `${issues.length} problem${issues.length === 1 ? '' : 's'}`;
    super(`Invalid configuration (${count}):\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    // Non-enumerable, so an uncaught startup error prints the list only once.
    Object.defineProperty(this, 'issues', { value: [...issues], enumerable: false });
  }
}

const wholeNumber = (min: number, max: number) => z
  .string()
  .trim()
  .regex(/^\d+$/, 'must be a whole number')
  .transform(Number)
  .pipe(z.number().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`));

const finiteNumber = z
  .string()
  .trim()
  .min(1, 'must be a number')
  .transform(Number)
  .pipe(z.number({ invalid_type_error: 'must be a number' }).finite('must be a finite number'));

const booleanFlag = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => ['true', 'false', '1', '0'].includes(value), 'must be true or false')
  .transform((value) => value === 'true' || value === '1');

/**
 * Parses one variable (or its default). Records a message that names the variable
 * but never echoes its value, and returns undefined when invalid.
 */
function parseVar<T>(
  issues: string[],
  name: string,
  raw: string,
  schema: z.ZodType<T, z.ZodTypeDef, string>
): T | undefined {
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  issues.push(`${name} ${result.error.issues[0]?.message ?? 'is invalid'}`);
  return undefined;
}

function parseNodeEnv(raw: string | undefined, issues: string[]): NodeEnv | undefined {
  const value = raw ?? 'development';
  if (value === 'development' || value === 'production' || value === 'test') {
    return value;
  }
  issues.push(`Invalid NODE_ENV "${value}": must be development, production, or test`);
  return undefined;
}

function parseDatabaseUrl(
  url: string,
  issues: string[]
): { client: DatabaseClient; url: string } | undefined {
  if (url.startsWith('sqlite://')) {
    const filename = url.slice('sqlite://'.length);
    if (filename.trim().length === 0) {
      issues.push('DATABASE_URL must include a SQLite file path, e.g. sqlite://./dev.db');
      return undefined;
    }
    return { client: 'sqlite3', url: filename };
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return { client: 'pg', url };
  }
  // Only the scheme is echoed: the rest of a URL can contain credentials.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1];
  issues.push(
    `DATABASE_URL: Unsupported database URL format${scheme ? ` (scheme "${scheme}")` : ''}; `
    + 'use sqlite:// or postgres(ql)://'
  );
  return undefined;
}

/**
 * Secrets may never be empty. In production all three must be set explicitly, be
 * long, differ from each other and from known defaults/placeholders. Development
 * and test fall back to the dev key, with admin and HMAC secrets defaulting to it.
 */
function parseSecrets(
  env: NodeJS.ProcessEnv,
  nodeEnv: NodeEnv | undefined,
  issues: string[]
): Record<SecretName, string> {
  const raw: Record<SecretName, string | undefined> = {
    API_KEY_SECRET: env.API_KEY_SECRET,
    ADMIN_API_KEY_SECRET: env.ADMIN_API_KEY_SECRET,
    HMAC_SECRET: env.HMAC_SECRET,
  };

  for (const name of SECRET_NAMES) {
    const value = raw[name];
    if (value === undefined) {
      if (nodeEnv === 'production') {
        issues.push(`${name} is required in production`);
      }
      continue;
    }
    if (value.trim().length === 0) {
      issues.push(`${name} must not be empty`);
      continue;
    }
    if (nodeEnv !== 'production') {
      continue;
    }
    if (value.length < MIN_PRODUCTION_SECRET_LENGTH) {
      issues.push(`${name} must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`);
    }
    if (KNOWN_INSECURE_SECRETS.has(value.trim())) {
      issues.push(`${name} must not be the development default or an .env.example placeholder`);
    }
  }

  if (nodeEnv === 'production') {
    for (let i = 0; i < SECRET_NAMES.length; i++) {
      for (let j = i + 1; j < SECRET_NAMES.length; j++) {
        const a = raw[SECRET_NAMES[i]];
        const b = raw[SECRET_NAMES[j]];
        if (a !== undefined && a.trim().length > 0 && a === b) {
          issues.push(`${SECRET_NAMES[i]} and ${SECRET_NAMES[j]} must be different in production`);
        }
      }
    }
  }

  const keySecret = raw.API_KEY_SECRET ?? DEV_DEFAULT_API_KEY;
  return {
    API_KEY_SECRET: keySecret,
    ADMIN_API_KEY_SECRET: raw.ADMIN_API_KEY_SECRET ?? keySecret,
    HMAC_SECRET: raw.HMAC_SECRET ?? keySecret,
  };
}

/**
 * Validates an environment and builds the service configuration. Throws one
 * ConfigError that lists every problem found.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const issues: string[] = [];
  const nodeEnv = parseNodeEnv(env.NODE_ENV, issues);

  if (env.DATABASE_URL === undefined && nodeEnv === 'production') {
    issues.push('DATABASE_URL is required in production');
  }
  const database = parseDatabaseUrl(env.DATABASE_URL ?? DEFAULT_DATABASE_URL, issues);
  const poolMin = parseVar(issues, 'DATABASE_POOL_MIN', env.DATABASE_POOL_MIN ?? '2', wholeNumber(0, 1000));
  const poolMax = parseVar(issues, 'DATABASE_POOL_MAX', env.DATABASE_POOL_MAX ?? '10', wholeNumber(1, 1000));
  if (poolMin !== undefined && poolMax !== undefined && poolMin > poolMax) {
    issues.push('DATABASE_POOL_MIN must be less than or equal to DATABASE_POOL_MAX');
  }
  const ssl = parseVar(issues, 'DATABASE_SSL', env.DATABASE_SSL ?? 'false', booleanFlag);
  const sslRejectUnauthorized = parseVar(
    issues, 'DATABASE_SSL_REJECT_UNAUTHORIZED', env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? 'true', booleanFlag
  );

  const secrets = parseSecrets(env, nodeEnv, issues);
  const hmacMaxSkewMs = parseVar(
    issues, 'HMAC_MAX_SKEW_MS', env.HMAC_MAX_SKEW_MS ?? '300000', wholeNumber(1, Number.MAX_SAFE_INTEGER)
  );
  const hmacReplayCacheSize = parseVar(
    issues, 'HMAC_REPLAY_CACHE_SIZE', env.HMAC_REPLAY_CACHE_SIZE ?? '10000', wholeNumber(1, Number.MAX_SAFE_INTEGER)
  );

  const minDuration = parseVar(issues, 'RIDE_MIN_DURATION_SECONDS', env.RIDE_MIN_DURATION_SECONDS ?? '2', finiteNumber);
  const maxDuration = parseVar(issues, 'RIDE_MAX_DURATION_SECONDS', env.RIDE_MAX_DURATION_SECONDS ?? '15', finiteNumber);
  const minCrash = parseVar(issues, 'RIDE_MIN_CRASH_SECONDS', env.RIDE_MIN_CRASH_SECONDS ?? '2', finiteNumber);
  if (minDuration !== undefined && minDuration <= 0) {
    issues.push('RIDE_MIN_DURATION_SECONDS must be greater than 0');
  }
  if (minDuration !== undefined && maxDuration !== undefined && minDuration > maxDuration) {
    issues.push('RIDE_MIN_DURATION_SECONDS must be less than or equal to RIDE_MAX_DURATION_SECONDS');
  }
  if (minCrash !== undefined && minCrash < 0) {
    issues.push('RIDE_MIN_CRASH_SECONDS must be at least 0');
  }
  if (minCrash !== undefined && maxDuration !== undefined && minCrash > maxDuration) {
    issues.push('RIDE_MIN_CRASH_SECONDS must be less than or equal to RIDE_MAX_DURATION_SECONDS');
  }

  const port = parseVar(issues, 'PORT', env.PORT ?? '3000', wholeNumber(1, 65535));
  const demoUiEnabled = parseVar(
    issues, 'DEMO_UI_ENABLED', env.DEMO_UI_ENABLED ?? String(nodeEnv !== 'production'), booleanFlag
  );

  // setInterval cannot wait longer than 2^31-1 ms.
  const expiryIntervalSeconds = parseVar(
    issues, 'REWARD_EXPIRY_INTERVAL_SECONDS', env.REWARD_EXPIRY_INTERVAL_SECONDS ?? '300', wholeNumber(0, 2_147_483)
  );

  // Up to 365 days, the longest reward validity.
  const rideExpiryGraceSeconds = parseVar(
    issues, 'RIDE_EXPIRY_GRACE_SECONDS', env.RIDE_EXPIRY_GRACE_SECONDS ?? '900', wholeNumber(0, 31_536_000)
  );

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  // Every undefined value above recorded an issue, so all values are set here.
  return {
    database: {
      url: database!.url,
      client: database!.client,
      pool: { min: poolMin!, max: poolMax! },
      ssl: ssl!,
      sslRejectUnauthorized: sslRejectUnauthorized!,
    },
    api: {
      keySecret: secrets.API_KEY_SECRET,
      adminKeySecret: secrets.ADMIN_API_KEY_SECRET,
      hmacSecret: secrets.HMAC_SECRET,
      hmacMaxSkewMs: hmacMaxSkewMs!,
      hmacReplayCacheSize: hmacReplayCacheSize!,
    },
    ride: {
      minDurationSeconds: minDuration!,
      maxDurationSeconds: maxDuration!,
      minCrashSeconds: minCrash!,
    },
    server: {
      port: port!,
      env: nodeEnv!,
      demoUiEnabled: demoUiEnabled!,
    },
    rewards: {
      expiryIntervalSeconds: expiryIntervalSeconds!,
      rideExpiryGraceSeconds: rideExpiryGraceSeconds!,
    },
  };
}

/**
 * Knex settings for the application and the knex CLI. The client follows
 * DATABASE_URL in every environment except test, which always uses a private
 * in-memory SQLite database (integration tests wipe tables).
 * Migrations/seeds point at the TypeScript sources for the development workflow;
 * production migrations run from compiled JavaScript via `npm run migrate:prod`.
 */
export function buildKnexConfig(cfg: Config): Knex.Config {
  const shared = {
    migrations: { directory: './migrations', extension: 'ts' },
    seeds: { directory: './seeds', extension: 'ts' },
  };

  if (cfg.server.env === 'test') {
    return { ...shared, client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true };
  }

  if (cfg.database.client === 'sqlite3') {
    return { ...shared, client: 'sqlite3', connection: { filename: cfg.database.url }, useNullAsDefault: true };
  }

  return {
    ...shared,
    client: 'pg',
    connection: {
      connectionString: cfg.database.url,
      ...(cfg.database.ssl ? { ssl: { rejectUnauthorized: cfg.database.sslRejectUnauthorized } } : {}),
    },
    pool: { ...cfg.database.pool },
  };
}

export const config: Config = loadConfig(process.env);

export default config;
