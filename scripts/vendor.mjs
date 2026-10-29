// Copy the browser libraries the page loads from node_modules into web/vendor/ (`npm run vendor`, after `npm ci`).
//
// The page has no bundler: index.html maps `three` and `three/addons/` to these copies, and the viewport imports the
// MuJoCo WASM build directly. The MuJoCo version must equal the Python `mujoco` the simulator runs, because the scene
// is served as a binary .mjb that only the same version loads; the copy refuses a mismatch instead of shipping a page
// that cannot read its own models.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = path.join(WEB, 'node_modules');
const VENDOR = path.join(WEB, 'vendor');

// [package, file in the package, destination under vendor/]
const FILES = [
  ['@mujoco/mujoco', 'mujoco.js', 'mujoco/mujoco.js'],
  ['@mujoco/mujoco', 'mujoco.wasm', 'mujoco/mujoco.wasm'],
  ['@mujoco/mujoco', 'mujoco.d.ts', 'mujoco/mujoco.d.ts'],
  ['three', 'build/three.module.js', 'three/three.module.js'],
  ['three', 'build/three.core.js', 'three/three.core.js'],
  ['three', 'examples/jsm/controls/OrbitControls.js', 'three/addons/controls/OrbitControls.js'],
];

function fail(msg) {
  console.error(`vendor: ${msg}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(WEB, 'package.json'), 'utf8'));
const pinned = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };

for (const pkg of new Set(FILES.map(([p]) => p))) {
  const file = path.join(MODULES, pkg, 'package.json');
  if (!fs.existsSync(file)) fail(`${pkg} is not installed; run \`npm ci\` in web/ first`);
  const installed = JSON.parse(fs.readFileSync(file, 'utf8')).version;
  if (pinned[pkg] && installed !== pinned[pkg]) fail(`${pkg} ${installed} is installed but package.json pins ${pinned[pkg]}`);
}

let bytes = 0;
for (const [pkg, from, to] of FILES) {
  const src = path.join(MODULES, pkg, from);
  const dst = path.join(VENDOR, to);
  if (!fs.existsSync(src)) fail(`${pkg} has no ${from}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  const n = fs.statSync(dst).size;
  bytes += n;
  console.log(`vendor/${to}  ${(n / 1024).toFixed(0)} kB`);
}
console.log(`vendor: ${FILES.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
