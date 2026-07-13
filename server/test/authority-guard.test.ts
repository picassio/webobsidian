import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenVaultCalls = /vault\.(?:writeFileText|writeFileBuffer|createFolder|rename|copy|remove|trash|restoreFromTrash|deleteFromTrash|emptyTrash)\s*\(/g;

test('HTTP routes cannot bypass SyncCoordinator for vault mutations', async () => {
  const routes = path.join(serverRoot, 'src', 'routes');
  const violations: string[] = [];
  for (const name of await fs.readdir(routes)) {
    if (!name.endsWith('.ts')) continue;
    const source = await fs.readFile(path.join(routes, name), 'utf8');
    for (const match of source.matchAll(forbiddenVaultCalls)) violations.push(`${name}:${match[0]}`);
  }
  assert.deepEqual(violations, []);
});

test('stable HTTP and Agent mutations contain no unrevisioned compatibility fallback', async () => {
  const files = await fs.readFile(path.join(serverRoot, 'src', 'routes', 'files.ts'), 'utf8');
  const agent = await fs.readFile(path.join(serverRoot, 'src', 'routes', 'agent.ts'), 'utf8');
  assert.doesNotMatch(files + agent, /compatibility mode|REQUIRE_CONDITIONAL_AGENT_WRITES|baseRevision omitted/);
  assert.match(files, /baseRevision or If-Match is required for an existing entry/);
  assert.match(agent, /positive clientSequence and idempotencyKey are required/);
  assert.match(agent, /baseRevision is required for an existing note/);
});

test('Git is backup-only under Central Sync and legacy pull is hard-gated before coordinator reconciliation', async () => {
  const service = await fs.readFile(path.join(serverRoot, 'src', 'services', 'git.ts'), 'utf8');
  const syncImpl = service.slice(service.indexOf('async function syncImpl'));
  assert.match(syncImpl, /if \(await isLegacyBidirectionalEnabled\(\)\)[\s\S]*pullImpl\(\)[\s\S]*else/);
  assert.match(service, /!settings\.sync\.enabled && settings\.git\.mode === 'legacy-bidirectional'/);
  assert.match(service, /Git pull is disabled while Central Sync is authoritative/);
  const route = await fs.readFile(path.join(serverRoot, 'src', 'routes', 'git.ts'), 'utf8');
  assert.match(route, /coordinator\.importDirectory/);
  assert.match(route, /getSyncCoordinator\(\)\.reconcileExternalDrift/);
});
