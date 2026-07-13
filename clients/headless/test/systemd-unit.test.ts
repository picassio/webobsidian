import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const unitUrl = new URL('../packaging/systemd/web-vault-sync.service', import.meta.url);

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
