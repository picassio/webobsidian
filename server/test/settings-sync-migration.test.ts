import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

async function loadInChild(dataDir: string): Promise<{ version: number; sync: { enabled: boolean; bootstrapState: string }; git: { mode: string; remote: string } }> {
  const script = `import('./src/services/settings.ts').then(async (module) => process.stdout.write(JSON.stringify(await module.loadSettings())))`;
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, DATA_DIR: dataDir, VAULT_PATH: path.join(dataDir, 'vault') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

test('version-1 installations retain explicit legacy Git mode until migration', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-sync-migration-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, git: { remote: 'https://example.com/backup.git' } }));
  const migrated = await loadInChild(dataDir);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.sync.enabled, false);
  assert.equal(migrated.sync.bootstrapState, 'backup-required');
  assert.equal(migrated.git.mode, 'legacy-bidirectional');
  assert.equal(migrated.git.remote, 'https://example.com/backup.git');
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(persisted.sync.enabled, false);
});

test('new installations default to Central Sync authority and Git backup-only', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-sync-default-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const settings = await loadInChild(dataDir);
  assert.equal(settings.version, 3);
  assert.equal(settings.sync.enabled, true);
  assert.equal(settings.sync.bootstrapState, 'ready');
  assert.equal(settings.git.mode, 'backup-only');
});

test('new configuration over an existing vault requires backup confirmation before pairing', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-sync-existing-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataDir, 'vault'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'vault', 'existing.md'), '# Existing');
  const settings = await loadInChild(dataDir);
  assert.equal(settings.sync.enabled, false);
  assert.equal(settings.sync.bootstrapState, 'backup-required');
  assert.equal(settings.git.mode, 'legacy-bidirectional');
});

test('invalid settings fail closed without replacing the source file', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-sync-corrupt-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const source = '{not-json';
  await fs.writeFile(path.join(dataDir, 'settings.json'), source);
  await assert.rejects(() => loadInChild(dataDir), /settings\.json is invalid/);
  assert.equal(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'), source);
});
