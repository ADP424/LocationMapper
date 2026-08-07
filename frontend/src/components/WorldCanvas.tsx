import { useEffect, useMemo, useRef, useState } from 'react';
import { useGraphStore } from '../state/store';
import { buildGraphData } from '../world/scene/graphData';
import { WorldView } from '../world/scene/worldView';
import type { StreamStats } from '../world/stream/streamer';
import { currentDimension, useWorldStore } from '../world/worldStore';

const SPEEDS = [0.25, 0.5, 1, 2, 4];

const n = (v: number) => v.toLocaleString();
const mb = (v: number) => `${(v / 1024 / 1024).toFixed(1)} MB`;

/**
 * The 3D canvas.
 *
 * React owns the data and the chrome; `WorldView` owns the render loop. The
 * only things that cross between them are the setter calls in the effects below
 * and the callbacks in `handlers`, which are re-pointed on every render so the
 * long-lived view always calls the current closures rather than the ones it was
 * built with.
 */
export default function WorldCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelHostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<WorldView | null>(null);

  const [flying, setFlying] = useState(false);
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [speed, setSpeed] = useState(1);

  const locations = useGraphStore((s) => s.locations);
  const connections = useGraphStore((s) => s.connections);
  const selection = useGraphStore((s) => s.selection);
  const mode = useGraphStore((s) => s.mode);
  const placingId = useGraphStore((s) => s.placingId);
  const labelMode = useGraphStore((s) => s.labelMode);

  const dimension = useWorldStore(currentDimension);
  const renderDistance = useWorldStore((s) => s.renderDistance);
  const spawn = useWorldStore((s) => s.source?.level?.spawn ?? null);

  const selectedId = selection?.type === 'location' ? selection.id : null;
  const graph = useMemo(() => buildGraphData(locations, connections), [locations, connections]);
  const placing = placingId ? locations[placingId] : null;

  /* Re-pointed every render: the view is built once and would otherwise hold
     the first render's store values forever. */
  const handlers = useRef({
    pickLocation: (_id: string) => {},
    pickBlock: (_x: number, _y: number, _z: number) => {},
    pickNothing: () => {},
    dragCoords: (_id: string, _x: number, _y: number, _z: number) => {}
  });

  handlers.current = {
    pickLocation: (id) => {
      const store = useGraphStore.getState();
      if (store.mode === 'connect') void store.handleConnectClick(id);
      else store.selectLocation(id);
    },
    pickBlock: (x, y, z) => {
      const store = useGraphStore.getState();
      if (store.placingId) {
        const id = store.placingId;
        store.queueCoords(id, x, y, z);
        store.setPlacing(null);
        store.selectLocation(id);
        void store.flushCoords();
        store.setStatus(`Placed At ${x}, ${y}, ${z}`);
        return;
      }
      if (store.mode === 'add-location') {
        void store.createLocationAtBlock(x, y, z);
        return;
      }
      store.select(null);
    },
    pickNothing: () => useGraphStore.getState().select(null),
    dragCoords: (id, x, y, z) => useGraphStore.getState().queueCoords(id, x, y, z)
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const labelHost = labelHostRef.current;
    if (!canvas || !labelHost) return;

    const view = new WorldView(canvas, labelHost, {
      onStats: setStats,
      onError: (message) => useGraphStore.getState().setError(message),
      onFlyChange: setFlying,
      onPickLocation: (id) => handlers.current.pickLocation(id),
      onPickBlock: (x, y, z) => handlers.current.pickBlock(x, y, z),
      onPickNothing: () => handlers.current.pickNothing(),
      onDragCoords: (id, x, y, z) => handlers.current.dragCoords(id, x, y, z)
    });
    viewRef.current = view;

    return () => {
      viewRef.current = null;
      view.dispose();
      /* A drag that ended inside the debounce window would otherwise be lost
         when the canvas unmounts on a view switch. */
      void useGraphStore.getState().flushCoords();
    };
  }, []);

  useEffect(() => {
    viewRef.current?.setDimension(dimension);
  }, [dimension]);

  useEffect(() => {
    viewRef.current?.setRenderDistance(renderDistance);
  }, [renderDistance]);

  useEffect(() => {
    viewRef.current?.setGraph(graph);
  }, [graph]);

  useEffect(() => {
    viewRef.current?.setSelection(selectedId);
  }, [selectedId]);

  useEffect(() => {
    /* The gizmo is a select-mode tool: in connect or add mode a click means
       something else, and dragging arrows would be in the way of it. */
    viewRef.current?.setGizmoEnabled(mode === 'select' && !placingId);
  }, [mode, placingId]);

  useEffect(() => {
    viewRef.current?.setLabelsVisible(labelMode !== 'none');
  }, [labelMode]);

  /**
   * Point the camera at something when a world opens.
   *
   * The graph wins when there is one — the reason to open a world here is to
   * see the map inside it — and spawn is the fallback for an empty map.
   */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.frameGraph(graph.markers)) return;
    if (spawn) view.goTo(spawn.x, spawn.y, spawn.z);
    /* Keyed on the world alone, deliberately. `graph` changes on every edit,
       and re-framing then would take the camera away from the user mid-drag.
       Reading the current markers without depending on them is the point. */
  }, [dimension, spawn]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const view = viewRef.current;
      if (!view) return;

      if (e.code === 'KeyF') {
        e.preventDefault();
        if (view.flying) view.exitFly();
        else view.enterFly();
        return;
      }

      /* Speed on the scroll wheel would fight zoom, so it lives on the number
         row the way every other flying camera does. */
      if (view.flying && e.code >= 'Digit1' && e.code <= 'Digit5') {
        const next = SPEEDS[Number(e.code.slice(5)) - 1];
        view.setFlySpeed(next);
        setSpeed(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hint = placing
    ? `Click A Block To Place "${placing.name || 'Untitled'}" — Esc To Cancel`
    : mode === 'add-location'
      ? 'Click A Block To Create A Location There'
      : mode === 'connect'
        ? 'Click A Source Marker, Then A Target Marker'
        : null;

  return (
    <div className={`world-canvas${flying ? ' flying' : ''}`}>
      <canvas ref={canvasRef} className="world-view" />
      <div ref={labelHostRef} className="world-labels" />
      <div className="world-crosshair" />

      {hint && <div className="canvas-hint">{hint}</div>}

      <div className="world-controls">
        <button onClick={() => (flying ? viewRef.current?.exitFly() : viewRef.current?.enterFly())}>
          {flying ? 'Exit First Person (Esc)' : 'First Person (F)'}
        </button>
        <button
          disabled={graph.markers.length === 0}
          onClick={() => viewRef.current?.frameGraph(graph.markers)}
        >
          Fit To Map
        </button>
        {spawn && (
          <button onClick={() => viewRef.current?.goTo(spawn.x, spawn.y, spawn.z)}>Go To Spawn</button>
        )}
      </div>

      {stats && (
        <div className="world-stats">
          <div className="row">
            <span>chunks drawn</span>
            <span>{n(stats.meshed)}</span>
          </div>
          <div className="row">
            <span>in memory</span>
            <span>{n(stats.loaded)}</span>
          </div>
          {stats.pending > 0 && (
            <div className="row">
              <span>queued</span>
              <span>{n(stats.pending)}</span>
            </div>
          )}
          <div className="row">
            <span>vertex data</span>
            <span>{mb(stats.vertexBytes)}</span>
          </div>
          <div className="row">
            <span>regions held</span>
            <span>{mb(stats.bytesHeld)}</span>
          </div>
        </div>
      )}

      <p className="world-hint">
        {flying ? (
          <>
            <kbd>W</kbd>
            <kbd>A</kbd>
            <kbd>S</kbd>
            <kbd>D</kbd> move · <kbd>Space</kbd> up · <kbd>C</kbd> down · <kbd>Shift</kbd> sprint ·{' '}
            <kbd>1</kbd>–<kbd>5</kbd> speed ({speed}×) · <kbd>Esc</kbd> release
          </>
        ) : (
          <>
            drag to orbit · scroll to zoom · click a marker to select · double-click to focus ·{' '}
            <kbd>F</kbd> for first person
          </>
        )}
      </p>
    </div>
  );
}
