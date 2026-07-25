import { useMemo, useState } from 'react';
import { focusConnection, focusLocation } from '../graph/cyHolder';
import { directionGlyph } from '../graph/model';
import { useGraphStore } from '../state/store';

type Hit = {
  kind: 'location' | 'connection';
  id: string;
  title: string;
  sub: string;
  score: number;
};

export default function SearchPanel() {
  const [q, setQ] = useState('');
  const [includeNotes, setIncludeNotes] = useState(true);
  const locations = useGraphStore((s) => s.locations);
  const connections = useGraphStore((s) => s.connections);
  const selectLocation = useGraphStore((s) => s.selectLocation);
  const selectConnection = useGraphStore((s) => s.selectConnection);

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const out: Hit[] = [];

    const score = (haystack: string, weight: number) => {
      const h = (haystack || '').toLowerCase();
      if (!h) return 0;
      if (h === needle) return 100 * weight;
      if (h.startsWith(needle)) return 70 * weight;
      if (h.includes(needle)) return 40 * weight;
      return 0;
    };

    for (const l of Object.values(locations)) {
      let s = score(l.name, 1) + score(l.layer, 0.4);
      if (includeNotes) s += score(l.notes, 0.2);
      if (s > 0) {
        out.push({
          kind: 'location',
          id: l.id,
          title: l.name || 'Unnamed Location',
          sub: [l.layer, l.visited ? 'Visited' : 'Not Visited'].filter(Boolean).join(' · '),
          score: s
        });
      }
    }

    for (const c of Object.values(connections)) {
      let s = score(c.name, 0.9);
      if (includeNotes) s += score(c.notes, 0.2);
      if (s > 0) {
        const a = locations[c.sourceId]?.name || 'Unnamed';
        const b = locations[c.targetId]?.name || 'Unnamed';
        out.push({
          kind: 'connection',
          id: c.id,
          title: c.name || `${a} ${directionGlyph(c)} ${b}`,
          sub: `${a} ${directionGlyph(c)} ${b}${c.ephemeral ? ' · Ephemeral' : ''}${
            c.locked ? ' · Locked' : ''
          }`,
          score: s
        });
      }
    }

    return out.sort((x, y) => y.score - x.score).slice(0, 60);
  }, [q, locations, connections, includeNotes]);

  return (
    <section className="panel">
      <h2>Search</h2>
      <input
        value={q}
        placeholder="Find A Location Or Connection…"
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="check-field">
        <span className="field-label">Search Notes Too</span>
        <input
          type="checkbox"
          checked={includeNotes}
          onChange={(e) => setIncludeNotes(e.target.checked)}
        />
      </div>

      <ul className="hit-list">
        {hits.map((h) => (
          <li key={`${h.kind}:${h.id}`}>
            <button
              className="link"
              onClick={() =>
                h.kind === 'location'
                  ? focusLocation(h.id, selectLocation)
                  : focusConnection(h.id, selectConnection)
              }
            >
              <span className={`badge ${h.kind}`}>
                {h.kind === 'location' ? 'Location' : 'Connection'}
              </span>
              <span className="hit-title">{h.title}</span>
              <span className="muted small">{h.sub}</span>
            </button>
          </li>
        ))}
        {q.trim() && hits.length === 0 && <li className="muted">No Matches.</li>}
      </ul>
    </section>
  );
}
