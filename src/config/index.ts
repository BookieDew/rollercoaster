import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  database: {
    url: string;
    client: 'sqlite3' | 'pg';
  };
  api: {
    keySecret: string;
    hmacSecret: string;
    hmacMaxSkewMs: number;
    hmacReplayCacheSize: number;
  };
  ride: {
    minDurationSeconds: number;
    maxDurationSeconds: number;
  };
  server: {
    port: number;
    env: 'development' | 'production' | 'test';
  };
}

function parseDbUrl(url: string): { client: 'sqlite3' | 'pg'; connectionString: string } {
  if (url.startsWith('sqlite://')) {
    return { client: 'sqlite3', connectionString: url.replace('sqlite://', '') };
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return { client: 'pg', connectionString: url };
  }
  throw new Error(`Unsupported database URL format: ${url}`);
}

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getNodeEnv(): 'development' | 'production' | 'test' {
  const env = process.env.NODE_ENV ?? 'development';
  if (env !== 'development' && env !== 'production' && env !== 'test') {
    throw new Error(`Invalid NODE_ENV: ${env}. Must be development, production, or test.`);
  }
  return env;
}

const databaseUrl = getEnvVar('DATABASE_URL', 'sqlite://./dev.db');
const dbConfig = parseDbUrl(databaseUrl);
const apiKeySecret = getEnvVar('API_KEY_SECRET', 'dev-secret-key');
const hmacSecret = getEnvVar('HMAC_SECRET', apiKeySecret);
const hmacMaxSkewMs = parseInt(getEnvVar('HMAC_MAX_SKEW_MS', '300000'), 10);
const hmacReplayCacheSize = parseInt(getEnvVar('HMAC_REPLAY_CACHE_SIZE', '10000'), 10);
const rideMinDurationSeconds = parseFloat(getEnvVar('RIDE_MIN_DURATION_SECONDS', '0.5'));
const rideMaxDurationSeconds = parseFloat(getEnvVar('RIDE_MAX_DURATION_SECONDS', '10'));

export const config: Config = {
  database: {
    url: dbConfig.connectionString,
    client: dbConfig.client,
  },
  api: {
    keySecret: apiKeySecret,
    hmacSecret,
    hmacMaxSkewMs,
    hmacReplayCacheSize,
  },
  ride: {
    minDurationSeconds: rideMinDurationSeconds,
    maxDurationSeconds: rideMaxDurationSeconds,
  },
  server: {
    port: parseInt(getEnvVar('PORT', '3000'), 10),
    env: getNodeEnv(),
  },
};

export default config;
