import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

interface LoadedSettings {
  version: number;
  sync: { enabled: boolean; bootstrapState: string };
  git: { mode: string; remote: string };
  vault: { path: string };
  vaults: { defaultVaultId: string; items: Array<{ id: string; path: string; sync: { enabled: boolean }; git: { mode: string } }> };
}

async function loadInChild(dataDir: string): Promise<LoadedSettings> {
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
  assert.equal(migrated.version, 4);
  assert.equal(migrated.sync.enabled, false);
  assert.equal(migrated.sync.bootstrapState, 'backup-required');
  assert.equal(migrated.git.mode, 'legacy-bidirectional');
  assert.equal(migrated.git.remote, 'https://example.com/backup.git');
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(persisted.version, 4);
  assert.equal(persisted.vaults.items[0].sync.enabled, false);
  assert.equal(persisted.sync, undefined);
});

test('new installations default to Central Sync authority and Git backup-only', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-sync-default-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const settings = await loadInChild(dataDir);
  assert.equal(settings.version, 4);
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

test('version-3 migration preserves the existing sync vault id and path in place', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-v4-migration-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const vaultPath = path.join(dataDir, 'existing-vault');
  await fs.mkdir(path.join(dataDir, 'sync'), { recursive: true });
  await fs.mkdir(vaultPath, { recursive: true });
  const vaultId = 'vault_existing_identity_1234';
  const now = new Date().toISOString();
  const payload = { schemaVersion: 1, vaultId, currentSequence: 0, createdAt: now, updatedAt: now };
  const { createHash } = await import('node:crypto');
  const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  await fs.writeFile(path.join(dataDir, 'sync', 'vault.json'), JSON.stringify({ envelopeVersion: 1, checksum, payload }));
  const source = JSON.stringify({
    version: 3,
    vault: { path: vaultPath, allowedRoots: [dataDir], trash: '.trash', deleteMode: 'trash', attachmentDir: 'attachments' },
    sync: { enabled: true, bootstrapState: 'ready' },
  });
  await fs.writeFile(path.join(dataDir, 'settings.json'), source);

  const migrated = await loadInChild(dataDir);
  assert.equal(migrated.version, 4);
  assert.equal(migrated.vaults.defaultVaultId, vaultId);
  assert.equal(migrated.vaults.items[0].id, vaultId);
  assert.equal(migrated.vaults.items[0].path, vaultPath);
  assert.equal(migrated.vault.path, vaultPath);
  assert.equal(await fs.stat(path.join(dataDir, 'sync', 'vault.json')).then(() => true), true);
  const immutableBackup = path.join(dataDir, 'settings.v3.pre-v4.json');
  assert.equal(await fs.readFile(immutableBackup, 'utf8'), source);
  assert.equal((await fs.stat(immutableBackup)).mode & 0o777, 0o600);
});

test('future settings versions fail closed instead of being downgraded', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-sync-future-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const source = JSON.stringify({ version: 5, vaults: {} });
  await fs.writeFile(path.join(dataDir, 'settings.json'), source);
  await assert.rejects(() => loadInChild(dataDir), /unsupported settings version/);
  assert.equal(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'), source);
});

test('invalid settings fail closed without replacing the source file', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-sync-corrupt-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const source = '{not-json';
  await fs.writeFile(path.join(dataDir, 'settings.json'), source);
  await assert.rejects(() => loadInChild(dataDir), /settings\.json is invalid/);
  assert.equal(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'), source);
});
