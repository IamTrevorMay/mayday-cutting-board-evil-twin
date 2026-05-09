#!/usr/bin/env node
/**
 * Mayday Plugin — Build Script
 *
 * Builds the plugin into a distributable format:
 * 1. Transpiles src/index.ts → dist/server/index.mjs via esbuild
 * 2. Copies mayday.json → dist/
 * 3. Copies icon.png → dist/ (if exists)
 * 4. Copies cep/ → dist/cep/ (if hasCep: true in manifest)
 *
 * Output: dist/ directory ready for packaging
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const MANIFEST_PATH = path.join(ROOT, 'mayday.json');

async function build() {
  // Read manifest
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  console.log(`Building ${manifest.name} v${manifest.version}...`);

  // Clean dist
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'server'), { recursive: true });

  // 1. Transpile TypeScript → ESM
  const entryPoint = path.join(ROOT, manifest.main || 'src/index.ts');
  await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: path.join(DIST, 'server', 'index.mjs'),
    // SDK is bundled into output (not external) — definePlugin is tiny and
    // type imports are erased. Use alias to resolve from local sdk.ts shim
    // so builds work without @mayday/sdk in node_modules.
    alias: {
      '@mayday/sdk': path.join(ROOT, 'src', 'sdk.ts'),
      '@mayday/types': path.join(ROOT, 'src', 'sdk.ts'),
    },
    external: [
      // Node built-ins
      'fs', 'path', 'os', 'crypto', 'util', 'events', 'stream', 'url',
      'http', 'https', 'net', 'child_process', 'worker_threads',
      // Native modules
      'better-sqlite3', 'brain.js', 'gpu.js',
    ],
  });

  // 2. Copy manifest (update main to point to built file)
  const distManifest = { ...manifest, main: 'server/index.mjs' };
  fs.writeFileSync(
    path.join(DIST, 'mayday.json'),
    JSON.stringify(distManifest, null, 2),
  );

  // 3. Copy icon (if exists)
  const iconPath = path.join(ROOT, 'icon.png');
  if (fs.existsSync(iconPath)) {
    fs.copyFileSync(iconPath, path.join(DIST, 'icon.png'));
  }

  // 4. Copy CEP extension (if hasCep)
  if (manifest.hasCep) {
    const cepSrc = path.join(ROOT, 'cep');
    if (fs.existsSync(cepSrc)) {
      fs.cpSync(cepSrc, path.join(DIST, 'cep'), { recursive: true });
    } else {
      console.warn('Warning: hasCep is true but no cep/ directory found');
    }
  }

  console.log(`Built to dist/ (${manifest.name} v${manifest.version})`);
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
