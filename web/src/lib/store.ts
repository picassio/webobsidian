import { create } from 'zustand';
import { api, type TreeNode } from './api';

/** Per-tab id so we can ignore the echo of our own server-pushed state change. */
export const CLIENT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export type ViewMode = 'live' | 'source' | 'reading';

export interface Tab {
  path: string;
  title: string;
}

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  separator?: boolean;
  icon?: string;
  onClick?: () => void;
  submenu?: ContextMenuItem[];
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface AppState {
  authed: boolean;
  setAuthed: (v: boolean) => void;

  tree: TreeNode | null;
  loadTree: () => Promise<void>;

  tabs: Tab[];
  activePath: string | null;
  content: string;
  dirty: boolean;
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;

  // expanded folders in the file tree (persisted)
  expanded: string[];
  toggleFolder: (path: string) => void;

  // split pane (open to the side)
  splitPath: string | null;
  splitContent: string;
  openToSide: (path: string) => Promise<void>;
  closeSplit: () => void;

  recent: string[];
  bookmarks: string[];
  toggleBookmark: (path: string) => void;

  leftPanel: 'files' | 'search' | 'tags' | 'bookmarks';
  setLeftPanel: (p: 'files' | 'search' | 'tags' | 'bookmarks') => void;
  leftOpen: boolean;
  rightOpen: boolean;
  toggleLeft: () => void;
  toggleRight: () => void;

  paletteOpen: boolean;
  paletteMode: 'all' | 'commands' | 'files';
  setPalette: (v: boolean, mode?: 'all' | 'commands' | 'files') => void;
  settingsOpen: boolean;
  setSettings: (v: boolean) => void;
  graphOpen: boolean;
  setGraph: (v: boolean) => void;

  contextMenu: ContextMenuState | null;
  openContextMenu: (m: ContextMenuState) => void;
  closeContextMenu: () => void;

  toast: string;
  notify: (msg: string) => void;

  openFile: (path: string) => Promise<void>;
  openWikilink: (target: string) => Promise<void>;
  closeTab: (path: string) => void;
  setContent: (c: string) => void;
  save: () => Promise<void>;
  createNote: (path: string, body?: string) => Promise<void>;
  openDailyNote: () => Promise<void>;
  /** Re-fetch content for the active/split tabs (after reload or remote sync). */
  hydrate: () => Promise<void>;
  /** Load persisted workspace state from the server and apply it. */
  loadUiState: () => Promise<void>;
  /** Apply a workspace state pushed from another tab/device. */
  applyRemoteState: (state: any, originId: string) => Promise<void>;
}

const TEXT_RE = /\.(md|markdown|txt|json|csv|canvas|css|js|ya?ml)$/i;

// ---- server-side workspace persistence (shared across browsers/devices) ----
const PERSIST_KEYS = [
  'tabs', 'activePath', 'viewMode', 'expanded', 'splitPath',
  'recent', 'bookmarks', 'leftPanel', 'leftOpen', 'rightOpen',
] as const;

function pickPersisted(s: any): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of PERSIST_KEYS) o[k] = s[k];
  return o;
}

function applyPersisted(s: any, set: (p: any) => void): void {
  set({
    tabs: Array.isArray(s.tabs) ? s.tabs : [],
    activePath: typeof s.activePath === 'string' ? s.activePath : null,
    viewMode: ['live', 'source', 'reading'].includes(s.viewMode) ? s.viewMode : 'live',
    expanded: Array.isArray(s.expanded) ? s.expanded : [],
    splitPath: typeof s.splitPath === 'string' ? s.splitPath : null,
    recent: Array.isArray(s.recent) ? s.recent : [],
    bookmarks: Array.isArray(s.bookmarks) ? s.bookmarks : [],
    leftPanel: ['files', 'search', 'tags', 'bookmarks'].includes(s.leftPanel) ? s.leftPanel : 'files',
    leftOpen: s.leftOpen !== false,
    rightOpen: s.rightOpen !== false,
  });
}

// Only start saving after the initial load; suppress while applying remote/initial state.
let canSave = false;
let suppressSave = false;
let saveTimer: number | undefined;
let lastSaved = '';

function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const payload = pickPersisted(useStore.getState());
    const json = JSON.stringify(payload);
    if (json === lastSaved) return;
    lastSaved = json;
    api.putUiState(payload, CLIENT_ID).catch(() => {});
  }, 500);
}

