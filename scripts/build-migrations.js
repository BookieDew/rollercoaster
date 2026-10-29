#!/usr/bin/env node
'use strict';

/**
 * Compiles migrations/*.ts to dist/migrations/*.js for `npm run migrate:prod`.
 * Runs as part of `npm run build` (TypeScript is a build-time dependency only).
 *
 * Emits JavaScript only: no .d.ts or source-map files that a migration loader
 * could mistake for migrations. dist/migrations is recreated on every build, so a
 * removed or renamed migration can never linger in a production artifact.
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'migrations');
const outDir = path.join(root, 'dist', 'migrations');
const tsconfigPath = path.join(root, 'tsconfig.build.json');

const formatHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => root,
  getNewLine: () => '\n',
};

function fail(diagnostics) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost));
  process.exit(1);
}

const sources = fs.readdirSync(sourceDir)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  .sort()
  .map((file) => path.join(sourceDir, file));

if (sources.length === 0) {
  console.error(`build-migrations: no migrations found in ${sourceDir}`);
  process.exit(1);
}

const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
if (configFile.error) {
  fail([configFile.error]);
}
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root, undefined, tsconfigPath);
if (parsed.errors.length > 0) {
  fail(parsed.errors);
}

fs.rmSync(outDir, { recursive: true, force: true });

const program = ts.createProgram(sources, {
  ...parsed.options,
  rootDir: sourceDir,
  outDir,
  declaration: false,
  declarationMap: false,
  sourceMap: false,
  noEmitOnError: true,
});
const emitResult = program.emit();
const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
if (diagnostics.length > 0 || emitResult.emitSkipped) {
  fail(diagnostics);
}

console.log(`build-migrations: compiled ${sources.length} migrations to ${path.relative(root, outDir)}`);
