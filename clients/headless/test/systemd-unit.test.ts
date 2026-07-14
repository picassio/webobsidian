import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const unitUrl = new URL('../packaging/systemd/web-vault-sync.service', import.meta.url);
const templateUrl = new URL('../packaging/systemd/web-vault-sync@.service', import.meta.url);

test('systemd unit advertises only daemon lifecycle behavior implemented by the CLI', async () => {
  const unit = await readFile(unitUrl, 'utf8');
  assert.match(unit, /^Type=simple$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/env web-vault-sync .* watch$/m);
  assert.doesNotMatch(unit, /^ExecReload=/m);
  assert.match(unit, /^TimeoutStopSec=45s$/m);
  assert.match(unit, /^LoadCredential=sync-token:/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
});

test('systemd template isolates config, state and credentials per vault profile', async () => {
  const unit = await readFile(templateUrl, 'utf8');
  assert.match(unit, /^StateDirectory=web-vault-sync-%i$/m);
  assert.match(unit, /^EnvironmentFile=-\/etc\/web-vault-sync\/%i\/environment$/m);
  assert.match(unit, /^LoadCredential=sync-token:\/etc\/web-vault-sync\/%i\/token$/m);
  assert.match(unit, /^ExecStart=.*--config-dir \/var\/lib\/web-vault-sync-%i watch$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/web-vault-sync-%i$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
});
