import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { renderMarkdown } from '../lib/markdown';
import { calloutIconSvg } from '../lib/callouts';
import { api } from '../lib/api';

let katexP: Promise<typeof import('katex')['default']> | null = null;
const loadKatex = () =>
  (katexP ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([k]) => k.default));
let mermaidP: Promise<typeof import('mermaid')['default']> | null = null;
const loadMermaid = () =>
  (mermaidP ??= import('mermaid').then((m) => {
    m.default.initialize({
      startOnLoad: false,
      theme: document.querySelector('.theme-dark') ? 'dark' : 'default',
    });
    return m.default;
  }));
let mmdSeq = 0;

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

  // Post-render pass — same renderers as Live Preview so both modes match:
  // KaTeX for [data-tex] spans, mermaid for ```mermaid fences, callout icons.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    let cancelled = false;
    for (const el of root.querySelectorAll<HTMLElement>('.callout-icon[data-callout-icon]')) {
      el.innerHTML = calloutIconSvg(el.dataset.calloutIcon ?? 'default');
    }
    if (root.querySelector('[data-tex]')) {
      void loadKatex().then((katex) => {
        if (cancelled) return;
        for (const el of root.querySelectorAll<HTMLElement>('[data-tex]')) {
          try {
            katex.render(el.dataset.tex ?? '', el, {
              throwOnError: false,
              displayMode: el.dataset.texDisplay === '1',
            });
          } catch {
            /* keep raw tex */
          }
        }
      });
    }
    const mmd = root.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
    if (mmd.length) {
      void loadMermaid().then(async (mermaid) => {
        for (const codeEl of mmd) {
          if (cancelled) return;
          const pre = codeEl.parentElement!;
          try {
            const { svg } = await mermaid.render(`read-mmd-${++mmdSeq}`, codeEl.textContent ?? '');
            const div = document.createElement('div');
            div.className = 'mermaid';
            div.innerHTML = svg;
            pre.replaceWith(div);
          } catch {
            document.getElementById(`dread-mmd-${mmdSeq}`)?.remove();
          }
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [html]);

  const onClick = (e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('[data-wikilink]') as HTMLElement | null;
    if (target) {
      e.preventDefault();
      const link = target.getAttribute('data-wikilink');
      if (link) openWikilink(link);
      return;
    }
    // Foldable callout: clicking the title toggles its content.
    const title = (e.target as HTMLElement).closest('.callout[data-callout-fold="-"] > .callout-title, .callout[data-callout-fold="+"] > .callout-title');
    if (title) title.parentElement?.classList.toggle('is-collapsed');
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
        <div ref={bodyRef} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
