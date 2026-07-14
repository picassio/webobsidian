import assert from 'node:assert/strict';
import test from 'node:test';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test('vault selection scopes request headers, raw URLs and deep links', async () => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  const selection = await import('../src/lib/vault-selection.ts');
  selection.setDefaultVaultId('vault_default_123456789');
  selection.setLegacyVaultId('vault_default_123456789');
  selection.setActiveVaultId('vault_second_123456789');
  assert.equal(selection.vaultHeaders().get('X-WebObsidian-Vault-Id'), 'vault_second_123456789');
  assert.equal(selection.withVaultQuery('/api/files/content?path=Note.md'), '/api/files/content?path=Note.md&vaultId=vault_second_123456789');

  const urls = await import('../src/lib/urlsync.ts');
  assert.equal(urls.pathToUrl('Folder/Note.md'), '/vault/vault_second_123456789/note/Folder/Note.md');
  assert.equal(urls.pathToUrl('graph://view'), '/vault/vault_second_123456789/graph');
  assert.equal(urls.urlToVaultId('/vault/vault_second_123456789/note/Folder/Note.md'), 'vault_second_123456789');
  assert.equal(urls.urlToPath('/vault/vault_second_123456789/note/Folder/Note.md'), 'Folder/Note.md');
  assert.equal(urls.urlToPath('/note/Legacy.md'), 'Legacy.md');
});
