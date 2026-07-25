import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { focusLocation } from '../graph/cyHolder';
import { describeLock, isEffectivelyLocked } from '../graph/elements';
import {
  DIRECTION_OPTIONS,
  LINE_STYLE_OPTIONS,
  PALETTE,
  SHAPE_OPTIONS,
  arrowsFor,
  directionGlyph,
  directionOf,
  normaliseLineStyle,
  normaliseShape
} from '../graph/model';
import { useGraphStore } from '../state/store';
import type { Connection, Location } from '../types';

/** The currently mounted inspector's "apply my draft" callback. */
const inspectorCommit: { current: null | (() => void) } = { current: null };

const LOCATION_FIELDS = ['name', 'kind', 'layer', 'notes', 'color', 'textColor'] as const;
const CONNECTION_FIELDS = [
  'name',
  'notes',
  'travelKind',
  'color',
  'textColor',
  'arrowSource',
  'arrowTarget',
  'ephemeral',
  'locked',
  'lockNote',
  'weight',
  'requires'
] as const;

const differs = <T,>(a: T, b: T, fields: readonly (keyof T)[]) =>
  fields.some((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));

const pick = <T, K extends keyof T>(obj: T, fields: readonly K[]) =>
  Object.fromEntries(fields.map((f) => [f, obj[f]])) as Pick<T, K>;

