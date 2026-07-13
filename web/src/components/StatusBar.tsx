import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import Icon from './Icon';

export default function StatusBar() {
  const content = useStore((s) => s.content);
  const activePath = useStore((s) => s.activePath);
  const dirty = useStore((s) => s.dirty);
  const loadTree = useStore((s) => s.loadTree);
  const notify = useStore((s) => s.notify);
  const setSettings = useStore((s) => s.setSettings);
  const syncStatus = useStore((s) => s.syncStatus);
  const syncLag = useStore((s) => s.syncLag);
  const syncConflictCount = useStore((s) => s.syncConflictCount);
  const [git, setGit] = useState<any>(null);
  const [syncing, setSyncing] = useState(false);

  const refresh = () => api.gitStatus().then(setGit).catch(() => setGit(null));
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, []);

  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    notify('Creating Git backup…');
    try {
      const r = await api.gitSync();
      notify(r.ok ? 'Git backup complete ✓' : `Git backup: ${r.log.at(-1)}`);
      await loadTree();
      await refresh();
    } catch (e: any) {
      notify(`Git backup failed: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const isText = activePath && /\.(md|markdown|txt)$/i.test(activePath);
  const words = isText ? content.trim().split(/\s+/).filter(Boolean).length : 0;

  const gitLabel = !git?.isRepo
    ? 'No git backup'
    : git.clean
      ? `git ${git.branch}${git.ahead ? ` ↑${git.ahead}` : ''}${git.behind ? ` ↓${git.behind}` : ''}`
      : `${git.modified + git.notAdded} unsaved changes`;

  return (
    <div className="status-bar">
      {dirty && <span>Saving…</span>}
      {isText && <span>{words} words</span>}
      {isText && <span>{content.length} characters</span>}
      <span className="clickable" role="button" tabIndex={0} title="Open Central Sync settings" onClick={() => setSettings(true)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSettings(true); }}>
        <Icon name={syncStatus === 'synced' ? 'check' : syncStatus === 'offline' || syncStatus === 'error' ? 'alert-circle' : 'refresh-cw'} size={13} />
        {syncStatus === 'disabled' ? 'Sync not paired' : syncStatus === 'synced' ? `Synced${syncLag ? ` · ${syncLag} pending` : ''}` : syncStatus}
        {syncConflictCount > 0 ? ` · ${syncConflictCount} conflicts` : ''}
      </span>
      <span className="clickable" role="button" tabIndex={0} title="Run Git backup" onClick={sync} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') void sync(); }}>
        <Icon name="refresh-cw" size={13} style={syncing ? { animation: 'spin 1s linear infinite' } : undefined} />
        {gitLabel}
      </span>
    </div>
  );
}
