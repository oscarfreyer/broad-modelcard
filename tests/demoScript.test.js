import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_API_PORT, DEMO_STORE, DEMO_UPLOADS, demoEnv } from '../scripts/demo.mjs';
import { BACKEND_DIR, storePath } from '../scripts/backendServer.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/demo.mjs', import.meta.url));

test('the demo runs on its own store and uploads folder, never the live ones', () => {
  const env = demoEnv({ PATH: '/bin' });
  assert.equal(env.BMC_DB, path.join(BACKEND_DIR, 'data', 'dashboard-demo.sqlite'));
  assert.equal(storePath(env), DEMO_STORE);
  assert.notEqual(storePath(env), storePath({}));
  assert.equal(env.BMC_UPLOADS_DIR, path.join(BACKEND_DIR, 'data', 'dashboard-demo-uploads'));
  assert.notEqual(env.BMC_UPLOADS_DIR, path.join(BACKEND_DIR, 'data', 'uploads'));
  assert.equal(env.BMC_API_PORT, String(DEMO_API_PORT));
  assert.equal(demoEnv({ BMC_API_PORT: '8123' }).BMC_API_PORT, '8123');
  assert.equal(DEMO_UPLOADS, env.BMC_UPLOADS_DIR);
});

test('the demo script explains its commands', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: node scripts\/demo\.mjs <build\|run>/);
});
