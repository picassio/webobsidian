import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { useStore } from '../lib/store';
import {
  livePreviewPlugin,
  livePreviewState,
  livePreviewTheme,
  frontmatterField,
  tableField,
  htmlBlockField,
  noteTitleField,
  inlineTitleField,
  editorClickFix,
  setLivePreviewEnabled,
  setLivePreviewLinkHandler,
  setLivePreviewMenuHandler,
  setLivePreviewPropertyProvider,
  setLivePreviewPropertyTypes,
  setLivePreviewPropertyTypeSetter,
  setLivePreviewTagProvider,
  setNoteTitle,
} from '../lib/livePreview';
import { api } from '../lib/api';

const titleOf = (path: string | null) =>
  path ? (path.split('/').pop() ?? path).replace(/\.(md|markdown)$/i, '') : '';

export default function Editor() {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const applyingExternal = useRef(false);
  const activePath = useStore((s) => s.activePath);
  const content = useStore((s) => s.content);
  const setContent = useStore((s) => s.setContent);
  const save = useStore((s) => s.save);
  const viewMode = useStore((s) => s.viewMode);
  const openWikilink = useStore((s) => s.openWikilink);
  const openContextMenu = useStore((s) => s.openContextMenu);
  const setLeftPanel = useStore((s) => s.setLeftPanel);

  useEffect(() => {
    setLivePreviewLinkHandler(openWikilink);
  }, [openWikilink]);

  useEffect(() => {
    setLivePreviewMenuHandler(openContextMenu);
    setLivePreviewPropertyProvider(() => api.properties().then((r) => r.properties).catch(() => []));
    setLivePreviewTagProvider(() => api.tags().then((r) => r.tags.map((t) => t.tag)).catch(() => []));
  }, [openContextMenu]);

  // Load the vault's property type registry (.obsidian/types.json) once.
  useEffect(() => {
    setLivePreviewPropertyTypeSetter((key, type) => api.setPropertyType(key, type).then((r) => r.types));
    api
      .propertyTypes()
      .then((r) => {
        setLivePreviewPropertyTypes(r.types);
        const v = view.current;
        if (v) v.dispatch({ effects: setLivePreviewEnabled.of(v.state.field(livePreviewState)) });
      })
      .catch(() => {});
  }, []);

  // --- editor formatting actions (used by the right-click menu) ---
  const wrap = (before: string, after = before) => {
    const v = view.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    const sel = v.state.sliceDoc(from, to);
    v.dispatch({
      changes: { from, to, insert: before + sel + after },
      selection: { anchor: from + before.length, head: from + before.length + sel.length },
    });
    v.focus();
  };
  const prefixLines = (prefix: string) => {
    const v = view.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    const a = v.state.doc.lineAt(from).number;
    const b = v.state.doc.lineAt(to).number;
    const changes = [];
    for (let n = a; n <= b; n++) changes.push({ from: v.state.doc.line(n).from, insert: prefix });
    v.dispatch({ changes });
    v.focus();
  };
  const insert = (text: string, caretOffset = text.length) => {
    const v = view.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + caretOffset } });
    v.focus();
  };
  const copy = async () => {
    const v = view.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    await navigator.clipboard.writeText(v.state.sliceDoc(from, to)).catch(() => {});
  };
  const cut = async () => {
    const v = view.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    await navigator.clipboard.writeText(v.state.sliceDoc(from, to)).catch(() => {});
    v.dispatch({ changes: { from, to, insert: '' } });
    v.focus();
  };
  const paste = async () => {
    const t = await navigator.clipboard.readText().catch(() => '');
    if (t) insert(t);
  };
  const selectAll = () => {
    const v = view.current;
    if (v) v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const v = view.current;
    const sel = v ? v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) : '';
    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: 'Format', icon: 'pencil', submenu: [
            { label: 'Bold', onClick: () => wrap('**') },
            { label: 'Italic', onClick: () => wrap('*') },
            { label: 'Strikethrough', onClick: () => wrap('~~') },
            { label: 'Highlight', onClick: () => wrap('==') },
            { label: 'Inline code', onClick: () => wrap('`') },
          ],
        },
        {
          label: 'Paragraph', icon: 'file-text', submenu: [
            { label: 'Heading 1', onClick: () => prefixLines('# ') },
            { label: 'Heading 2', onClick: () => prefixLines('## ') },
            { label: 'Heading 3', onClick: () => prefixLines('### ') },
            { label: 'Bullet list', onClick: () => prefixLines('- ') },
            { label: 'Numbered list', onClick: () => prefixLines('1. ') },
            { label: 'Task list', onClick: () => prefixLines('- [ ] ') },
            { label: 'Quote', onClick: () => prefixLines('> ') },
            { label: 'Code block', onClick: () => wrap('```\n', '\n```') },
          ],
        },
        {
          label: 'Insert', icon: 'plus', submenu: [
            { label: 'Internal link', onClick: () => insert('[[]]', 2) },
            { label: 'External link', onClick: () => wrap('[', '](url)') },
            { label: 'Embed file', onClick: () => insert('![[]]', 3) },
            { label: 'Callout', onClick: () => insert('> [!note] Title\n> ', 18) },
            { label: 'Table', onClick: () => insert('\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n') },
            { label: 'Horizontal rule', onClick: () => insert('\n---\n') },
            { label: 'Tag', onClick: () => insert('#') },
          ],
        },
        { label: '', separator: true },
        { label: 'Cut', onClick: cut },
        { label: 'Copy', onClick: copy },
        { label: 'Paste', onClick: paste },
        { label: 'Select all', onClick: selectAll },
        ...(sel
          ? [
              { label: '', separator: true },
              { label: `Search for “${sel.slice(0, 24)}”`, icon: 'search', onClick: () => setLeftPanel('search') },
            ]
          : []),
      ],
    });
  };

  // (Re)create the view when the active file changes.
  useEffect(() => {
    if (!host.current) return;
    view.current?.destroy();

    const isMd = activePath ? /\.(md|markdown)$/i.test(activePath) : false;
    const isDark = !!document.querySelector('.theme-dark');
    // Place the caret after the frontmatter so Properties render immediately.
    const fmMatch = isMd ? content.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/) : null;
    const initPos = Math.min(fmMatch ? fmMatch[0].length : 0, content.length);
    const state = EditorState.create({
      doc: content,
      selection: { anchor: initPos },
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        markdown(),
        ...(isDark ? [oneDark] : [syntaxHighlighting(defaultHighlightStyle)]),
        EditorView.lineWrapping,
        livePreviewState.init(() => isMd && viewMode === 'live'),
        noteTitleField.init(() => titleOf(activePath)),
        inlineTitleField,
        frontmatterField,
        tableField,
        htmlBlockField,
        livePreviewPlugin,
        livePreviewTheme,
        editorClickFix,
        EditorView.updateListener.of((u) => {
          // Ignore doc changes we applied programmatically (external content sync)
          if (u.docChanged && !applyingExternal.current) setContent(u.state.doc.toString());
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    v.focus();
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  // Sync the editor doc when `content` changes from OUTSIDE the editor — e.g. the
  // active note's content arrives asynchronously after reload/hydrate, or is
  // pushed by cross-tab sync. (User typing changes content too, but then the doc
  // already equals content, so this is a no-op.)
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === content) return;
    applyingExternal.current = true;
    const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
    const initPos = Math.min(fmMatch ? fmMatch[0].length : 0, content.length);
    v.dispatch({
      changes: { from: 0, to: current.length, insert: content },
      selection: { anchor: initPos },
    });
    applyingExternal.current = false;
  }, [content]);

  // Toggle live preview when the view mode changes (without recreating editor).
  useEffect(() => {
    const isMd = activePath ? /\.(md|markdown)$/i.test(activePath) : false;
    view.current?.dispatch({
      effects: [setLivePreviewEnabled.of(isMd && viewMode === 'live'), setNoteTitle.of(titleOf(activePath))],
    });
  }, [viewMode, activePath]);

  // Debounced autosave.
  useEffect(() => {
    const id = window.setTimeout(() => save(), 900);
    return () => window.clearTimeout(id);
  }, [content, save]);

  return <div className={`cm-host ${viewMode === 'live' ? 'live-preview' : ''}`} ref={host} onContextMenu={onContextMenu} />;
}
