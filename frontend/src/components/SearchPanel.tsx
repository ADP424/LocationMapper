import { useMemo, useState } from 'react';
import { formatCoordinates } from '../graph/coordinateLayout';
import { focusConnection, focusGroup, focusLocation } from '../graph/cyHolder';
import { directionGlyph } from '../graph/model';
import { useGraphStore } from '../state/store';
import { CheckField } from './fields';

type Hit = {
  kind: 'location' | 'connection' | 'group';
  id: string;
  title: string;
  sub: string;
  score: number;
};

const ALL = '__all__';

export default function SearchPanel() {
  const [q, setQ] = useState('');
  const [includeNotes, setIncludeNotes] = useState(true);
  const [searchLocations, setSearchLocations] = useState(true);
  const [searchConnections, setSearchConnections] = useState(true);
  const [labelFilter, setLabelFilter] = useState(ALL);

  const locations = useGraphStore((s) => s.locations);
  const connections = useGraphStore((s) => s.connections);
  const groups = useGraphStore((s) => s.groups);
  const locationLabels = useGraphStore((s) => s.locationLabels);
  const connectionLabels = useGraphStore((s) => s.connectionLabels);
  const selectLocation = useGraphStore((s) => s.selectLocation);
  const selectConnection = useGraphStore((s) => s.selectConnection);
  const selectGroup = useGraphStore((s) => s.selectGroup);

  const filter = useMemo(() => {
    if (labelFilter === ALL) return null;
    const [kind, id] = labelFilter.split(':');
    return { kind: kind as 'loc' | 'conn', id };
  }, [labelFilter]);

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase();
    const hasQuery = needle.length > 0;
    const out: Hit[] = [];

    const score = (haystack: string, weight: number) => {
      if (!hasQuery) return 1; // label-only filtering with no text still lists matches
      const h = (haystack || '').toLowerCase();
      if (!h) return 0;
      if (h === needle) return 100 * weight;
      if (h.startsWith(needle)) return 70 * weight;
      if (h.includes(needle)) return 40 * weight;
      return 0;
    };

    if (searchLocations && (!filter || filter.kind === 'loc')) {
      for (const l of Object.values(locations)) {
        if (filter && !l.labelIds.includes(filter.id)) continue;
        let s = score(l.name, 1) + score(l.layer, 0.4);
        for (const id of l.labelIds) s += score(locationLabels[id]?.name ?? '', 0.5);
        if (includeNotes) s += score(l.notes, 0.2);
        if (s > 0) {
          out.push({
            kind: 'location',
            id: l.id,
            title: l.name || 'Unnamed Location',
            sub: [formatCoordinates(l), l.layer, l.visited ? 'Visited' : 'Not Visited']
              .filter(Boolean)
              .join(' · '),
            score: s
          });
        }
      }
    }

    if (searchConnections && (!filter || filter.kind === 'conn')) {
      for (const c of Object.values(connections)) {
        if (filter && !c.labelIds.includes(filter.id)) continue;
        let s = score(c.name, 0.9);
        for (const id of c.labelIds) s += score(connectionLabels[id]?.name ?? '', 0.5);
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
    }

    if (!filter) {
      for (const g of Object.values(groups)) {
        let s = score(g.name, 1);
        if (includeNotes) s += score(g.notes, 0.2);
        if (s > 0) {
          const count = Object.values(locations).filter((l) => l.groupId === g.id).length;
          out.push({
            kind: 'group',
            id: g.id,
            title: g.name || 'Unnamed Grouping',
            sub: `${count} ${count === 1 ? 'Room' : 'Rooms'}`,
            score: s
          });
        }
      }
    }

    if (!hasQuery && !filter) return [];
    return out.sort((x, y) => y.score - x.score).slice(0, 60);
  }, [
    q,
    filter,
    includeNotes,
    searchLocations,
    searchConnections,
    locations,
    connections,
    groups,
    locationLabels,
    connectionLabels
  ]);

  return (
    <section className="panel">
      <h2>Search</h2>
      <input
        value={q}
        placeholder="Find A Location Or Connection…"
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="check-row triple">
        <CheckField
          className="center"
          label="Notes"
          checked={includeNotes}
          onChange={setIncludeNotes}
        />
        <CheckField
          className="center"
          label="Locations"
          checked={searchLocations}
          onChange={setSearchLocations}
        />
        <CheckField
          className="center"
          label="Connections"
          checked={searchConnections}
          onChange={setSearchConnections}
        />
      </div>

      <label className="field-center">
        Filter By Label
        <select value={labelFilter} onChange={(e) => setLabelFilter(e.target.value)}>
          <option value={ALL}>All Labels</option>
          <optgroup label="Location Labels">
            {Object.values(locationLabels)
              .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
              .map((l) => (
                <option key={l.id} value={`loc:${l.id}`}>
                  {l.name || 'Unnamed Label'}
                </option>
              ))}
          </optgroup>
          <optgroup label="Connection Labels">
            {Object.values(connectionLabels)
              .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
              .map((l) => (
                <option key={l.id} value={`conn:${l.id}`}>
                  {l.name || 'Unnamed Label'}
                </option>
              ))}
          </optgroup>
        </select>
      </label>

      <ul className="hit-list">
        {hits.map((h) => (
          <li key={`${h.kind}:${h.id}`}>
            <button
              className="link"
              onClick={() =>
                h.kind === 'location'
                  ? focusLocation(h.id, selectLocation)
                  : h.kind === 'connection'
                    ? focusConnection(h.id, selectConnection)
                    : focusGroup(h.id, selectGroup)
              }
            >
              <span className={`badge ${h.kind}`}>
                {h.kind === 'location' ? 'Location' : h.kind === 'connection' ? 'Connection' : 'Grouping'}
              </span>
              <span className="hit-title">{h.title}</span>
              <span className="muted small">{h.sub}</span>
            </button>
          </li>
        ))}
        {(q.trim() || filter) && hits.length === 0 && <li className="muted">No Matches.</li>}
      </ul>
    </section>
  );
}
