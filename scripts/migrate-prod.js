#!/usr/bin/env node
'use strict';

/**
 * Applies pending database migrations from the compiled build, using production
 * dependencies only (no ts-node or TypeScript):
 *
 *   npm run build          # emits dist/ and dist/migrations/*.js
 *   npm run migrate:prod
 *
 * It loads the same validated configuration as the server (dist/config), so
 * NODE_ENV, DATABASE_URL and, in production, the API secrets must be set.
 *
 * Only dist/migrations/*.js files are loaded (never .d.ts or .map files). Each
 * migration is recorded under its source name (NNN_name.ts), the same name the
 * development workflow (`npm run migrate`) records, so a database migrated by
 * either runner stays compatible with the other.
 */
const fs = require('node:fs');
const path = require('node:path');

const distDir = path.resolve(__dirname, '..', 'dist');
const migrationsDir = path.join(distDir, 'migrations');
const connectionModule = path.join(distDir, 'db', 'connection.js');

const migrationSource = {
  async getMigrations() {
    const files = await fs.promises.readdir(migrationsDir);
    return files.filter((file) => file.endsWith('.js')).sort();
  },
  getMigrationName(file) {
    return file.replace(/\.js$/, '.ts');
  },
  async getMigration(file) {
    return require(path.join(migrationsDir, file));
  },
};

async function main() {
  if (!fs.existsSync(connectionModule) || !fs.existsSync(migrationsDir)) {
    throw new Error('compiled build not found in dist/; run `npm run build` first');
  }

  const db = require(connectionModule).default;
  try {
    const [batch, applied] = await db.migrate.latest({ migrationSource });
    if (applied.length === 0) {
      console.log('migrate:prod: already up to date');
    } else {
      console.log(`migrate:prod: batch ${batch} applied ${applied.length} migration(s):`);
      for (const name of applied) {
        console.log(`  - ${name}`);
      }
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(`migrate:prod failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
