import { useState } from 'react';
import { useGraphStore } from '../state/store';

export default function MapPicker() {
  const maps = useGraphStore((s) => s.maps);
  const mapId = useGraphStore((s) => s.mapId);
  const openMap = useGraphStore((s) => s.openMap);
  const createMap = useGraphStore((s) => s.createMap);
  const deleteMap = useGraphStore((s) => s.deleteMap);
  const [name, setName] = useState('');

  return (
    <section className="panel">
      <h2>Maps</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          void createMap(trimmed);
          setName('');
        }}
      >
        <input
          value={name}
          placeholder="New Map Name…"
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit">Create</button>
      </form>

      <ul className="map-list">
        {maps.map((m) => (
          <li key={m.id} className={m.id === mapId ? 'selected' : ''}>
            <button className="link" onClick={() => void openMap(m.id)}>
              <span className="map-name">{m.name}</span>
              <span className="muted small">
                {m.locationCount} Locations · {m.connectionCount} Connections
              </span>
            </button>
            <button
              className="icon danger"
              title="Delete Map"
              onClick={() => {
                if (confirm(`Delete map "${m.name}" and everything in it?`)) {
                  void deleteMap(m.id);
                }
              }}
            >
              ✕
            </button>
          </li>
        ))}
        {maps.length === 0 && <li className="muted">No Maps Yet — Create One.</li>}
      </ul>
    </section>
  );
}
