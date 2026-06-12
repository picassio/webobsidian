import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { api, type TreeNode } from '../lib/api';
import { findNode } from '../lib/tree';
import { pathToUrl } from '../lib/urlsync';
import Icon from './Icon';

/** Inline rename box shown in place of a tree row's name (Obsidian-style). */
function RenameInput({ node, onDone }: { node: TreeNode; onDone: () => void }) {
  const loadTree = useStore((s) => s.loadTree);
  const closeTab = useStore((s) => s.closeTab);
  const notify = useStore((s) => s.notify);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the name but not the extension, like Obsidian.
    const dot = node.type === 'file' ? node.name.lastIndexOf('.') : -1;
    el.setSelectionRange(0, dot > 0 ? dot : node.name.length);
  }, [node.name, node.type]);

  const finish = (commit: boolean) => async () => {
    if (done.current) return;
    done.current = true;
    const name = (ref.current?.value ?? '').trim();
    onDone();
    if (!commit || !name || name === node.name) return;
    const dir = parentDir(node.path);
    const to = dir ? `${dir}/${name}` : name;
    if (to === node.path) return;
    try {
      await api.rename(node.path, to);
      closeTab(node.path);
    } catch (e: any) {
      notify(e?.message ?? 'Rename failed');
    }
    await loadTree();
  };

  return (
    <input
      ref={ref}
      className="tree-rename"
      defaultValue={node.name}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); void finish(true)(); }
        else if (e.key === 'Escape') { e.preventDefault(); void finish(false)(); }
      }}
      onBlur={finish(true)}
    />
  );
}

function fileIcon(node: TreeNode): string | null {
  const ext = node.ext ?? '';
  if (/\.(md|markdown)$/.test(ext)) return null; // markdown: text only, like Obsidian
  if (/\.(png|jpe?g|gif|svg|webp)$/.test(ext)) return 'image';
  if (ext === '.pdf') return 'file-pdf';
  return 'paperclip';
}

function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * Pick a name for `base` inside `targetDir` that doesn't collide with an
 * existing child — appends " copy" / " copy N" before the extension, like Obsidian.
 */
