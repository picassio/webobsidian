import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cli = path.resolve('src/cli.ts');
const packageMetadata = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8')) as { version: string };

test('CLI reports package version without requiring initialized state', async () => {
  const result = await run(['--version']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageMetadata.version);
});

test('CLI usage and startup failures retain documented exit codes without error-handler crash', async (t) => {
  const config = await fs.mkdtemp(path.join(os.tmpdir(), 'web-vault-cli-error-'));
  t.after(() => fs.rm(config, { recursive: true, force: true }));

  const usage = await run(['completion', 'zsh', '--json']);
  assert.equal(usage.code, 2);
  const usageError = JSON.parse(usage.stderr.trim()) as { ok: boolean; error: string; exitCode: number };
  assert.deepEqual(usageError, { ok: false, error: 'only bash completion is currently supported', exitCode: 2 });
  assert.doesNotMatch(usage.stderr, /ReferenceError/u);

  const local = await run(['--config-dir', config, 'status', '--json']);
  assert.equal(local.code, 6);
  const localError = JSON.parse(local.stderr.trim()) as { ok: boolean; error: string; exitCode: number };
  assert.equal(localError.ok, false);
  assert.equal(localError.exitCode, 6);
  assert.match(localError.error, /state is not initialized/u);
  assert.doesNotMatch(local.stderr, /ReferenceError/u);
});

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      cwd: process.cwd(), env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
