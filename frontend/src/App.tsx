import { lazy, Suspense, useEffect } from 'react';
import DetailsPanel from './components/DetailsPanel';
import GraphCanvas from './components/GraphCanvas';
import GroupPanel from './components/GroupPanel';
import LabelPanel from './components/LabelPanel';
import Legend from './components/Legend';
import MapPicker from './components/MapPicker';
import SearchPanel from './components/SearchPanel';
import SettingsModal from './components/SettingsModal';
import Toolbar from './components/Toolbar';
import TripPlanner from './components/TripPlanner';
import WorldPanel from './components/WorldPanel';
import { inspectorCancel } from './components/useDraft';
import { useGraphStore } from './state/store';
import { pushEscapeHandler } from './utils/escapeStack';

/**
 * three.js is about 700 kB of the bundle and is useless to anyone who never
 * opens the 3D view, so it is fetched on the first switch instead of on load.
 * Only the canvas is split — `WorldPanel` carries no three.js and stays in the
 * main chunk so the sidebar renders instantly.
 */
const WorldCanvas = lazy(() => import('./components/WorldCanvas'));

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
  const viewMode = useGraphStore((s) => s.viewMode);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    /* bottom of the Escape stack: only reached when no overlay is open */
    const offEscape = pushEscapeHandler(() => {
      const store = useGraphStore.getState();
      store.closeContextMenu();
      store.setMode('select');
      store.setPlacing(null);
      store.select(null);
    });

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      const store = useGraphStore.getState();

      if (typing) return;
      /* Pointer locked means the 3D fly camera has the keyboard: C is descend,
         not "connect", and Backspace is not a delete request. */
      if (document.pointerLockElement) return;
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        (store.selection || store.multiSelect.length > 1)
      ) {
        e.preventDefault();
        if (confirm('Delete the current selection?')) {
          /* the rows are about to be gone: don't let the unmount PATCH them */
          inspectorCancel.current?.();
          void store.deleteSelection();
        }
      }
      if (e.key === 'n') store.setMode('add-location');
      if (e.key === 'c') store.setMode('connect');
      /* Re-layout is a 2D canvas verb: nothing in the 3D view arranges itself. */
      if (e.key === 'l' && store.viewMode === '2d') store.runLayout();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      offEscape();
    };
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <SettingsModal />
      <div className="body">
        <nav className="sidebar">
          <MapPicker />
          {mapId && viewMode === '3d' && <WorldPanel />}
          <SearchPanel />
          <TripPlanner />
          <GroupPanel />
          <LabelPanel />
          <Legend />
        </nav>

        <main className="main">
          {mapId ? (
            /* Keyed so a mode switch unmounts one canvas before mounting the
               other: both hold GPU resources, and neither should be alive
               while the other is initialising. */
            viewMode === '3d' ? (
              <Suspense fallback={<div className="empty-state">Loading The 3D View…</div>}>
                <WorldCanvas key="3d" />
              </Suspense>
            ) : (
              <GraphCanvas key="2d" />
            )
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