function uniqueChildName(tree: TreeNode | null, targetDir: string, base: string): string {
  const folder = targetDir ? findNode(tree, targetDir) : tree;
  const taken = new Set((folder?.children ?? []).map((c) => c.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let name = `${stem} copy${ext}`;
  for (let i = 1; taken.has(name.toLowerCase()); i++) name = `${stem} copy ${i}${ext}`;
  return name;
}

function Node({ node, depth }: { node: TreeNode; depth: number }) {
  const expanded = useStore((s) => s.expanded);
  const toggleFolder = useStore((s) => s.toggleFolder);
  const open = expanded.includes(node.path); // persisted across reloads
  const [dropping, setDropping] = useState(false);
  const activePath = useStore((s) => s.activePath);
  const openFile = useStore((s) => s.openFile);
  const openToSide = useStore((s) => s.openToSide);
  const loadTree = useStore((s) => s.loadTree);
  const closeTab = useStore((s) => s.closeTab);
  const openContextMenu = useStore((s) => s.openContextMenu);
  const setMovePath = useStore((s) => s.setMovePath);
  const clipboard = useStore((s) => s.clipboard);
  const setClipboard = useStore((s) => s.setClipboard);
  const newNote = useStore((s) => s.newNote);
  const newCanvas = useStore((s) => s.newCanvas);
  const newFolder = useStore((s) => s.newFolder);
  const renamingPath = useStore((s) => s.renamingPath);
  const setRenamingPath = useStore((s) => s.setRenamingPath);
  const toggleBookmark = useStore((s) => s.toggleBookmark);
  const bookmarks = useStore((s) => s.bookmarks);
  const notify = useStore((s) => s.notify);
  const setShareDialog = useStore((s) => s.setShareDialog);
  const shares = useStore((s) => s.shares);

  const isFolder = node.type === 'folder';
  const editing = renamingPath === node.path;
  const isCut = clipboard?.mode === 'cut' && clipboard.path === node.path;

  const doRename = () => setRenamingPath(node.path);
  const doDelete = async () => {
    if (confirm(`Move "${node.name}" to trash?`)) {
      await api.remove(node.path);
      closeTab(node.path);
      await loadTree();
      notify('Moved to trash');
    }
  };

  const doCopy = async () => {
    const r = await api.read(node.path).catch(() => null);
    if (!r) return;
    const content = typeof r === 'string' ? r : r.content;
    const dot = node.path.lastIndexOf('.');
    const copyPath = dot > 0 ? `${node.path.slice(0, dot)} copy${node.path.slice(dot)}` : `${node.path} copy`;
    await api.write(copyPath, content);
    await loadTree();
    notify('Made a copy');
  };
  const doMove = () => setMovePath(node.path);

  const doClipboard = (mode: 'copy' | 'cut') => () => {
    setClipboard({ path: node.path, mode });
    notify(mode === 'cut' ? 'Cut' : 'Copied');
  };
  const doPaste = async () => {
    const clip = useStore.getState().clipboard;
    if (!clip) return;
    const targetDir = isFolder ? node.path : parentDir(node.path);
    // Never paste a folder into itself or one of its own descendants.
    if (clip.path === targetDir || targetDir === clip.path || targetDir.startsWith(`${clip.path}/`)) {
      notify('Cannot paste into itself');
      return;
    }
    const base = clip.path.split('/').pop()!;
    const srcDir = parentDir(clip.path);
    if (clip.mode === 'cut') {
      if (targetDir === srcDir) { setClipboard(null); return; } // already here — no-op
      const to = targetDir ? `${targetDir}/${base}` : base;
      try {
        await api.rename(clip.path, to);
        closeTab(clip.path);
        setClipboard(null);
        await loadTree();
        notify('Moved');
      } catch (e: any) {
        notify(e?.message ?? 'Paste failed');
      }
      return;
    }
    // copy — recursive server-side copy (works for both files and folders).
    const name = uniqueChildName(useStore.getState().tree, targetDir, base);
    const to = targetDir ? `${targetDir}/${name}` : name;
    try {
      await api.copy(clip.path, to);
      await loadTree();
      notify('Pasted');
    } catch (e: any) {
      notify(e?.message ?? 'Paste failed');
    }
  };

  const copyPath = () => {
    navigator.clipboard?.writeText(node.path).catch(() => {});
    notify('Path copied');
  };
  const copyUrl = () => {
    navigator.clipboard?.writeText(`${location.origin}${pathToUrl(node.path)}`).catch(() => {});
    notify('URL copied');
  };

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items = isFolder
      ? [
          { label: 'New note', onClick: () => newNote(node.path) },
          { label: 'New canvas', onClick: () => newCanvas(node.path) },
          { label: 'New folder', onClick: () => newFolder(node.path) },
          { label: '', separator: true },
          { label: 'Copy', onClick: doClipboard('copy') },
          { label: 'Cut', onClick: doClipboard('cut') },
          ...(clipboard ? [{ label: 'Paste', onClick: doPaste }] : []),
          { label: '', separator: true },
          { label: 'Rename…', onClick: doRename },
          { label: 'Move folder to…', onClick: doMove },
          { label: 'Copy path', onClick: copyPath },
          { label: 'Copy URL path', onClick: copyUrl },
          { label: '', separator: true },
          { label: 'Delete', danger: true, onClick: doDelete },
        ]
      : [
          { label: 'Open', onClick: () => openFile(node.path) },
          { label: 'Open to the right', onClick: () => openToSide(node.path) },
          { label: '', separator: true },
          { label: bookmarks.includes(node.path) ? 'Remove bookmark' : 'Bookmark', onClick: () => toggleBookmark(node.path) },
          ...(/\.(md|markdown)$/i.test(node.path)
            ? [{ label: 'Share…', icon: 'globe', onClick: () => setShareDialog(node.path) }]
            : []),
          { label: 'Make a copy', onClick: doCopy },
          { label: '', separator: true },
          { label: 'Copy', onClick: doClipboard('copy') },
          { label: 'Cut', onClick: doClipboard('cut') },
          ...(clipboard ? [{ label: 'Paste', onClick: doPaste }] : []),
          { label: '', separator: true },
          { label: 'Rename…', onClick: doRename },
          { label: 'Move file to…', onClick: doMove },
          { label: 'Copy URL path', onClick: copyUrl },
          { label: '', separator: true },
          { label: 'Delete', danger: true, onClick: doDelete },
        ];
    openContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/wo-path', node.path);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropping(false);
    const from = e.dataTransfer.getData('text/wo-path');
    const targetDir = isFolder ? node.path : parentDir(node.path);
    if (!from || from === targetDir) return;
    const base = from.split('/').pop()!;
    const to = targetDir ? `${targetDir}/${base}` : base;
    if (to === from) return;
    await api.rename(from, to).catch((err) => notify(err.message));
    closeTab(from);
    await loadTree();
  };

  if (isFolder) {
    return (
      <div className="tree-item">
        <div
          className={`tree-row folder ${dropping ? 'drop-target' : ''}`}
          style={isCut ? { opacity: 0.5 } : undefined}
          onClick={() => toggleFolder(node.path)}
          onContextMenu={onContext}
          onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
          onDragLeave={() => setDropping(false)}
          onDrop={onDrop}
        >
          <span className="twisty">
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
          </span>
          {editing ? (
            <RenameInput node={node} onDone={() => setRenamingPath(null)} />
          ) : (
            <span className="name">{node.name}</span>
          )}
        </div>
        {open && (
          <div className="tree-children">
            {(node.children ?? []).map((c) => (
              <Node key={c.path} node={c} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const fi = fileIcon(node);
  return (
    <div className="tree-item">
      <div
        className={`tree-row ${activePath === node.path ? 'active' : ''}`}
        style={isCut ? { opacity: 0.5 } : undefined}
        data-path={node.path}
        draggable
        onDragStart={onDragStart}
        onClick={() => openFile(node.path)}
        onContextMenu={onContext}
        title={node.path}
      >
        <span className="twisty leaf" />
        {fi && <span className="twisty"><Icon name={fi} size={14} /></span>}
        {editing ? (
          <RenameInput node={node} onDone={() => setRenamingPath(null)} />
        ) : (
          <span className="name">{node.name.replace(/\.(md|markdown)$/, '')}</span>
        )}
        {shares.some((s) => s.path === node.path && s.enabled) && (
          <Icon name="globe" size={12} className="share-globe" />
        )}
        {bookmarks.includes(node.path) && <Icon name="bookmark" size={12} className="bm-star" />}
      </div>
    </div>
  );
}

export default function FileTree() {
  const tree = useStore((s) => s.tree);
  const loadTree = useStore((s) => s.loadTree);
  const notify = useStore((s) => s.notify);
  const closeTab = useStore((s) => s.closeTab);
  const clipboard = useStore((s) => s.clipboard);
  const setClipboard = useStore((s) => s.setClipboard);
  const openContextMenu = useStore((s) => s.openContextMenu);
  const newNote = useStore((s) => s.newNote);
  const newCanvas = useStore((s) => s.newCanvas);
  const newFolder = useStore((s) => s.newFolder);

  // "Reveal file in navigation": scroll + flash the row once its folders expand.
  useEffect(() => {
    const onReveal = (e: Event) => {
      const path = (e as CustomEvent<{ path: string }>).detail?.path;
      if (!path) return;
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`.tree-row[data-path="${CSS.escape(path)}"]`);
        if (!el) return;
        el.scrollIntoView({ block: 'center' });
        el.classList.add('reveal-flash');
        window.setTimeout(() => el.classList.remove('reveal-flash'), 1200);
      });
    };
    window.addEventListener('wo-reveal-file', onReveal);
    return () => window.removeEventListener('wo-reveal-file', onReveal);
  }, []);

  const onRootDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const from = e.dataTransfer.getData('text/wo-path');
    if (!from || !from.includes('/')) return;
    const base = from.split('/').pop()!;
    await api.rename(from, base).catch((err) => notify(err.message));
    await loadTree();
  };

  // Paste into the vault root (right-click on the empty area of the file tree).
  const pasteToRoot = async () => {
    const clip = useStore.getState().clipboard;
    if (!clip) return;
    const base = clip.path.split('/').pop()!;
    if (clip.mode === 'cut') {
      if (!clip.path.includes('/')) { setClipboard(null); return; } // already at root — no-op
      try {
        await api.rename(clip.path, base);
        closeTab(clip.path);
        setClipboard(null);
        await loadTree();
        notify('Moved');
      } catch (e: any) {
        notify(e?.message ?? 'Paste failed');
      }
      return;
    }
    const name = uniqueChildName(useStore.getState().tree, '', base);
    try {
      await api.copy(clip.path, name);
      await loadTree();
      notify('Pasted');
    } catch (e: any) {
      notify(e?.message ?? 'Paste failed');
    }
  };

  const onRootContext = (e: React.MouseEvent) => {
    e.preventDefault();
    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'New note', onClick: () => newNote('') },
        { label: 'New canvas', onClick: () => newCanvas('') },
        { label: 'New folder', onClick: () => newFolder('') },
        ...(clipboard
          ? [{ label: '', separator: true }, { label: 'Paste', onClick: pasteToRoot }]
          : []),
      ],
    });
  };

  if (!tree) return <div style={{ padding: 12, color: 'var(--text-faint)' }}>Loading…</div>;
  if (!tree.children?.length)
    return (
      <div
        onContextMenu={onRootContext}
        style={{ padding: 12, color: 'var(--text-faint)', minHeight: '100%' }}
      >
        Vault is empty.
      </div>
    );
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={onRootDrop}
      onContextMenu={onRootContext}
      style={{ minHeight: '100%' }}
    >
      {tree.children.map((c) => (
        <Node key={c.path} node={c} depth={0} />
      ))}
    </div>
  );
}
