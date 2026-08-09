import { useEffect, useMemo, useRef, useState } from 'react';
import { useGraphStore } from '../state/store';
import { isPlaced, MARKER_MODE_LABELS, type MarkerMode } from '../world/scene/graphData';
import { CheckField } from './fields';

type BaseMarkerMode = Exclude<MarkerMode, 'route'>;
import { canPickDirectory } from '../world/source/worldSource';
import { TOUR_SPEED_BASE, TOUR_SPEED_MAX, TOUR_SPEED_MIN, UNLIMITED } from '../world/worldPrefs';
import { useWorldStore } from '../world/worldStore';

const DISTANCES = [4, 8, 12, 16, 20, 24];

/**
 * Sidebar panel for the 3D view: which world is open, and which locations still
 * have nowhere to be drawn.
 *
 * The unplaced list is the whole reason this is a panel and not a menu. A map
 * built in 2D has no coordinates at all to begin with, so on the first visit
 * every location is unplaced, and the answer to "why is my map not here" needs
 * to be sitting in front of the user rather than inferred from an empty scene.
 */
export default function WorldPanel() {
  const mapId = useGraphStore((s) => s.mapId);
  const locations = useGraphStore((s) => s.locations);
  const selection = useGraphStore((s) => s.selection);
  const placingId = useGraphStore((s) => s.placingId);
  const setPlacing = useGraphStore((s) => s.setPlacing);
  const selectLocation = useGraphStore((s) => s.selectLocation);
  const updateLocation = useGraphStore((s) => s.updateLocation);

  const bind = useWorldStore((s) => s.bind);
  const source = useWorldStore((s) => s.source);
  const loading = useWorldStore((s) => s.loading);
  const error = useWorldStore((s) => s.error);
  const savedRoot = useWorldStore((s) => s.root);
  const dimensionId = useWorldStore((s) => s.dimensionId);
  const renderDistance = useWorldStore((s) => s.renderDistance);
  const openPath = useWorldStore((s) => s.openPath);
  const openPicker = useWorldStore((s) => s.openPicker);
  const openDirectoryInput = useWorldStore((s) => s.openDirectoryInput);
  const close = useWorldStore((s) => s.close);
  const setDimensionId = useWorldStore((s) => s.setDimensionId);
  const setRenderDistance = useWorldStore((s) => s.setRenderDistance);
  const markerMode = useWorldStore((s) => s.markerMode);
  const markerDistance = useWorldStore((s) => s.markerDistance);
  const labelDistance = useWorldStore((s) => s.labelDistance);
  const routeOnly = useWorldStore((s) => s.routeOnly);
  const setMarkerMode = useWorldStore((s) => s.setMarkerMode);
  const setRouteOnly = useWorldStore((s) => s.setRouteOnly);
  const setMarkerDistance = useWorldStore((s) => s.setMarkerDistance);
  const setLabelDistance = useWorldStore((s) => s.setLabelDistance);
  const tourSpeed = useWorldStore((s) => s.tourSpeed);
  const setTourSpeed = useWorldStore((s) => s.setTourSpeed);
  const labelMode = useGraphStore((s) => s.labelMode);

  const [path, setPath] = useState(savedRoot);
  const dirRef = useRef<HTMLInputElement>(null);

  useEffect(() => bind(mapId), [mapId, bind]);
  useEffect(() => setPath(savedRoot), [savedRoot]);

  const unplaced = useMemo(
    () => Object.values(locations).filter((l) => !isPlaced(l)).sort((a, b) => a.name.localeCompare(b.name)),
    [locations]
  );
  const placedCount = Object.keys(locations).length - unplaced.length;
  const hasPlan = useGraphStore((s) => Boolean(s.trip.plan?.locationIds.length));

  const selectedId = selection?.type === 'location' ? selection.id : null;
  const selected = selectedId ? locations[selectedId] : null;

  return (
    <section className="panel world-panel">
      <div className="panel-head">
        <h2>Minecraft World</h2>
        {source && (
          <button className="link" onClick={close}>
            Close
          </button>
        )}
      </div>

      {!source && (
        <>
          <label className="small muted" htmlFor="world-path">
            World Folder On This Machine
          </label>
          <input
            id="world-path"
            type="text"
            spellCheck={false}
            placeholder="C:\…\saves\MyWorld"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && path.trim()) void openPath(path.trim().replace(/^"|"$/g, ''));
            }}
          />
          <button
            className="primary"
            disabled={loading || !path.trim()}
            onClick={() => void openPath(path.trim().replace(/^"|"$/g, ''))}
          >
            {loading ? 'Reading…' : 'Open From Path'}
          </button>
          <p className="small muted">
            Read by the dev server — no permission prompt. The folder is the one containing
            level.dat.
          </p>

          {canPickDirectory() ? (
            <button disabled={loading} onClick={() => void openPicker()}>
              …Or Browse For The Folder
            </button>
          ) : (
            <>
              <button disabled={loading} onClick={() => dirRef.current?.click()}>
                …Or Browse For The Folder
              </button>
              <input
                ref={dirRef}
                type="file"
                hidden
                /* React has no typing for this attribute; the DOM has had it
                   for years and it is the only fallback Firefox offers. */
                {...({ webkitdirectory: '' } as Record<string, string>)}
                onChange={(e) => {
                  if (e.target.files?.length) void openDirectoryInput(e.target.files);
                  e.target.value = '';
                }}
              />
            </>
          )}
          <p className="small muted">
            With no world open the map floats over a plain grid — coordinates still work.
          </p>
        </>
      )}

      {source && (
        <>
          <div className="world-summary">
            <div className="map-name">{source.level?.name || source.label}</div>
            <div className="small muted">
              {source.level?.versionName ?? `DataVersion ${source.level?.dataVersion ?? '?'}`} ·{' '}
              {source.dimensions.reduce((s, d) => s + d.regions.length, 0)} region files
            </div>
          </div>

          <label className="inline-label">
            Dimension
            <select value={dimensionId} onChange={(e) => setDimensionId(e.target.value)}>
              {source.dimensions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label} — {d.regions.length} regions
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      <label className="inline-label">
        Render Distance
        <select value={renderDistance} onChange={(e) => setRenderDistance(Number(e.target.value))}>
          {DISTANCES.map((d) => (
            <option key={d} value={d}>
              {d} chunks{d >= 20 ? ' — heavy' : ''}
            </option>
          ))}
        </select>
      </label>

      {error && <div className="small err-text">{error}</div>}

      <label className="inline-label">
        Show Markers
        <select
          value={markerMode}
          disabled={routeOnly && hasPlan}
          onChange={(e) => setMarkerMode(e.target.value as BaseMarkerMode)}
        >
          {(Object.keys(MARKER_MODE_LABELS) as BaseMarkerMode[]).map((m) => (
            <option key={m} value={m}>
              {MARKER_MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </label>

      {/* Overrides the filter above rather than being one of its options: the
          two answer different questions, and this is the one the user flips
          back and forth while planning. */}
      <CheckField
        className="center"
        label="Only Show The Planned Route"
        checked={routeOnly}
        onChange={setRouteOnly}
      />

      {/* Both apply in every mode, on top of it. Markers and names are separate
          kinds of clutter — a hundred octahedra still read as a shape, a
          hundred overlapping names read as nothing — so they get one control
          each rather than one between them. */}
      <label className="inline-label">
        Marker Distance — {markerDistance >= UNLIMITED ? 'Unlimited' : `${markerDistance} Blocks`}
        <input
          type="range"
          min={20}
          max={UNLIMITED}
          step={10}
          value={markerDistance}
          onChange={(e) => setMarkerDistance(Number(e.target.value))}
        />
      </label>

      <label className="inline-label">
        Label Distance — {labelDistance >= UNLIMITED ? 'Unlimited' : `${labelDistance} Blocks`}
        <input
          type="range"
          min={20}
          max={UNLIMITED}
          step={10}
          value={labelDistance}
          onChange={(e) => setLabelDistance(Number(e.target.value))}
        />
      </label>
      {/* A weight, not a speed: the tour eases in and out of its cruise, and
          this scales that whole shape rather than replacing it. */}
      <label className="inline-label">
        Tour Speed — {Math.round(tourSpeed * 100)}% (
        {Math.round(TOUR_SPEED_BASE * tourSpeed)} Blocks/Sec)
        <input
          type="range"
          min={TOUR_SPEED_MIN}
          max={TOUR_SPEED_MAX}
          step={0.25}
          value={tourSpeed}
          onChange={(e) => setTourSpeed(Number(e.target.value))}
        />
      </label>

      {labelMode === 'none' && (
        <p className="small muted">Labels are off in the toolbar — this has no effect until they are on.</p>
      )}

      {routeOnly && !hasPlan && (
        <p className="small muted">No route planned yet — showing everything until there is one.</p>
      )}
      {!routeOnly && markerMode === 'selected' && !selection && (
        <p className="small muted">Nothing selected — showing everything until something is.</p>
      )}

      <h3>Placement</h3>
      <p className="small muted">
        {placedCount} placed · {unplaced.length} without coordinates
      </p>

      {placingId ? (
        <button className="primary" onClick={() => setPlacing(null)}>
          Cancel Placing
        </button>
      ) : (
        selected &&
        !isPlaced(selected) && (
          <button className="primary" onClick={() => setPlacing(selected.id)}>
            Place "{selected.name || 'Untitled'}" — Click A Block
          </button>
        )
      )}

      {unplaced.length > 0 && (
        <ul className="hit-list dense">
          {unplaced.slice(0, 40).map((l) => (
            <li key={l.id} className={l.id === selectedId ? 'selected' : ''}>
              <button className="link" onClick={() => selectLocation(l.id)}>
                <span className="hit-title">{l.name || 'Untitled'}</span>
              </button>
              <button className="link subtle" onClick={() => setPlacing(l.id)}>
                place
              </button>
            </li>
          ))}
        </ul>
      )}
      {unplaced.length > 40 && (
        <p className="small muted">…and {unplaced.length - 40} more</p>
      )}

      {selected && isPlaced(selected) && (
        <button
          className="link"
          onClick={() =>
            void updateLocation(selected.id, { coordX: null, coordY: null, coordZ: null })
          }
        >
          Remove Coordinates From "{selected.name || 'Untitled'}"
        </button>
      )}
    </section>
  );
}
