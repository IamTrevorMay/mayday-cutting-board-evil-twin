#!/usr/bin/env node
/**
 * Mayday Plugin — Package Script
 *
 * Creates a distributable zip from the dist/ directory.
 * Output: mayday-{id}-v{version}.zip
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const MANIFEST_PATH = path.join(DIST, 'mayday.json');

if (!fs.existsSync(MANIFEST_PATH)) {
  console.error('Error: dist/mayday.json not found. Run "node build.js" first.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
const zipName = `mayday-${manifest.id}-v${manifest.version}.zip`;
const zipPath = path.join(ROOT, zipName);

// Remove existing zip
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

// Create zip from dist/ contents (not the dist/ folder itself)
execSync(`cd "${DIST}" && zip -r "${zipPath}" .`, { stdio: 'inherit' });

console.log(`Packaged: ${zipName}`);
