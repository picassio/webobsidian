import { useEffect, useRef, useState } from 'react';
import { api, type SearchHit } from '../lib/api';
import { useStore } from '../lib/store';

export default function SearchPanel() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const openFile = useStore((s) => s.openFile);
  const searchQuery = useStore((s) => s.searchQuery);
  const timer = useRef<number>();

  // adopt a query pushed from elsewhere (e.g. clicking a tag node in the graph)
  useEffect(() => {
    if (searchQuery) setQ(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!q.trim()) {
      setHits([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        const r = await api.search(q, 50);
        setHits(r.hits);
      } catch {
        setHits([]);
      }
    }, 180);
    return () => window.clearTimeout(timer.current);
  }, [q]);

  return (
    <div>
      <div className="search-input-wrap">
        <input
          className="search-input"
          placeholder="Search   (try tag:idea, path:notes)"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {q && (
        <div style={{ padding: '4px 12px', color: 'var(--text-faint)', fontSize: 12 }}>
          {hits.length} result{hits.length === 1 ? '' : 's'}
        </div>
      )}
      {hits.map((h) => (
        <div key={h.path} className="result" onClick={() => openFile(h.path)}>
          <div className="r-title">{h.title}</div>
          <div className="r-path">{h.path}</div>
          {h.snippet && <div className="r-snip">{h.snippet}</div>}
        </div>
      ))}
    </div>
  );
}
