// Test setup file
process.env.NODE_ENV = 'test';
process.env.API_KEY_SECRET = 'test-api-key';
process.env.HMAC_SECRET = 'test-hmac-secret';
process.env.HMAC_MAX_SKEW_MS = '300000';
process.env.HMAC_REPLAY_CACHE_SIZE = '1000';
process.env.RIDE_MIN_DURATION_SECONDS = '0.5';
process.env.RIDE_MAX_DURATION_SECONDS = '10';
process.env.DATABASE_URL = 'sqlite://:memory:';
