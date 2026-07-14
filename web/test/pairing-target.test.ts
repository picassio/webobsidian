import assert from 'node:assert/strict';
import test from 'node:test';
import { pairingConfirmation, pairingTargetDescription } from '../src/lib/pairing-target.ts';

const target = { id: 'vault_desktop_123456789', name: 'Desktop Obsidian' };

test('pairing target copy identifies the exact selected server vault and never implies auto-creation', () => {
  const description = pairingTargetDescription(target, 0);
  assert.match(description, /Desktop Obsidian/);
  assert.match(description, /vault_desktop_123456789/);
  assert.match(description, /sequence 0/);
  assert.match(description, /never creates a vault/);
});

test('pairing confirmation distinguishes empty bootstrap from populated convergence', () => {
  assert.match(pairingConfirmation(target, 0), /empty, so the first client will populate it/);
  const populated = pairingConfirmation(target, 42);
  assert.match(populated, /sequence 42/);
  assert.match(populated, /converge the local vault/);
  assert.match(populated, /device name does not create a vault/i);
});
