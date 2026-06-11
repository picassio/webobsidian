import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { api, type TreeNode } from '../lib/api';

/** Collect every folder path in the vault, in tree order. */
function collectFolders(node: TreeNode | null): string[] {
  if (!node) return [];
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    for (const c of n.children ?? []) {
      if (c.type === 'folder') {
        out.push(c.path);
        walk(c);
      }
    }
  };
  walk(node);
  return out;
}

/**
 * Obsidian's "Move file to…" folder suggester: type to filter folders, ↑↓ to
 * navigate, ↵ to move into the highlighted folder, shift+↵ to create the typed
 * folder and move there, esc to dismiss. Driven by store.movePath.
 */
export default function FolderPicker() {
  const movePath = useStore((s) => s.movePath);
  const setMovePath = useStore((s) => s.setMovePath);
  const tree = useStore((s) => s.tree);
  const loadTree = useStore((s) => s.loadTree);
  const openFile = useStore((s) => s.openFile);
  const closeTab = useStore((s) => s.closeTab);
  const notify = useStore((s) => s.notify);

  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const from = movePath;
  const base = from ? from.split('/').pop()! : '';
  const currentDir = from && from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';

  // Root + every folder, minus targets that would move a folder into itself or a
  // descendant (and minus the file's own current folder — that move is a no-op).
  const folders = useMemo(() => {
    const all = ['', ...collectFolders(tree)];
    return all.filter((f) => {
      if (f === currentDir) return false;
      if (from && (f === from || f.startsWith(`${from}/`))) return false;
      return true;
    });
  }, [tree, from, currentDir]);

  const lc = q.trim().toLowerCase();
  const matches = useMemo(
    () => folders.filter((f) => !lc || (f || '/').toLowerCase().includes(lc)),
    [folders, lc],
  );

  // shift+↵ creates a new folder — offer it when the typed name isn't an exact match.
  const typed = q.trim().replace(/^\/+|\/+$/g, '');
  const canCreate = typed.length > 0 && !folders.some((f) => f.toLowerCase() === typed.toLowerCase());

  useEffect(() => {
    setQ('');
    setSel(0);
  }, [movePath]);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!movePath) return null;

  const move = async (folder: string) => {
    const to = folder ? `${folder.replace(/\/+$/, '')}/${base}` : base;
    const wasActive = useStore.getState().activePath === from;
    setMovePath(null);
    if (!from || to === from) return;
    try {
      await api.rename(from, to);
      closeTab(from);
      await loadTree();
      if (wasActive) await openFile(to);
      notify(`Moved to ${folder || 'vault root'}`);
    } catch (e: any) {
      notify(e?.message ?? 'Move failed');
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setMovePath(null);
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey && canCreate) move(typed);
      else if (matches[sel] !== undefined) move(matches[sel]);
      else if (canCreate) move(typed);
    }
  };

  return (
    <div className="modal-bg" onClick={() => setMovePath(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          placeholder="Type a folder"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette-list" ref={listRef}>
          {matches.map((f, i) => (
            <div
              key={f || '/'}
              className={`palette-item ${i === sel ? 'sel' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => move(f)}
            >
              <span>{f || '/'}</span>
            </div>
          ))}
          {canCreate && (
            <div
              className="palette-item"
              onMouseEnter={() => setSel(-1)}
              onClick={() => move(typed)}
            >
              <span>Create “{typed}”</span>
              <span className="kbd">⇧↵</span>
            </div>
          )}
          {matches.length === 0 && !canCreate && <div className="palette-item">No folders</div>}
        </div>
        <div className="palette-footer">
          <span><span className="kbd">↑↓</span> to navigate</span>
          <span><span className="kbd">↵</span> to move</span>
          <span><span className="kbd">⇧↵</span> to create</span>
          <span><span className="kbd">esc</span> to dismiss</span>
        </div>
      </div>
    </div>
  );
}
