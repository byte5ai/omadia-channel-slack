#!/usr/bin/env node
/**
 * test.mjs — run the TypeScript test suite with zero extra dependencies.
 *
 * Node's built-in test runner (`node:test`) + assert drive the tests; esbuild
 * (already a dev dependency) transpiles each `tests/*.test.ts` into
 * `.test-build/` first, bundling the `src/` modules under test directly.
 *
 * `@omadia/channel-sdk` is aliased to a built dist of the omadia kernel's
 * channel SDK because the plugin imports runtime values from it (the plain-text
 * renderer, the decoration registry, isNoReply). Default location: the adjacent
 * omadia checkout (same layout the tsconfig `paths` typecheck uses); override
 * with OMADIA_CHANNEL_SDK_DIST=/path/to/harness-channel-sdk/dist/index.js.
 * The SDK itself imports runtime values from `@omadia/plugin-api`, so that is
 * aliased too (OMADIA_PLUGIN_API_DIST, default `middleware/packages/plugin-api`).
 * Build both first: `npm run build` in each package of the omadia checkout.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const testsDir = join(pkgRoot, 'tests');
const outDir = join(pkgRoot, '.test-build');

function distPath(envName, fallback) {
  const path = process.env[envName] ? resolve(process.env[envName]) : resolve(pkgRoot, fallback);
  if (!existsSync(path)) {
    console.error(`${path} not found. Build the omadia package first or set ${envName}.`);
    process.exit(1);
  }
  return path;
}

const channelSdkDist = distPath(
  'OMADIA_CHANNEL_SDK_DIST',
  '../middleware/packages/harness-channel-sdk/dist/index.js',
);
const pluginApiDist = distPath('OMADIA_PLUGIN_API_DIST', '../middleware/packages/plugin-api/dist/index.js');

const entryPoints = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(testsDir, f));

if (entryPoints.length === 0) {
  console.error('no tests found in tests/');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });

console.log(`transpiling ${entryPoints.length} test file(s)`);
await build({
  entryPoints,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'error',
  alias: {
    '@omadia/channel-sdk': channelSdkDist,
    '@omadia/plugin-api': pluginApiDist,
  },
  // Bundle the ESM entry as a CJS-safe banner so bundled CJS deps (express,
  // the Slack SDKs) can `require` Node builtins.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  external: ['express'],
});

const built = readdirSync(outDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(outDir, f));

console.log('node --test');
const res = spawnSync(process.execPath, ['--test', ...built], {
  cwd: pkgRoot,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