/* ------------------------------------------------------------ colour field */
function ColorField({
  label,
  value,
  fallback,
  onChange
}: {
  label: string;
  value: string;
  fallback: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="color-field">
      <span className="field-label">{label}</span>
      <div className="color-row">
        <input
          type="color"
          value={value || fallback}
          onChange={(e) => onChange(e.target.value)}
        />
        <button onClick={() => onChange('')} disabled={!value} title="Use theme default">
          Default
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Location form */
function LocationInspector({ location }: { location: Location }) {
  const updateLocation = useGraphStore((s) => s.updateLocation);
  const deleteLocation = useGraphStore((s) => s.deleteLocation);
  const connections = useGraphStore((s) => s.connections);
  const locations = useGraphStore((s) => s.locations);
  const selectConnection = useGraphStore((s) => s.selectConnection);
  const selectLocation = useGraphStore((s) => s.selectLocation);

  const [draft, setDraft] = useState<Location>({
    ...location,
    kind: normaliseShape(location.kind)
  });

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baseRef = useRef(location);
  const skipRef = useRef(false);

  /* server state wins whenever the row actually changes upstream */
  useEffect(() => {
    baseRef.current = location;
    setDraft({ ...location, kind: normaliseShape(location.kind) });
  }, [location.id, location.updatedAt]);

  const dirty = differs(draft, baseRef.current, LOCATION_FIELDS);

  const commit = useCallback(() => {
    if (skipRef.current) return;
    const d = draftRef.current;
    if (!differs(d, baseRef.current, LOCATION_FIELDS)) return;
    baseRef.current = { ...baseRef.current, ...pick(d, LOCATION_FIELDS) };
    void updateLocation(d.id, pick(d, LOCATION_FIELDS));
  }, [updateLocation]);

  /* expose to "clicked outside the inspector", and flush on unmount */
  useEffect(() => {
    inspectorCommit.current = commit;
    return () => {
      if (inspectorCommit.current === commit) inspectorCommit.current = null;
      commit();
    };
  }, [commit]);

  const related = useMemo(
    () =>
      Object.values(connections).filter(
        (c) => c.sourceId === location.id || c.targetId === location.id
      ),
    [connections, location.id]
  );

  const visitedSet = useMemo(
    () => new Set(Object.values(locations).filter((l) => l.visited).map((l) => l.id)),
    [locations]
  );

  return (
    <>
      <div className="panel-head">
        <span className="badge location">Location</span>
        <button
          className="danger"
          onClick={() => {
            if (confirm('Delete this location and all of its connections?')) {
              skipRef.current = true;
              void deleteLocation(location.id);
            }
          }}
        >
          Delete
        </button>
      </div>

      <label>
        Name
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </label>

      <div className="row">
        <label>
          Shape
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
            {SHAPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Layer
          <input
            value={draft.layer}
            placeholder="Floor 2, Downtown…"
            onChange={(e) => setDraft({ ...draft, layer: e.target.value })}
          />
        </label>
      </div>

      <div className="row">
        <ColorField
          label="Box Color"
          value={draft.color}
          fallback={draft.visited ? PALETTE.nodeFillVisited : PALETTE.nodeFill}
          onChange={(color) => setDraft({ ...draft, color })}
        />
        <ColorField
          label="Text Color"
          value={draft.textColor}
          fallback={PALETTE.nodeText}
          onChange={(textColor) => setDraft({ ...draft, textColor })}
        />
      </div>

      <label>
        Notes
        <textarea
          rows={7}
          value={draft.notes}
          placeholder="Anything worth remembering about this place…"
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        />
      </label>

      <div className="row actions">
        <button disabled={!dirty} onClick={commit}>
          Apply
        </button>
        <button
          disabled={!dirty}
          onClick={() => setDraft({ ...baseRef.current, kind: normaliseShape(baseRef.current.kind) })}
        >
          Revert
        </button>
      </div>

      <div className="check-field">
        <span className="field-label">Visited</span>
        <input
          type="checkbox"
          checked={location.visited}
          onChange={(e) => void updateLocation(location.id, { visited: e.target.checked })}
        />
      </div>

      <h3>Connections ({related.length})</h3>
      <ul className="hit-list dense">
        {related.map((c) => {
          const other = c.sourceId === location.id ? c.targetId : c.sourceId;
          return (
            <li key={c.id}>
              <button className="link" onClick={() => selectConnection(c.id)}>
                <span className="hit-title">
                  {isEffectivelyLocked(c, visitedSet) ? '🔒 ' : ''}
                  {directionGlyph(c)} {locations[other]?.name || 'Unnamed Location'}
                </span>
                <span className="muted small">
                  {[c.name, c.ephemeral ? 'Ephemeral' : null, `Weight ${c.weight}`]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
              <button
                className="icon"
                title="Jump To The Other Location"
                onClick={() => focusLocation(other, selectLocation)}
              >
                ⤴
              </button>
            </li>
          );
        })}
        {related.length === 0 && <li className="muted">No Connections Yet.</li>}
      </ul>

      <p className="muted small">Updated {new Date(location.updatedAt).toLocaleString()}</p>
    </>
  );
}

/* ---------------------------------------------------------- Connection form */
function ConnectionInspector({ connection }: { connection: Connection }) {
  const locations = useGraphStore((s) => s.locations);
  const updateConnection = useGraphStore((s) => s.updateConnection);
  const deleteConnection = useGraphStore((s) => s.deleteConnection);
  const selectLocation = useGraphStore((s) => s.selectLocation);

  const normalise = (c: Connection): Connection => ({
    ...c,
    travelKind: normaliseLineStyle(c.travelKind)
  });

  const [draft, setDraft] = useState<Connection>(normalise(connection));
  const [reqToAdd, setReqToAdd] = useState('');

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baseRef = useRef(connection);
  const skipRef = useRef(false);

  useEffect(() => {
    baseRef.current = connection;
    setDraft(normalise(connection));
  }, [connection.id, connection.updatedAt]);

  const dirty = differs(draft, baseRef.current, CONNECTION_FIELDS);

  const commit = useCallback(() => {
    if (skipRef.current) return;
    const d = draftRef.current;
    if (!differs(d, baseRef.current, CONNECTION_FIELDS)) return;
    baseRef.current = { ...baseRef.current, ...pick(d, CONNECTION_FIELDS) };
    void updateConnection(d.id, pick(d, CONNECTION_FIELDS));
  }, [updateConnection]);

  useEffect(() => {
    inspectorCommit.current = commit;
    return () => {
      if (inspectorCommit.current === commit) inspectorCommit.current = null;
      commit();
    };
  }, [commit]);

  const visitedSet = useMemo(
    () => new Set(Object.values(locations).filter((l) => l.visited).map((l) => l.id)),
    [locations]
  );

  const source = locations[connection.sourceId];
  const target = locations[connection.targetId];
  const locked = isEffectivelyLocked(connection, visitedSet);

  const sortedLocations = useMemo(
    () => Object.values(locations).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [locations]
  );

  return (
    <>
      <div className="panel-head">
        <span className="badge connection">Connection</span>
        <button
          className="danger"
          onClick={() => {
            if (confirm('Delete this connection?')) {
              skipRef.current = true;
              void deleteConnection(connection.id);
            }
          }}
        >
          Delete
        </button>
      </div>

      <div className="endpoints">
        <button className="link" onClick={() => focusLocation(connection.sourceId, selectLocation)}>
          {source?.name || 'Unnamed Location'}
        </button>
        <span className="arrow">{directionGlyph(draft)}</span>
        <button className="link" onClick={() => focusLocation(connection.targetId, selectLocation)}>
          {target?.name || 'Unnamed Location'}
        </button>
        <button
          className="icon"
          title="Swap Endpoints"
          onClick={() => {
            skipRef.current = true;
            void updateConnection(connection.id, {
              sourceId: connection.targetId,
              targetId: connection.sourceId
            }).then(() => {
              skipRef.current = false;
            });
          }}
        >
          ⇅
        </button>
      </div>

      {locked && <div className="lock-banner">🔒 {describeLock(connection, locations)}</div>}

      <label>
        Name
        <input
          value={draft.name}
          placeholder="North Door, Highway 9…"
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>

      <label>
        Direction
        <select
          value={directionOf(draft)}
          onChange={(e) => setDraft({ ...draft, ...arrowsFor(e.target.value as any) })}
        >
          {DIRECTION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <div className="row">
        <label>
          Line Style
          <select
            value={draft.travelKind}
            onChange={(e) => setDraft({ ...draft, travelKind: e.target.value })}
          >
            {LINE_STYLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Weight (Thickness)
          <input
            type="number"
            min={0.1}
            step={0.5}
            value={draft.weight}
            onChange={(e) => setDraft({ ...draft, weight: Number(e.target.value) || 1 })}
          />
        </label>
      </div>

      <div className="row">
        <ColorField
          label="Line Color"
          value={draft.color}
          fallback={locked ? PALETTE.edgeLocked : PALETTE.edge}
          onChange={(color) => setDraft({ ...draft, color })}
        />
        <ColorField
          label="Text Color"
          value={draft.textColor}
          fallback={PALETTE.edgeText}
          onChange={(textColor) => setDraft({ ...draft, textColor })}
        />
      </div>

      <div className="check-row">
        <div className="check-field">
          <span className="field-label">Ephemeral</span>
          <input
            type="checkbox"
            checked={draft.ephemeral}
            title='Draw as detached "To X" / "From Y" stubs'
            onChange={(e) => setDraft({ ...draft, ephemeral: e.target.checked })}
          />
        </div>
        <div className="check-field">
          <span className="field-label">Locked</span>
          <input
            type="checkbox"
            checked={draft.locked}
            onChange={(e) => setDraft({ ...draft, locked: e.target.checked })}
          />
        </div>
      </div>

      {draft.locked && (
        <fieldset className="lock-box">
          <legend>Unlock Conditions</legend>
          <p className="muted small">
            The connection opens once <em>all</em> of these locations have been visited.
            Leave it empty for a permanently locked link.
          </p>
          <ul className="req-list">
            {draft.requires.map((id) => (
              <li key={id}>
                <span className={visitedSet.has(id) ? 'ok' : 'pending'}>
                  {visitedSet.has(id) ? '✔' : '○'}
                </span>
                <button className="link" onClick={() => focusLocation(id, selectLocation)}>
                  {locations[id]?.name || 'Unnamed Location'}
                </button>
                <button
                  className="icon danger"
                  onClick={() =>
                    setDraft({ ...draft, requires: draft.requires.filter((r) => r !== id) })
                  }
                >
                  ✕
                </button>
              </li>
            ))}
            {draft.requires.length === 0 && <li className="muted">None.</li>}
          </ul>
          <div className="row">
            <select value={reqToAdd} onChange={(e) => setReqToAdd(e.target.value)}>
              <option value="">Add Required Location…</option>
              {sortedLocations
                .filter((l) => !draft.requires.includes(l.id))
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name || 'Unnamed Location'}
                    {l.layer ? ` — ${l.layer}` : ''}
                  </option>
                ))}
            </select>
            <button
              disabled={!reqToAdd}
              onClick={() => {
                setDraft({ ...draft, requires: [...draft.requires, reqToAdd] });
                setReqToAdd('');
              }}
            >
              Add
            </button>
          </div>
          <label>
            Lock Note
            <input
              value={draft.lockNote}
              placeholder="Needs the rental agreement signed…"
              onChange={(e) => setDraft({ ...draft, lockNote: e.target.value })}
            />
          </label>
        </fieldset>
      )}

      <label>
        Notes
        <textarea
          rows={6}
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        />
      </label>

      <div className="row actions">
        <button disabled={!dirty} onClick={commit}>
          Apply
        </button>
        <button disabled={!dirty} onClick={() => setDraft(normalise(baseRef.current))}>
          Revert
        </button>
      </div>

      <p className="muted small">Updated {new Date(connection.updatedAt).toLocaleString()}</p>
    </>
  );
}

/* --------------------------------------------------------------- container */
export default function DetailsPanel() {
  const selection = useGraphStore((s) => s.selection);
  const locations = useGraphStore((s) => s.locations);
  const connections = useGraphStore((s) => s.connections);
  const asideRef = useRef<HTMLElement | null>(null);

  /* clicking anywhere outside the inspector applies pending edits */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!asideRef.current) return;
      if (asideRef.current.contains(e.target as Node)) return;
      inspectorCommit.current?.();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, []);

  if (!selection) return null;

  const location = selection.type === 'location' ? locations[selection.id] : undefined;
  const connection = selection.type === 'connection' ? connections[selection.id] : undefined;
  if (!location && !connection) return null;

  return (
    <aside className="inspector" ref={asideRef}>
      <h2>Inspector</h2>
      {location && <LocationInspector key={location.id} location={location} />}
      {connection && <ConnectionInspector key={connection.id} connection={connection} />}
    </aside>
  );
}
