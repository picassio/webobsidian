import { useEffect, useRef, useState } from 'react';
import type { Conflict, Device } from '@picassio/sync-core';
import { useStore } from '../lib/store';
import { api, type SyncDoctorResponse, type SyncHealthResponse } from '../lib/api';
import Icon from './Icon';
import { IndexedDbSyncPersistence, type BrowserDeviceState } from '../lib/sync-db';

type Section = 'vault' | 'sync' | 'git' | 'api' | 'sharing' | 'plugins' | 'appearance' | 'account' | 'about';

export default function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettings);
  const [section, setSection] = useState<Section>('vault');
  const [settings, setSettings] = useState<any>(null);

  useEffect(() => {
    if (open) api.getSettings().then(setSettings).catch(() => {});
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-layout">
          <div className="settings-nav">
            {(['vault', 'sync', 'git', 'api', 'sharing', 'plugins', 'appearance', 'account', 'about'] as Section[]).map((s) => (
              <button key={s} className={section === s ? 'active' : ''} onClick={() => setSection(s)}>
                {labels[s]}
              </button>
            ))}
          </div>
          <div className="settings-content">
            {settings && section === 'vault' && <VaultSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {section === 'sync' && <SyncSettings />}
            {settings && section === 'git' && <GitSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {section === 'api' && <ApiKeys />}
            {section === 'sharing' && <Shares />}
            {section === 'plugins' && <Plugins />}
            {settings && section === 'appearance' && <Appearance s={settings} />}
            {section === 'account' && <AccountSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {section === 'about' && <About />}
          </div>
        </div>
      </div>
    </div>
  );
}

const labels: Record<Section, string> = {
  vault: 'Vault & Files',
  sync: 'Central Sync',
  git: 'Git Backup & History',
  api: 'API Keys',
  sharing: 'Sharing',
  plugins: 'Community Plugins',
  appearance: 'Appearance',
  account: 'Account',
  about: 'About',
};

function Row({ name, desc, children }: { name: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="info">
        <div className="name">{name}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div className="control">{children}</div>
    </div>
  );
}

function SyncSettings() {
  const [health, setHealth] = useState<SyncHealthResponse | null>(null);
  const [doctor, setDoctor] = useState<SyncDoctorResponse | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [localDevice, setLocalDevice] = useState<BrowserDeviceState | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [selected, setSelected] = useState<{ conflict: Conflict; base: string | null; server: string; client: string; binary: boolean } | null>(null);
  const [merged, setMerged] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const persistence = useRef(new IndexedDbSyncPersistence()).current;
  const refresh = async () => {
    const [nextHealth, nextDevices, local] = await Promise.all([
      api.syncHealth(), api.syncDevices(), persistence.getDevice(),
    ]);
    setHealth(nextHealth);
    setDevices(nextDevices.devices);
    setLocalDevice(local);
    setConflicts(local ? (await api.syncConflicts()).conflicts.filter((item) => item.status === 'unresolved') : []);
  };
  useEffect(() => { void refresh().catch((e) => setError(e instanceof Error ? e.message : 'Unable to load sync status')); }, []);
  const runDoctor = async () => {
    setBusy(true); setError('');
    try { setDoctor(await api.syncDoctor()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Diagnostics failed'); }
    finally { setBusy(false); }
  };
  const pair = async () => {
    setBusy(true); setError('');
    try {
      const deviceName = `Web browser · ${navigator.platform || 'Unknown platform'}`;
      const deviceId = `web_${crypto.randomUUID().replaceAll('-', '')}`;
      const paired = await api.createBrowserSyncDevice(deviceId, deviceName);
      await persistence.putDevice({
        deviceId: paired.deviceId, deviceName,
        vaultId: paired.vaultId, cursor: 0, nextClientSequence: 1,
      });
      await refresh();
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pairing failed');
    } finally { setBusy(false); }
  };
  const inspectConflict = async (conflict: Conflict) => {
    setBusy(true); setError('');
    try {
      const binary = !/\.(md|markdown|txt|json|css|js|ts|tsx|jsx|html|xml|yaml|yml|csv|svg)$/i.test(conflict.path);
      if (binary) {
        setSelected({ conflict, base: null, server: '', client: '', binary: true });
        setMerged('');
      } else {
        const [base, server, client] = await Promise.all([
          conflict.entryId && conflict.baseRevision !== null
            ? api.syncRevisionText(conflict.entryId, conflict.baseRevision).catch(() => null)
            : Promise.resolve(null),
          api.read(conflict.path).then((value) => typeof value === 'string' ? value : value.content).catch(() => ''),
          conflict.conflictPath ? api.read(conflict.conflictPath).then((value) => typeof value === 'string' ? value : value.content).catch(() => '') : Promise.resolve(''),
        ]);
        setSelected({ conflict, base, server, client, binary: false });
        setMerged(client || server);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to inspect conflict'); }
    finally { setBusy(false); }
  };
  const resolveConflict = async (resolution: 'keep-server' | 'keep-client' | 'merged' | 'copy') => {
    if (!localDevice || !selected) return;
    setBusy(true); setError('');
    try {
      const sequence = await persistence.takeClientSequence();
      await api.resolveSyncConflict(selected.conflict.conflictId, resolution, sequence, resolution === 'merged' ? merged : undefined);
      setSelected(null); setMerged(''); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Conflict resolution failed'); }
    finally { setBusy(false); }
  };
  const revoke = async (deviceId: string) => {
    if (!confirm('Revoke this device? It will stop receiving and sending vault changes immediately.')) return;
    setBusy(true); setError('');
    try {
      await api.revokeSyncDevice(deviceId);
      if (localDevice?.deviceId === deviceId) {
        await api.clearBrowserSyncDevice();
        await persistence.clearDevice();
        window.location.reload();
        return;
      }
      await refresh();
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Revocation failed'); }
    finally { setBusy(false); }
  };
  const exportDiagnostics = () => {
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(), protocolVersion: health?.protocolVersion ?? '1.0',
      health,
      doctor: doctor ? { ...doctor, issues: doctor.issues.map(({ severity, code, message, repairable, repaired }) => ({ severity, code, message: message.replace(/(?:[A-Za-z]:)?[\\/][^\s]*/g, '<redacted-path>'), repairable, repaired })) } : null,
      devices: devices.map(({ deviceId, name, createdAt, lastSeenAt, acknowledgedSequence, revokedAt }) => ({ deviceId, name, createdAt, lastSeenAt, acknowledgedSequence, revokedAt })),
      local: localDevice ? { deviceId: localDevice.deviceId, deviceName: localDevice.deviceName, cursor: localDevice.cursor } : null,
    }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'webobsidian-sync-diagnostics.json'; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  const state = health?.readOnly ? 'Read-only recovery mode' : health ? 'Server healthy' : 'Checking…';
  const selectedCurrentHash = selected?.conflict.currentHash;
  const selectedSubmittedHash = selected?.conflict.submittedHash;
  return (
    <div>
      <h2>Central Sync</h2>
      <p className="desc">Revision-safe synchronization for this browser and paired Obsidian or Linux clients. Git remains backup-only.</p>
      <Row name="Server status" desc={health ? `Sequence ${health.latestSequence ?? 0} · derived-index lag ${health.indexLagSequence ?? 0}` : undefined}>
        <span role="status" aria-live="polite">{state}</span>
      </Row>
      <Row name="Diagnostics" desc={`Derived-index lag ${health?.indexLagSequence ?? 0} · ${health?.reason ?? 'no recovery warning'}`}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn secondary" type="button" disabled={busy} onClick={runDoctor}>{busy ? 'Checking…' : 'Run sync doctor'}</button>
          <button className="btn secondary" type="button" disabled={!health} onClick={exportDiagnostics}>Export redacted JSON</button>
        </div>
      </Row>
      {health?.alerts.map((alert) => <p key={alert.code + alert.message} role="alert" style={{ color: alert.severity === 'critical' ? 'var(--text-error)' : 'var(--text-warning)' }}>{alert.message}</p>)}
      {doctor && <p role="status" className="desc">Doctor: {doctor.healthy ? 'healthy' : `${doctor.issues.length} issue(s)`}; checked {doctor.checkedEntries} entries and {doctor.checkedBlobs} blobs.</p>}
      <p className="desc">Sync scope: normal vault files, attachments, and empty folders. Device workspace remains local. Excluded: <code>.obsidian/**</code>, <code>.git/**</code>, <code>.trash/**</code>, temporary/OS files, and server sync metadata.</p>
      <Row name="This browser" desc={localDevice ? `Paired as ${localDevice.deviceName}` : 'Pair to enable durable offline queue and ordered catch-up'}>
        <button className="btn" type="button" disabled={busy || Boolean(localDevice)} onClick={pair}>
          {busy ? 'Working…' : localDevice ? 'Paired' : 'Pair this browser'}
        </button>
      </Row>
      {error && <div role="alert" style={{ color: 'var(--text-error)', margin: '12px 0' }}>{error}</div>}
      <h3>Conflict center {conflicts.length > 0 && `(${conflicts.length})`}</h3>
      {conflicts.length === 0 && <p className="desc">No unresolved conflicts.</p>}
      {conflicts.map((conflict) => (
        <Row key={conflict.conflictId} name={conflict.path} desc={`${conflict.kind} conflict · ${new Date(conflict.createdAt).toLocaleString()}`}>
          <button className="btn secondary" type="button" disabled={busy} onClick={() => inspectConflict(conflict)}>Compare</button>
        </Row>
      ))}
      {selected && (
        <div style={{ border: '1px solid var(--bg-modifier-border)', borderRadius: 8, padding: 12, margin: '12px 0' }}>
          <h3 style={{ marginTop: 0 }}>Resolve {selected.conflict.path}</h3>
          {selected.binary ? (
            <div>
              <p className="desc">Binary conflict. Compare metadata or download both immutable versions; binary content is never merged automatically.</p>
              <p><strong>Server SHA-256:</strong> <code>{selected.conflict.currentHash ?? 'deleted'}</code></p>
              <p><strong>Client SHA-256:</strong> <code>{selected.conflict.submittedHash ?? 'unavailable'}</code></p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {selectedCurrentHash && <button className="btn secondary" onClick={() => api.downloadSyncBlob(selectedCurrentHash, `server-${selected.conflict.path.split('/').at(-1) ?? 'conflict.bin'}`)}>Download server</button>}
                {selectedSubmittedHash && <button className="btn secondary" onClick={() => api.downloadSyncBlob(selectedSubmittedHash, `client-${selected.conflict.path.split('/').at(-1) ?? 'conflict.bin'}`)}>Download client</button>}
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 8 }}>
                <label>Base version<textarea className="text-input" readOnly value={selected.base ?? 'Base revision unavailable'} style={{ width: '100%', minHeight: 120 }} /></label>
                <label>Server version<textarea className="text-input" readOnly value={selected.server} style={{ width: '100%', minHeight: 120 }} /></label>
                <label>Client/conflict copy<textarea className="text-input" readOnly value={selected.client} style={{ width: '100%', minHeight: 120 }} /></label>
              </div>
              <label style={{ display: 'block', marginTop: 8 }}>Merged result<textarea className="text-input" value={merged} onChange={(event) => setMerged(event.target.value)} style={{ width: '100%', minHeight: 120 }} /></label>
            </>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {!selected.binary && <button className="btn" disabled={busy} onClick={() => resolveConflict('merged')}>Save merged result</button>}
            <button className="btn secondary" disabled={busy} onClick={() => resolveConflict('keep-server')}>Keep server</button>
            <button className="btn secondary" disabled={busy} onClick={() => resolveConflict('keep-client')}>Keep client</button>
            <button className="btn secondary" disabled={busy} onClick={() => resolveConflict('copy')}>Keep both copies</button>
            <button className="btn secondary" disabled={busy} onClick={() => setSelected(null)}>Cancel</button>
          </div>
        </div>
      )}
      <h3>Paired devices</h3>
      {devices.length === 0 && <p className="desc">No paired devices.</p>}
      {devices.map((device) => (
        <Row key={device.deviceId} name={device.name} desc={`Last seen ${device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'never'} · cursor ${device.acknowledgedSequence ?? 0}`}>
          <button className="btn secondary" type="button" disabled={busy || Boolean(device.revokedAt)} onClick={() => revoke(device.deviceId)}>
            {device.revokedAt ? 'Revoked' : 'Revoke'}
          </button>
        </Row>
      ))}
    </div>
  );
}

function VaultSettings({ s, reload }: { s: any; reload: () => void }) {
  const [path, setPath] = useState(s.vault.path);
  const [deleteMode, setDeleteMode] = useState(s.vault.deleteMode ?? 'trash');
  const [browser, setBrowser] = useState<any>(null);
  const save = async () => {
    await api.putSettings({ vault: { path } });
    await reload();
    alert('Vault path saved. Reindex from the command palette if needed.');
  };
  const saveDeleteMode = async (mode: string) => {
    setDeleteMode(mode);
    await api.putSettings({ vault: { deleteMode: mode } });
    await reload();
  };
  const browse = async (dir?: string) => setBrowser(await api.browse(dir).catch((e) => ({ error: e.message })));
  return (
    <div>
      <h2>Vault & Files</h2>
      <Row name="Vault path" desc="Absolute path on the server to your notes folder">
        <input className="text-input" style={{ width: 260 }} value={path} onChange={(e) => setPath(e.target.value)} />
      </Row>
      <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
        <button className="btn secondary" onClick={() => browse()}>Browse…</button>
        <button className="btn" onClick={save}>Save vault path</button>
      </div>
      {browser && !browser.error && (
        <div style={{ border: '1px solid var(--bg-modifier-border)', borderRadius: 6, padding: 8, marginTop: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{browser.dir}</div>
          <div className="result" onClick={() => browse(browser.parent)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="folder" size={15} /> ..
          </div>
          {browser.folders.map((f: any) => (
            <div className="result" key={f.path} onClick={() => browse(f.path)} onDoubleClick={() => setPath(f.path)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="folder" size={15} /> {f.name}
              <button className="btn secondary" style={{ float: 'right', padding: '2px 8px' }} onClick={(e) => { e.stopPropagation(); setPath(f.path); }}>
                Select
              </button>
            </div>
          ))}
        </div>
      )}
      {browser?.error && <div style={{ color: '#e5534b' }}>{browser.error}</div>}
      <Row
        name="When deleting a file"
        desc="Move to .trash keeps a recoverable copy (Open trash to restore). Permanently delete removes it immediately."
      >
        <select
          className="text-input"
          style={{ width: 220 }}
          value={deleteMode}
          onChange={(e) => saveDeleteMode(e.target.value)}
        >
          <option value="trash">Move to .trash (recoverable)</option>
          <option value="permanent">Permanently delete</option>
        </select>
      </Row>
    </div>
  );
}

function GitSettings({ s, reload }: { s: any; reload: () => void }) {
  const [g, setG] = useState({ ...s.git });
  const central = s.sync?.enabled === true;
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLTextAreaElement>(null);
  const set = (k: string, v: any) => setG((p: any) => ({ ...p, [k]: v }));
  // Append timestamped lines to the running log instead of replacing it, so the
  // textarea keeps a history of every git action across clicks.
  const append = (lines: string[]) => {
    const ts = new Date().toLocaleTimeString();
    setLog((prev) => [...prev, ...lines.map((l, i) => (i === 0 ? `[${ts}] ${l}` : `         ${l}`))]);
  };
  // Auto-scroll to the newest line whenever the log grows.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);
  const save = async () => { await api.putSettings({ git: g }); await reload(); append(['Saved git settings']); };
  const importRemote = async () => {
    try {
      const preview = await api.gitImport(false);
      append(['Remote import preview:', JSON.stringify(preview.plan, null, 2)]);
      if (!confirm('Apply this remote snapshot through Central Sync as normal revisioned operations? Existing files are not deleted unless explicitly requested.')) return;
      const result = await api.gitImport(true, false);
      append([`Remote import applied: ${result.applied ?? 0} operation(s)`]); await reload();
    } catch (e) { append([`Import error: ${e instanceof Error ? e.message : String(e)}`]); }
  };
  const migrate = async () => {
    try {
      const preview = await api.migrateGitToBackup(false);
      const remote = preview.remoteConfigured ? 'and push it to the configured remote' : 'as a local-only commit';
      const allowLocalOnly = !preview.remoteConfigured;
      if (!confirm(`Create a full pre-migration backup ${remote}, disable Git pull/clone, and enable Central Sync? Remote content is never pulled automatically; cancel and use Preview/apply remote import first if the remote contains changes you need.`)) return;
      const result = await api.migrateGitToBackup(true, allowLocalOnly);
      append(result.backup ?? ['Migration complete']); await reload();
    } catch (e) { append([`Migration error: ${e instanceof Error ? e.message : String(e)}`]); }
  };
  const run = async (fn: () => Promise<any>, label: string) => {
    append([`${label}…`]);
    try {
      const r = await fn();
      // sync returns { ok, log: string[] }; others return { message }. Split any
      // embedded newlines so multi-line git output renders one line per row.
      const lines: string[] = Array.isArray(r?.log)
        ? [`${label} ${r.ok ? 'ok' : 'NOT ok'}`, ...r.log]
        : [String(r?.message ?? JSON.stringify(r))];
      append(lines.flatMap((l) => String(l).split('\n')));
    } catch (e: any) { append([`Error: ${e.message}`]); }
  };
  return (
    <div>
      <h2>Git Backup & Version History</h2>
      <p className="desc">{central
        ? 'Central Sync is authoritative. Git only snapshots and pushes committed vault revisions; pull/clone cannot mutate the live vault.'
        : 'Legacy bidirectional Git is active for this upgraded installation. Migrate before pairing Central Sync clients.'}</p>
      <Row name="Enable Git backup"><input type="checkbox" checked={g.enabled} onChange={(e) => set('enabled', e.target.checked)} /></Row>
      <Row name="Remote URL" desc="https://github.com/owner/repo.git">
        <input className="text-input" style={{ width: 260 }} value={g.remote} onChange={(e) => set('remote', e.target.value)} />
      </Row>
      <Row name="Branch"><input className="text-input" style={{ width: 120 }} value={g.branch} onChange={(e) => set('branch', e.target.value)} /></Row>
      <Row name="Access token (PAT)" desc="Stored server-side; leave masked to keep current">
        <input className="text-input" type="password" style={{ width: 260 }} value={g.token} onChange={(e) => set('token', e.target.value)} />
      </Row>
      <Row name="Author name"><input className="text-input" value={g.authorName} onChange={(e) => set('authorName', e.target.value)} /></Row>
      <Row name="Author email"><input className="text-input" value={g.authorEmail} onChange={(e) => set('authorEmail', e.target.value)} /></Row>
      <Row name="Scheduled backup" desc={central ? 'Periodic commit + push; never pulls into the live vault' : 'Legacy pull + commit + push until migration'}><input type="checkbox" checked={g.autoSync} onChange={(e) => set('autoSync', e.target.checked)} /></Row>
      <Row name="Backup after save" desc="Commit (+push) ~5s after an authoritative edit"><input type="checkbox" checked={g.autoCommitOnSave} onChange={(e) => set('autoCommitOnSave', e.target.checked)} /></Row>
      <Row name="Interval (sec)"><input className="text-input" type="number" style={{ width: 90 }} value={g.intervalSec} onChange={(e) => set('intervalSec', Number(e.target.value))} /></Row>
      <Row name="Git LFS patterns" desc="Space-separated globs tracked via LFS">
        <input className="text-input" style={{ width: 260 }} value={(g.lfsPatterns || []).join(' ')} onChange={(e) => set('lfsPatterns', e.target.value.split(/\s+/).filter(Boolean))} />
      </Row>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn" onClick={save}>Save</button>
        <button className="btn secondary" onClick={() => run(api.gitInit, 'Init')}>Init repo</button>
        {!central && <button className="btn secondary" onClick={() => run(api.gitClone, 'Legacy clone')}>Legacy clone</button>}
        {!central && <button className="btn secondary" onClick={() => run(api.gitPull, 'Legacy pull')}>Legacy pull</button>}
        <button className="btn secondary" onClick={() => run(() => api.gitCommit(), 'Backup commit')}>Commit snapshot</button>
        <button className="btn secondary" onClick={() => run(api.gitPush, 'Backup push')}>Push backup</button>
        <button className="btn" onClick={() => run(() => api.gitSync(), central ? 'Backup' : 'Legacy sync')}>{central ? 'Back up now' : 'Legacy sync now'}</button>
        {g.remote && <button className="btn secondary" onClick={importRemote}>Preview/apply remote import</button>}
        {!central && <button className="btn" onClick={migrate}>Migrate to Central Sync</button>}
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Backup/import log</span>
          {log.length > 0 && (
            <button className="btn secondary" style={{ padding: '2px 8px' }} onClick={() => setLog([])}>Clear</button>
          )}
        </div>
        <textarea
          ref={logRef}
          readOnly
          value={log.length ? log.join('\n') : 'No Git backup activity yet. Use an action above to see logs here.'}
          style={{
            width: '100%', height: 200, boxSizing: 'border-box', resize: 'vertical',
            background: 'var(--bg-primary)', color: 'var(--text-normal)',
            border: '1px solid var(--bg-modifier-border, #444)', borderRadius: 6, padding: 10,
            fontFamily: 'var(--font-monospace, monospace)', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre',
          }}
        />
      </div>
    </div>
  );
}

function ApiKeys() {
  const [keys, setKeys] = useState<any[]>([]);
  const [name, setName] = useState('my-agent');
  const [scopes, setScopes] = useState<string[]>(['read', 'search']);
  const [created, setCreated] = useState('');
  const load = () => api.listKeys().then((r) => setKeys(r.keys)).catch(() => {});
  useEffect(() => { load(); }, []);
  const toggle = (sc: string) => setScopes((p) => (p.includes(sc) ? p.filter((x) => x !== sc) : [...p, sc]));
  const create = async () => {
    const r = await api.createKey(name, scopes);
    setCreated(r.key);
    await load();
  };
  return (
    <div>
      <h2>API Keys</h2>
      <p style={{ color: 'var(--text-muted)' }}>Keys let AI agents call <code>/api/v1</code>. The raw key is shown once.</p>
      <Row name="Name"><input className="text-input" value={name} onChange={(e) => setName(e.target.value)} /></Row>
      <Row name="Scopes">
        <span>
          {['read', 'write', 'search'].map((sc) => (
            <label key={sc} style={{ marginRight: 10 }}>
              <input type="checkbox" checked={scopes.includes(sc)} onChange={() => toggle(sc)} /> {sc}
            </label>
          ))}
        </span>
      </Row>
      <button className="btn" onClick={create}>Create key</button>
      {created && (
        <pre style={{ background: 'var(--bg-primary)', padding: 10, borderRadius: 6, marginTop: 10, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
          {created}
          {'\n'}⚠ Copy now — it will not be shown again.
        </pre>
      )}
      <div style={{ marginTop: 16 }}>
        {keys.map((k) => (
          <div className="setting-row" key={k.id}>
            <div className="info">
              <div className="name">{k.name} <span style={{ color: 'var(--text-faint)' }}>{k.prefix}…</span></div>
              <div className="desc">scopes: {k.scopes.join(', ')} · used: {k.lastUsed ?? 'never'}</div>
            </div>
            <button className="btn danger" onClick={async () => { await api.revokeKey(k.id); load(); }}>Revoke</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Shares() {
  const notify = useStore((s) => s.notify);
  const openFile = useStore((s) => s.openFile);
  const setOpen = useStore((s) => s.setSettings);
  // Shared with the store so the file tree's globe badges refresh on changes.
  const shares = useStore((s) => s.shares);
  const load = useStore((s) => s.loadShares);
  const [query, setQuery] = useState('');
  useEffect(() => { load(); }, [load]);

  const url = (id: string) => `${location.origin}/share/${id}`;
  const copy = (id: string) => {
    navigator.clipboard?.writeText(url(id)).catch(() => {});
    notify('Public link copied');
  };
  const toggle = async (s: any) => {
    await api.setShareEnabled(s.id, !s.enabled);
    load();
  };
  const remove = async (s: any) => {
    if (!confirm(`Delete the public link for "${s.path}"? The URL stops working permanently.`)) return;
    await api.deleteShare(s.id);
    load();
  };
  const setPassword = async (s: any) => {
    const pw = prompt(
      s.hasPassword
        ? 'New password for this link (leave empty to REMOVE the password):'
        : 'Password for this link:',
    );
    if (pw === null) return;
    await api.setSharePassword(s.id, pw || null);
    notify(pw ? 'Password set' : 'Password removed');
    load();
  };

  const q = query.trim().toLowerCase();
  const filtered = q ? shares.filter((s) => s.path.toLowerCase().includes(q)) : shares;

  return (
    <div>
      <h2>Sharing</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        Notes shared via a public link are readable by <b>anyone with the URL</b>, without login.
        Create a link from a note's context menu ("Share…"). Disable keeps the URL for
        re-enabling later; delete revokes it permanently.
      </p>
      <input
        className="text-input"
        style={{ width: '100%', margin: '6px 0 12px' }}
        placeholder="Search shared notes…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {filtered.length === 0 && (
        <div style={{ color: 'var(--text-faint)' }}>
          {shares.length === 0 ? 'No notes are shared publicly.' : 'No shared note matches the search.'}
        </div>
      )}
      {filtered.map((s) => (
        <div className="setting-row" key={s.id}>
          <div className="info" style={{ minWidth: 0 }}>
            <div
              className="name"
              style={{ cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: s.enabled ? 1 : 0.55 }}
              title={`Open ${s.path}`}
              onClick={() => { openFile(s.path); setOpen(false); }}
            >
              {s.path}
            </div>
            <div className="desc">
              {s.enabled ? 'active' : 'disabled'}
              {s.hasPassword ? ' · password-protected' : ''} · created {new Date(s.createdAt).toLocaleDateString()}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            <button className="btn secondary" disabled={!s.enabled} onClick={() => copy(s.id)} title={url(s.id)}>
              <Icon name="link" size={14} /> Copy link
            </button>
            <button className="btn secondary" onClick={() => setPassword(s)} title={s.hasPassword ? 'Change or remove password' : 'Require a password to open the link'}>
              {s.hasPassword ? 'Password ✓' : 'Password…'}
            </button>
            <button className={`btn ${s.enabled ? 'secondary' : ''}`} onClick={() => toggle(s)}>
              {s.enabled ? 'Disable' : 'Enable'}
            </button>
            <button className="btn danger" onClick={() => remove(s)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Plugins() {
  const [plugins, setPlugins] = useState<any[]>([]);
  const [repo, setRepo] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api.listPlugins().then((r) => setPlugins(r.plugins)).catch(() => {});
  useEffect(() => { load(); }, []);
  const install = async () => {
    setMsg('Installing…');
    try { await api.installPlugin(repo); setMsg('Installed ✓'); setRepo(''); await load(); }
    catch (e: any) { setMsg(`Error: ${e.message}`); }
  };
  return (
    <div>
      <h2>Community Plugins</h2>
      <Row name="Install from GitHub" desc="owner/repo — pulls manifest.json + main.js from latest release">
        <span style={{ display: 'flex', gap: 8 }}>
          <input className="text-input" placeholder="blacksmithgu/obsidian-dataview" value={repo} onChange={(e) => setRepo(e.target.value)} />
          <button className="btn" onClick={install}>Install</button>
        </span>
      </Row>
      {msg && <div style={{ color: 'var(--text-muted)', margin: '6px 0' }}>{msg}</div>}
      <div style={{ marginTop: 12 }}>
        {plugins.length === 0 && <div style={{ color: 'var(--text-faint)' }}>No plugins installed in .obsidian/plugins</div>}
        {plugins.map((p) => (
          <div className="setting-row" key={p.id}>
            <div className="info">
              <div className="name">{p.name} <span style={{ color: 'var(--text-faint)' }}>v{p.version}</span></div>
              <div className="desc">{p.description}</div>
            </div>
            <label>
              <input type="checkbox" checked={p.enabled} onChange={async (e) => { await api.setPluginEnabled(p.id, e.target.checked); load(); }} /> enabled
            </label>
          </div>
        ))}
      </div>
      <p style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 14 }}>
        Note: WebObsidian supports a subset of the Obsidian plugin API. Most metadata/markdown plugins work; plugins relying on Electron/Node internals may not.
      </p>
    </div>
  );
}

function Appearance({ s }: { s: any }) {
  const [theme, setTheme] = useState(s.ui.theme);
  const save = async (t: string) => { setTheme(t); await api.putSettings({ ui: { theme: t } }); location.reload(); };
  return (
    <div>
      <h2>Appearance</h2>
      <Row name="Theme">
        <select className="text-input" value={theme} onChange={(e) => save(e.target.value)}>
          <option value="obsidian-dark">Obsidian Dark</option>
          <option value="obsidian-light">Obsidian Light</option>
        </select>
      </Row>
    </div>
  );
}

function AccountSettings({ s, reload }: { s: any; reload: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const usingDefault = !s?.auth?.hasCustomPassword;

  const save = async () => {
    setErr('');
    setMsg('');
    if (next.length < 6) {
      setErr('Mật khẩu mới phải có ít nhất 6 ký tự');
      return;
    }
    if (next !== confirm) {
      setErr('Mật khẩu xác nhận không khớp');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setMsg('Đã đổi mật khẩu ✓');
      setCurrent('');
      setNext('');
      setConfirm('');
      await reload();
    } catch (e: any) {
      setErr(e?.message ?? 'Đổi mật khẩu thất bại');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2>Account</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        Mật khẩu đăng nhập vào WebObsidian.
        {usingDefault && (
          <>
            {' '}Bạn đang dùng <b>mật khẩu mặc định <code>123456</code></b> — hãy đổi mật khẩu để
            bảo mật vault.
          </>
        )}
      </p>
      <Row name="Mật khẩu hiện tại" desc={usingDefault ? 'Mặc định là 123456' : undefined}>
        <input className="text-input" type="password" style={{ width: 240 }} value={current}
          onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </Row>
      <Row name="Mật khẩu mới" desc="Tối thiểu 6 ký tự">
        <input className="text-input" type="password" style={{ width: 240 }} value={next}
          onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </Row>
      <Row name="Xác nhận mật khẩu mới">
        <input className="text-input" type="password" style={{ width: 240 }} value={confirm}
          onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </Row>
      {err && <div style={{ color: '#e5534b', margin: '6px 0' }}>{err}</div>}
      {msg && <div style={{ color: 'var(--text-accent, #4caf50)', margin: '6px 0' }}>{msg}</div>}
      <button className="btn" onClick={save} disabled={busy || !current || !next}>
        {busy ? 'Đang lưu…' : 'Đổi mật khẩu'}
      </button>
      <p style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 16 }}>
        Quên mật khẩu? Đặt <code>auth.passwordHash</code> trong <code>data/settings.json</code> hoặc
        biến môi trường <code>WEBOBSIDIAN_PASSWORD</code> làm mật khẩu khôi phục (override) rồi đăng
        nhập lại để đổi mật khẩu mới.
      </p>
    </div>
  );
}

function About() {
  const logout = async () => { await api.logout(); location.reload(); };
  return (
    <div>
      <h2>About WebObsidian</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        A self-hosted, Obsidian-compatible web app. Vault, QMD search, Git backup/version history (with LFS),
        agent API and community plugins.
      </p>
      <button className="btn danger" onClick={logout}>Log out</button>
    </div>
  );
}
