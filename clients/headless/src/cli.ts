#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openClient } from './client.js';
import { FilesystemAdapter } from './fs-adapter.js';
import { HeadlessStore, type SyncMode } from './state.js';
import { NodeSyncTransport, TransportError, validateServerUrl } from './transport.js';

const EXIT = { usage: 2, auth: 3, conflict: 4, network: 5, local: 6, lock: 7 } as const;
const args = process.argv.slice(2);
const global = extractGlobals(args);
const command = args.shift() ?? 'help';
const store = new HeadlessStore(HeadlessStore.configDirectory(global.profile, global.configDir));
const logger = (level: 'info' | 'error', message: string, metadata: object = {}) => {
  const record = { timestamp: new Date().toISOString(), level, message, ...metadata };
  process.stderr.write(`${global.json ? JSON.stringify(record) : `[${record.timestamp}] ${level}: ${message}${Object.keys(metadata).length ? ` ${JSON.stringify(metadata)}` : ''}`}\n`);
};

try {
  await execute();
} catch (error) {
  const code = exitCode(error);
  const output = { ok: false, error: sanitize(error), exitCode: code };
  process.stderr.write(`${global.json ? JSON.stringify(output) : `Error: ${output.error}`}\n`);
  process.exitCode = code;
}

async function execute(): Promise<void> {
  if (command === 'help' || command === '--help' || command === '-h') { printHelp(); return; }
  if (command === 'completion') { printCompletion(args[0] ?? 'bash'); return; }
  if (command === 'init') return initialize();
  await store.load();
  if (command === 'pair') return pair();
  if (command === 'status') return status();
  if (command === 'sync') return sync();
  if (command === 'pull') return withMode('pull-only', sync);
  if (command === 'push') return withMode('push-only', sync);
  if (command === 'watch') return watch();
  if (command === 'conflicts') return conflicts();
  if (command === 'doctor') return doctor();
  if (command === 'reset') return reset();
  throw new UsageError(`unknown command: ${command}`);
}
async function initialize(): Promise<void> {
  const serverUrl = option('--server') ?? args.shift(); const vaultPath = option('--vault') ?? args.shift();
  const mode = (option('--mode') ?? 'bidirectional') as SyncMode;
  if (!serverUrl || !vaultPath || !['bidirectional', 'pull-only', 'push-only'].includes(mode)) throw new UsageError('init requires --server URL --vault PATH [--mode bidirectional|pull-only|push-only]');
  await store.initialize({ serverUrl: validateServerUrl(serverUrl), vaultPath, mode, deviceName: option('--device-name') ?? os.hostname() });
  print({ ok: true, configDir: store.configDir, vaultPath: store.state.vaultPath, mode });
}
async function pair(): Promise<void> {
  const code = option('--code') ?? args.shift(); if (!code) throw new UsageError('pair requires --code CODE');
  const deviceId = store.state.deviceId ?? `headless_${randomBytes(24).toString('base64url')}`;
  const result = await NodeSyncTransport.pair(store.state.serverUrl, code, deviceId, store.state.deviceName);
  await store.setToken(result.token);
  await store.update((state) => {
    state.deviceId = result.deviceId; state.vaultId = result.vaultId; state.cursor = 0; state.nextClientSequence = 1;
    state.operations = []; state.applyIntents = []; state.entries = []; state.pendingPaths = []; state.lastError = null;
  });
  print({ ok: true, deviceId: result.deviceId, vaultId: result.vaultId });
}
async function status(): Promise<void> {
  const token = await store.token(); let server: object | null = null;
  if (token && store.state.deviceId && store.state.vaultId) {
    try { const handshake = await new NodeSyncTransport(store.state.serverUrl, token).handshake((await store.getDevice())!); server = { latestSequence: handshake.latestSequence, minimumRetainedSequence: handshake.minimumRetainedSequence, readOnly: handshake.readOnly }; }
    catch (error) { server = { error: sanitize(error) }; }
  }
  print({ ok: true, paired: Boolean(token && store.state.deviceId), configDir: store.configDir, ...summary(), server });
}
async function sync(): Promise<void> {
  const client = await openClient(store, logger); const result = await client.syncOnce(); print({ ok: result.conflicts === 0, ...result });
  if (result.conflicts > 0) process.exitCode = EXIT.conflict;
}
async function watch(): Promise<void> {
  const client = await openClient(store, logger); await client.watch(has('--polling'));
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = async (signal: string) => {
      if (stopping) return;
      stopping = true; logger('info', 'stopping daemon', { signal }); await client.stop(); resolve();
    };
    process.once('SIGTERM', () => void stop('SIGTERM')); process.once('SIGINT', () => void stop('SIGINT'));
  });
}
async function conflicts(): Promise<void> {
  const token = await store.token(); if (!token) throw new AuthError('device is not paired');
  const transport = new NodeSyncTransport(store.state.serverUrl, token); const action = args.shift() ?? 'list';
  const list = await transport.conflicts();
  if (action === 'list') { print({ ok: true, conflicts: list }); if (list.some((item) => item.status === 'unresolved')) process.exitCode = EXIT.conflict; return; }
  const id = args.shift(); if (!id) throw new UsageError(`conflicts ${action} requires CONFLICT_ID`);
  const conflict = list.find((item) => item.conflictId === id); if (!conflict) throw new Error(`unknown conflict: ${id}`);
  if (action === 'show') { print({ ok: true, conflict }); return; }
  if (action === 'resolve') {
    const choice = args.shift(); const mapping = { server: 'keep-server', client: 'keep-client', copy: 'copy', merged: 'merged' } as const;
    const resolution = mapping[choice as keyof typeof mapping]; if (!resolution) throw new UsageError('resolution must be server|client|copy|merged');
    const sequence = await store.takeClientSequence();
    await transport.resolveConflict(id, resolution, sequence, `headless-resolve-${sequence}-${randomBytes(8).toString('hex')}`, option('--merged-file'));
    print({ ok: true, conflictId: id, resolution }); return;
  }
  throw new UsageError(`unknown conflicts action: ${action}`);
}
async function doctor(): Promise<void> {
  const issues: Array<{ severity: 'error' | 'warning'; code: string; message: string }> = [];
  try { const mode = (await fs.stat(store.stateFile)).mode & 0o777; if ((mode & 0o077) !== 0) issues.push({ severity: 'error', code: 'state_permissions', message: `state file mode is ${mode.toString(8)}, expected 600` }); } catch (error) { issues.push({ severity: 'error', code: 'state_missing', message: sanitize(error) }); }
  try { await fs.realpath(store.state.vaultPath); } catch (error) { issues.push({ severity: 'error', code: 'vault_unavailable', message: sanitize(error) }); }
  const token = await store.token();
  if (!token) issues.push({ severity: 'error', code: 'token_missing', message: 'device token is unavailable' });
  else {
    try {
      const transport = new NodeSyncTransport(store.state.serverUrl, token);
      await transport.handshake((await store.getDevice())!);
      const adapter = new FilesystemAdapter(store, transport, () => {}); await adapter.initialize();
      const local = await adapter.scan();
      for (const entry of store.state.entries.filter((item) => !item.deleted)) {
        const found = local.find((item) => item.path === entry.path);
        if (!found) issues.push({ severity: 'warning', code: 'local_missing', message: entry.path });
        else if (found.kind !== entry.kind || found.hash !== entry.hash) issues.push({ severity: 'warning', code: 'local_drift', message: entry.path });
      }
    } catch (error) { issues.push({ severity: 'error', code: 'server_or_vault_check_failed', message: sanitize(error) }); }
  }
  const report = { ok: issues.every((item) => item.severity !== 'error'), checkedEntries: store.state.entries.length, cursor: store.state.cursor, issues };
  print(report); if (!report.ok) process.exitCode = EXIT.local;
}
async function reset(): Promise<void> {
  if (!has('--yes')) throw new UsageError('reset keeps vault files but requires --yes');
  await store.update((state) => { state.cursor = 0; state.nextClientSequence = 1; state.operations = []; state.applyIntents = []; state.entries = []; state.pendingPaths = []; state.lastError = null; });
  print({ ok: true, message: 'local sync metadata reset; vault files retained' });
}
async function withMode(mode: SyncMode, action: () => Promise<void>): Promise<void> {
  const original = store.state.mode; store.state.mode = mode;
  try { await action(); } finally { store.state.mode = original; await store.save(); }
}
function summary() { return { vaultPath: store.state.vaultPath, mode: store.state.mode, cursor: store.state.cursor, queuedOperations: store.state.operations.length, pendingPaths: store.state.pendingPaths.length, applyIntents: store.state.applyIntents.length, lastSyncAt: store.state.lastSyncAt, lastError: store.state.lastError }; }
function print(value: unknown) { process.stdout.write(`${global.json ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`); }
function option(name: string): string | undefined { const index = args.indexOf(name); if (index < 0) return undefined; const value = args[index + 1]; if (!value) throw new UsageError(`${name} requires a value`); args.splice(index, 2); return value; }
function has(name: string): boolean { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true; }
function extractGlobals(values: string[]) { let profile = 'default'; let configDir: string | undefined; let json = false; for (let i = 0; i < values.length;) { if (values[i] === '--profile') { profile = values[i + 1] ?? ''; values.splice(i, 2); } else if (values[i] === '--config-dir') { configDir = values[i + 1]; values.splice(i, 2); } else if (values[i] === '--json') { json = true; values.splice(i, 1); } else i += 1; } return { profile, configDir, json }; }
function printHelp() { process.stdout.write(`web-vault-sync 0.1.0\n\nCommands:\n  init --server URL --vault PATH [--mode MODE]\n  pair --code CODE\n  sync | pull | push\n  watch [--polling]\n  status [--json]\n  conflicts list|show ID|resolve ID server|client|copy|merged [--merged-file PATH]\n  doctor [--json]\n  reset --yes\n  completion bash\n\nGlobal: --profile NAME --config-dir PATH --json\nExit codes: 0 success, 2 usage, 3 auth, 4 unresolved conflict, 5 network, 6 local state, 7 daemon lock.\n`); }
function printCompletion(shell: string) { if (shell !== 'bash') throw new UsageError('only bash completion is currently supported'); process.stdout.write(`_web_vault_sync(){ local cur="\${COMP_WORDS[COMP_CWORD]}"; COMPREPLY=( $(compgen -W "init pair sync pull push watch status conflicts doctor reset completion" -- "$cur") ); }; complete -F _web_vault_sync web-vault-sync\n`); }
function sanitize(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').replace(process.env.WEB_VAULT_SYNC_TOKEN ?? '__never__', '<redacted>'); }
function exitCode(error: unknown) { if (error instanceof UsageError) return EXIT.usage; if (error instanceof AuthError || (error instanceof TransportError && [401, 403].includes(error.status))) return EXIT.auth; if (error instanceof TransportError) return EXIT.network; if (sanitize(error).includes('another daemon')) return EXIT.lock; return EXIT.local; }
class UsageError extends Error {} class AuthError extends Error {}
