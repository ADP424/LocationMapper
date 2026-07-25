import { useEffect } from 'react';
import DetailsPanel from './components/DetailsPanel';
import GraphCanvas from './components/GraphCanvas';
import Legend from './components/Legend';
import MapPicker from './components/MapPicker';
import SearchPanel from './components/SearchPanel';
import Toolbar from './components/Toolbar';
import { useGraphStore } from './state/store';

export default function App() {
  const init = useGraphStore((s) => s.init);
  const map = useGraphStore((s) => s.map);
  const mapId = useGraphStore((s) => s.mapId);
  const status = useGraphStore((s) => s.status);
  const error = useGraphStore((s) => s.error);
  const busy = useGraphStore((s) => s.busy);
  const setError = useGraphStore((s) => s.setError);
  const locationCount = useGraphStore((s) => Object.keys(s.locations).length);
  const connectionCount = useGraphStore((s) => Object.keys(s.connections).length);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      const store = useGraphStore.getState();

      if (e.key === 'Escape') {
        store.closeContextMenu();
        store.setMode('select');
        store.select(null);
        return;
      }
      if (typing) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && store.selection) {
        e.preventDefault();
        if (confirm('Delete the current selection?')) void store.deleteSelection();
      }
      if (e.key === 'n') store.setMode('add-location');
      if (e.key === 'c') store.setMode('connect');
      if (e.key === 'l') store.runLayout();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <div className="body">
        <nav className="sidebar">
          <MapPicker />
          <SearchPanel />
          <Legend />
        </nav>

        <main className="main">
          {mapId ? (
            <GraphCanvas />
          ) : (
            <div className="empty-state">
              <h1>MapGraph</h1>
              <p>
                Create Or Pick A Map On The Left. A Map Can Describe Anything — A
                Building's Rooms, A City's Districts, Or The Steps Of A Trip.
              </p>
            </div>
          )}
          <footer className="statusbar">
            <span>
              {map ? <strong>{map.name}</strong> : 'No Map Selected'} · {locationCount} Locations ·{' '}
              {connectionCount} Connections
            </span>
            {busy && <span className="pulse">Working…</span>}
            {status && <span className="ok">{status}</span>}
            {error && (
              <span className="err" onClick={() => setError(null)} title="Dismiss">
                ⚠ {error}
              </span>
            )}
          </footer>
        </main>

        <DetailsPanel />
      </div>
    </div>
  );
}
