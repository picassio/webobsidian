import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { renderMarkdown } from '../lib/markdown';
import { api } from '../lib/api';

export default function Preview({ source }: { source?: string }) {
  const storeContent = useStore((s) => s.content);
  const content = source ?? storeContent;
  const activePath = useStore((s) => s.activePath);
  const openWikilink = useStore((s) => s.openWikilink);
  const openContextMenu = useStore((s) => s.openContextMenu);
  const setLeftPanel = useStore((s) => s.setLeftPanel);
  const [html, setHtml] = useState('');

  useEffect(() => {
    let cancelled = false;
    renderMarkdown(content, {
      rawUrl: (p) => api.rawUrl(p),
      resolveEmbed: async (target) => {
        try {
          const { path } = await api.resolve(target);
          if (!path) return null;
          const r = await api.read(path);
          return { path, content: typeof r === 'string' ? r : r.content };
        } catch {
          return null;
        }
      },
    }).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [content]);

  const onClick = (e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('[data-wikilink]') as HTMLElement | null;
    if (target) {
      e.preventDefault();
      const link = target.getAttribute('data-wikilink');
      if (link) openWikilink(link);
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const sel = window.getSelection()?.toString() ?? '';
    e.preventDefault();
    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Copy', icon: 'file-text', onClick: () => sel && navigator.clipboard.writeText(sel).catch(() => {}) },
        ...(sel
          ? [{ label: `Search for “${sel.slice(0, 24)}”`, icon: 'search', onClick: () => setLeftPanel('search') }]
          : []),
        { label: '', separator: true },
        { label: 'Select all', onClick: () => {
            const r = document.createRange();
            const el = (e.currentTarget as HTMLElement);
            r.selectNodeContents(el);
            const s = window.getSelection();
            s?.removeAllRanges();
            s?.addRange(r);
          } },
      ],
    });
  };

  // Inline title (note filename), Obsidian-style — skipped when the note already
  // opens with an H1 equal to the title (avoids duplicating the Trilium heading).
  const title = !source && activePath ? (activePath.split('/').pop() ?? '').replace(/\.(md|markdown)$/i, '') : '';
  const firstLine = content
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '')
    .split(/\r?\n/)
    .find((l) => l.trim() !== '');
  const h1 = firstLine?.match(/^#\s+(.+?)\s*$/);
  const showTitle = !!title && !(h1 && h1[1].trim().toLowerCase() === title.trim().toLowerCase());

  return (
    <div className="markdown-preview" onClick={onClick} onContextMenu={onContextMenu}>
      <div className="preview-inner">
        {showTitle && <div className="inline-title">{title}</div>}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