export const useStore = create<AppState>()(
    (set, get) => ({
      authed: false,
      setAuthed: (v) => set({ authed: v }),

      tree: null,
      loadTree: async () => {
        const tree = await api.tree();
        set({ tree });
      },

      tabs: [],
      activePath: null,
      content: '',
      dirty: false,
      viewMode: 'live',
      setViewMode: (m) => set({ viewMode: m }),

      expanded: [],
      toggleFolder: (path) =>
        set((s) => ({
          expanded: s.expanded.includes(path)
            ? s.expanded.filter((p) => p !== path)
            : [...s.expanded, path],
        })),

      splitPath: null,
      splitContent: '',
      openToSide: async (path) => {
        if (!TEXT_RE.test(path)) return;
        const r = await api.read(path);
        set({ splitPath: path, splitContent: typeof r === 'string' ? r : r.content });
      },
      closeSplit: () => set({ splitPath: null, splitContent: '' }),

      recent: [],
      bookmarks: [],
      toggleBookmark: (path) =>
        set((s) => ({
          bookmarks: s.bookmarks.includes(path)
            ? s.bookmarks.filter((p) => p !== path)
            : [...s.bookmarks, path],
        })),

      leftPanel: 'files',
      setLeftPanel: (p) => set({ leftPanel: p, leftOpen: true }),
      leftOpen: true,
      rightOpen: true,
      toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen })),
      toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),

      paletteOpen: false,
      paletteMode: 'all',
      setPalette: (v, mode = 'all') => set({ paletteOpen: v, paletteMode: mode }),
      settingsOpen: false,
      setSettings: (v) => set({ settingsOpen: v }),
      graphOpen: false,
      setGraph: (v) => set({ graphOpen: v }),

      contextMenu: null,
      openContextMenu: (m) => set({ contextMenu: m }),
      closeContextMenu: () => set({ contextMenu: null }),

      toast: '',
      notify: (msg) => {
        set({ toast: msg });
        window.setTimeout(() => set((s) => (s.toast === msg ? { toast: '' } : {})), 2500);
      },

      openFile: async (path) => {
        if (get().dirty) await get().save();
        let content = '';
        if (TEXT_RE.test(path)) {
          const r = await api.read(path);
          content = typeof r === 'string' ? r : r.content;
        }
        const title = path.split('/').pop() ?? path;
        set((s) => {
          const tabs = s.tabs.find((t) => t.path === path) ? s.tabs : [...s.tabs, { path, title }];
          const recent = [path, ...s.recent.filter((p) => p !== path)].slice(0, 20);
          return { tabs, activePath: path, content, dirty: false, recent };
        });
      },

      openWikilink: async (target) => {
        try {
          const { path } = await api.resolve(target);
          if (path) await get().openFile(path);
          else {
            const newPath = target.endsWith('.md') ? target : `${target}.md`;
            await get().createNote(newPath, `# ${target.replace(/\.md$/, '')}\n`);
          }
        } catch {
          /* ignore */
        }
      },

      closeTab: (path) =>
        set((s) => {
          const tabs = s.tabs.filter((t) => t.path !== path);
          const wasActive = s.activePath === path;
          const activePath = wasActive ? (tabs.at(-1)?.path ?? null) : s.activePath;
          return { tabs, activePath, ...(wasActive ? { content: '', dirty: false } : {}) };
        }),

      setContent: (c) => set({ content: c, dirty: true }),

      save: async () => {
        const { activePath, content, dirty } = get();
        if (!activePath || !dirty) return;
        if (!TEXT_RE.test(activePath)) return;
        await api.write(activePath, content);
        set({ dirty: false });
      },

      createNote: async (path, body) => {
        await api.write(path, body ?? '');
        await get().loadTree();
        await get().openFile(path);
      },

      openDailyNote: async () => {
        const d = new Date();
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
          d.getDate(),
        ).padStart(2, '0')}`;
        const path = `Daily/${iso}.md`;
        try {
          const { path: existing } = await api.resolve(iso);
          if (existing) {
            await get().openFile(existing);
            return;
          }
        } catch {
          /* none */
        }
        await get().createNote(path, `# ${iso}\n\n`);
        get().notify(`Daily note ${iso} ready`);
      },

      hydrate: async () => {
        // Active tab + split pane content aren't persisted (only the paths) —
        // re-read them from the vault after a reload. Drop tabs whose file is gone.
        const { activePath, splitPath, tabs } = get();
        if (activePath && TEXT_RE.test(activePath)) {
          try {
            const r = await api.read(activePath);
            set({ content: typeof r === 'string' ? r : r.content, dirty: false });
          } catch {
            set({
              tabs: tabs.filter((t) => t.path !== activePath),
              activePath: tabs.filter((t) => t.path !== activePath).at(-1)?.path ?? null,
              content: '',
            });
          }
        }
        if (splitPath && TEXT_RE.test(splitPath)) {
          try {
            const r = await api.read(splitPath);
            set({ splitContent: typeof r === 'string' ? r : r.content });
          } catch {
            set({ splitPath: null, splitContent: '' });
          }
        }
      },

      loadUiState: async () => {
        try {
          const s = await api.getUiState();
          suppressSave = true;
          applyPersisted(s, set);
          lastSaved = JSON.stringify(pickPersisted(get()));
          suppressSave = false;
        } catch {
          /* first run / not authed */
        }
        canSave = true;
        await get().hydrate();
      },

      applyRemoteState: async (state, originId) => {
        if (originId === CLIENT_ID) return; // ignore echo of our own change
        const prevActive = get().activePath;
        const prevSplit = get().splitPath;
        if (get().dirty) await get().save(); // don't lose local edits when switching
        suppressSave = true;
        applyPersisted(state, set);
        lastSaved = JSON.stringify(pickPersisted(get()));
        suppressSave = false;
        if (get().activePath !== prevActive || get().splitPath !== prevSplit) {
          await get().hydrate();
        }
      },
    }),
);

// Save durable workspace state to the server (debounced) whenever it changes.
useStore.subscribe((state, prev) => {
  if (!canSave || suppressSave) return;
  if (JSON.stringify(pickPersisted(state)) !== JSON.stringify(pickPersisted(prev))) {
    scheduleSave();
  }
});
