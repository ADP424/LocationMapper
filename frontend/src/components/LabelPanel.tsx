import { useMemo, useState } from 'react';
import { useGraphStore } from '../state/store';

export default function LabelPanel() {
  const locationLabels = useGraphStore((s) => s.locationLabels);
  const connectionLabels = useGraphStore((s) => s.connectionLabels);
  const locations = useGraphStore((s) => s.locations);
  const connections = useGraphStore((s) => s.connections);
  const createLocationLabel = useGraphStore((s) => s.createLocationLabel);
  const createConnectionLabel = useGraphStore((s) => s.createConnectionLabel);
  const selectLocationLabel = useGraphStore((s) => s.selectLocationLabel);
  const selectConnectionLabel = useGraphStore((s) => s.selectConnectionLabel);
  const mapId = useGraphStore((s) => s.mapId);

  const [locName, setLocName] = useState('');
  const [connName, setConnName] = useState('');

  const locCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of Object.values(locations)) {
      for (const id of l.labelIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [locations]);

  const connCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of Object.values(connections)) {
      for (const id of c.labelIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [connections]);

  const sorted = <T extends { name: string }>(rows: T[]) =>
    rows.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return (
    <section className="panel">
      <h2>Labels</h2>

      <h3>Location Labels</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const n = locName.trim();
          if (!n) return;
          void createLocationLabel(n);
          setLocName('');
        }}
      >
        <input
          value={locName}
          disabled={!mapId}
          placeholder="New Location Label…"
          onChange={(e) => setLocName(e.target.value)}
        />
        <button type="submit" disabled={!mapId}>
          Add
        </button>
      </form>
      <ul className="hit-list">
        {sorted(Object.values(locationLabels)).map((l) => (
          <li key={l.id}>
            <button className="link" onClick={() => selectLocationLabel(l.id)}>
              <span className="hit-title">
                <span className="group-dot" style={{ background: l.color || '#8897ad' }} />
                {l.name || 'Unnamed Label'}
              </span>
              <span className="muted small">
                {locCounts.get(l.id) ?? 0} {(locCounts.get(l.id) ?? 0) === 1 ? 'Room' : 'Rooms'}
                {l.restartTargets.length
                  ? ` · ↻ Restarts To ${l.restartTargets.length} ${
                      l.restartTargets.length === 1 ? 'Location' : 'Locations'
                    }`
                  : ''}
              </span>
            </button>
          </li>
        ))}
        {Object.keys(locationLabels).length === 0 && <li className="muted small">None Yet.</li>}
      </ul>

      <h3>Connection Labels</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const n = connName.trim();
          if (!n) return;
          void createConnectionLabel(n);
          setConnName('');
        }}
      >
        <input
          value={connName}
          disabled={!mapId}
          placeholder="New Connection Label…"
          onChange={(e) => setConnName(e.target.value)}
        />
        <button type="submit" disabled={!mapId}>
          Add
        </button>
      </form>
      <ul className="hit-list">
        {sorted(Object.values(connectionLabels)).map((l) => (
          <li key={l.id}>
            <button className="link" onClick={() => selectConnectionLabel(l.id)}>
              <span className="hit-title">
                <span className="group-dot" style={{ background: l.color || '#8897ad' }} />
                {l.name || 'Unnamed Label'}
              </span>
              <span className="muted small">
                {connCounts.get(l.id) ?? 0}{' '}
                {(connCounts.get(l.id) ?? 0) === 1 ? 'Connection' : 'Connections'}
              </span>
            </button>
          </li>
        ))}
        {Object.keys(connectionLabels).length === 0 && <li className="muted small">None Yet.</li>}
      </ul>
    </section>
  );
}
