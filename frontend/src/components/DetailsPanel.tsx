import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isEffectivelyLocked } from '../graph/connectionRules';
import { focusGroup, focusLocation } from '../graph/cyHolder';
import { describeLock } from '../graph/elements';
import { descendantGroupIds, groupPathLabel } from '../graph/groups';
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
import type { Connection, ConnectionLabel, Group, Location, LocationLabel } from '../types';
import { ColorField, InlineCheckField, LabelChips, OptionalColorField } from './fields';
import GroupPicker, { KEEP } from './GroupPicker';
import LabelPicker from './LabelPicker';
import { inspectorCommit, useDraft } from './useDraft';

const LOCATION_FIELDS = [
  'name', 'kind', 'size', 'layer', 'notes', 'color', 'textColor', 'coordX', 'coordY', 'coordZ'
] as const;

const CONNECTION_FIELDS = [
  'name', 'notes', 'travelKind', 'color', 'textColor', 'arrowSource', 'arrowTarget',
  'ephemeral', 'locked', 'lockNote', 'weight', 'requires'
] as const;

/** parentId is structural, so it commits through setGroupParent, but it still
 *  lives in the draft so Apply/Revert behave like every other field. */
const GROUP_FIELDS = ['name', 'color', 'textColor', 'notes', 'parentId'] as const;

const LOCATION_LABEL_FIELDS = [
  'name', 'color', 'notes', 'defaultKind', 'defaultSize', 'defaultColor', 'defaultTextColor',
  'defaultLayer', 'defaultGroupId'
] as const;

const CONNECTION_LABEL_FIELDS = [
  'name', 'color', 'notes', 'defaultColor', 'defaultTextColor', 'defaultTravelKind',
  'defaultDirection', 'defaultWeight', 'defaultEphemeral', 'defaultLocked',
  'defaultLockNote', 'defaultRequires'
] as const;

const normaliseLocation = (l: Location): Location => ({ ...l, kind: normaliseShape(l.kind) });
const normaliseConnection = (c: Connection): Connection => ({
  ...c,
  travelKind: normaliseLineStyle(c.travelKind)
});

const coordText = (v: number | null) => (v === null || v === undefined ? '' : String(v));

/** A location's size is a positive scalar on its box; 1 is "normal". */
const MAX_SIZE = 25;
const parseSize = (raw: string, fallback: number) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_SIZE, n) : fallback;
};

/** Whole numbers only; blank (or a lone "-") means "no coordinate". */
const parseCoord = (s: string): number | null => {
  const t = s.trim();
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/**
 * Direction of a connection *as seen from one of its rooms*.
 *   → one-way arriving at this room   ← one-way leaving it   ⇄ both   — neither
 */
function relativeGlyph(c: Connection, selfId: string): string {
  const intoSelf = c.sourceId === selfId ? c.arrowSource : c.arrowTarget;
  const outOfSelf = c.sourceId === selfId ? c.arrowTarget : c.arrowSource;
  if (intoSelf && outOfSelf) return '⇄';
  if (intoSelf) return '→';
  if (outOfSelf) return '←';
  return '—';
}

/** "(Kitchen)" for a room inside a grouping, "" otherwise. */
const groupSuffix = (loc: Location | undefined, groups: Record<string, Group>) =>
  loc?.groupId && groups[loc.groupId] ? `(${groups[loc.groupId]!.name || 'Unnamed Grouping'})` : '';

/** Full path, used as the tooltip so nested groupings stay discoverable. */
const groupTitle = (loc: Location | undefined, groups: Record<string, Group>) =>
  loc?.groupId && groups[loc.groupId] ? groupPathLabel(groups, loc.groupId) : undefined;

const byName = <T extends { name: string }>(a: T, b: T) => (a.name || '').localeCompare(b.name || '');

/* ------------------------------------------------------------ Location form */

function LocationInspector({ location }: { location: Location }) {
  const updateLocation = useGraphStore((s) => s.updateLocation);
  const deleteLocation = useGraphStore((s) => s.deleteLocation);
  const setLocationGroup = useGraphStore((s) => s.setLocationGroup);
  const createGroupFrom = useGraphStore((s) => s.createGroupFrom);
  const connections = useGraphStore((s) => s.connections);
  const locations = useGraphStore((s) => s.locations);
  const groups = useGraphStore((s) => s.groups);
  const selectConnection = useGraphStore((s) => s.selectConnection);
  const selectLocation = useGraphStore((s) => s.selectLocation);
  const selectGroup = useGraphStore((s) => s.selectGroup);
  const locationLabels = useGraphStore((s) => s.locationLabels);
  const assignLocationLabel = useGraphStore((s) => s.assignLocationLabel);
  const unassignLocationLabel = useGraphStore((s) => s.unassignLocationLabel);
  const applyLocationLabelStyling = useGraphStore((s) => s.applyLocationLabelStyling);
  const createLocationLabel = useGraphStore((s) => s.createLocationLabel);

  const save = useCallback(
    (id: string, patch: Partial<Location>) => updateLocation(id, patch),
    [updateLocation]
  );
  const { draft, setDraft, dirty, commit, revert, cancelCommit } = useDraft(
    location,
    LOCATION_FIELDS,
    save,
    normaliseLocation
  );

  const related = useMemo(
    () => Object.values(connections).filter((c) => c.sourceId === location.id || c.targetId === location.id),
    [connections, location.id]
  );
  const visitedSet = useMemo(
    () => new Set(Object.values(locations).filter((l) => l.visited).map((l) => l.id)),
    [locations]
  );
  const groupList = useMemo(() => Object.values(groups).sort(byName), [groups]);

  return (
    <>
      <div className="panel-head">
        <span className="badge location">Location</span>
        <button
          className="danger"
          onClick={() => {
            if (confirm('Delete this location and all of its connections?')) {
              cancelCommit();
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
              <option key={o.value} value={o.value}>{o.label}</option>
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

      <label>
        Size — Scale Relative To Every Other Location (1 = Normal)
        <input
          type="number"
          min={0.1}
          max={MAX_SIZE}
          step={0.1}
          value={draft.size}
          onChange={(e) => setDraft((d) => ({ ...d, size: parseSize(e.target.value, d.size) }))}
        />
      </label>

      <div className="field">
        <span className="field-label">Coordinates — Whole Numbers, Negatives Allowed, Blank = None</span>
        <div className="row coords">
          {(['coordX', 'coordY', 'coordZ'] as const).map((key) => (
            <label key={key}>
              {key.slice(-1)}
              <input
                type="number"
                step={1}
                value={coordText(draft[key])}
                onChange={(e) => setDraft({ ...draft, [key]: parseCoord(e.target.value) })}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field-label">Grouping</span>
        <GroupPicker
          groups={groupList}
          value={location.groupId}
          onPick={(gid) => void setLocationGroup(location.id, gid)}
          newLabel="+ New Grouping With This Room"
          onCreateNew={() => void createGroupFrom([location.id])}
        />
      </div>

      {location.groupId && groups[location.groupId] && (
        <button className="link subtle" onClick={() => focusGroup(location.groupId!, selectGroup)}>
          Inspect "{groupPathLabel(groups, location.groupId)}"
        </button>
      )}

      <h3>Labels</h3>
      <LabelChips
        labels={location.labelIds.map((id) => locationLabels[id]).filter(Boolean) as LocationLabel[]}
        onApply={(labelId) => void applyLocationLabelStyling(location.id, labelId)}
        onRemove={(labelId) => void unassignLocationLabel(location.id, labelId)}
      />
      <LabelPicker
        labels={Object.values(locationLabels)}
        exclude={new Set(location.labelIds)}
        onPick={(labelId) => void assignLocationLabel(location.id, labelId)}
        onCreateNew={() => void createLocationLabel('New Label')}
        buttonLabel="+ Add Label"
      />

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
        <button disabled={!dirty} onClick={commit}>Apply</button>
        <button disabled={!dirty} onClick={revert}>Revert</button>
      </div>

      <InlineCheckField
        label="Visited"
        checked={location.visited}
        onChange={(v) => void updateLocation(location.id, { visited: v })}
      />

      <h3>Connections ({related.length})</h3>
      <ul className="hit-list dense">
        {related.map((c) => {
          const other = c.sourceId === location.id ? c.targetId : c.sourceId;
          const otherLoc = locations[other];
          const suffix = groupSuffix(otherLoc, groups);
          return (
            <li key={c.id}>
              <button className="link" onClick={() => selectConnection(c.id)}>
                <span className="hit-title" title={groupTitle(otherLoc, groups)}>
                  {isEffectivelyLocked(c, visitedSet) ? '🔒 ' : ''}
                  {relativeGlyph(c, location.id)} {otherLoc?.name || 'Unnamed Location'}
                  {suffix && <span className="muted in-group"> {suffix}</span>}
                </span>
                <span className="muted small">
                  {[c.name, c.ephemeral ? 'Ephemeral' : null, `Weight ${c.weight}`].filter(Boolean).join(' · ')}
                </span>
              </button>
              <button className="icon" title="Jump To The Other Location" onClick={() => focusLocation(other, selectLocation)}>
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
  const groups = useGraphStore((s) => s.groups);
  const updateConnection = useGraphStore((s) => s.updateConnection);
  const deleteConnection = useGraphStore((s) => s.deleteConnection);
  const selectLocation = useGraphStore((s) => s.selectLocation);
  const connectionLabels = useGraphStore((s) => s.connectionLabels);
  const assignConnectionLabel = useGraphStore((s) => s.assignConnectionLabel);
  const unassignConnectionLabel = useGraphStore((s) => s.unassignConnectionLabel);
  const applyConnectionLabelStyling = useGraphStore((s) => s.applyConnectionLabelStyling);
  const createConnectionLabel = useGraphStore((s) => s.createConnectionLabel);

  const save = useCallback(
    (id: string, patch: Partial<Connection>) => updateConnection(id, patch),
    [updateConnection]
  );
  const { draft, setDraft, dirty, commit, revert, cancelCommit } = useDraft(
    connection,
    CONNECTION_FIELDS,
    save,
    normaliseConnection
  );

  const [reqToAdd, setReqToAdd] = useState('');

  const visitedSet = useMemo(
    () => new Set(Object.values(locations).filter((l) => l.visited).map((l) => l.id)),
    [locations]
  );
  const sortedLocations = useMemo(() => Object.values(locations).sort(byName), [locations]);

  const source = locations[connection.sourceId];
  const target = locations[connection.targetId];
  const locked = isEffectivelyLocked(connection, visitedSet);

  return (
    <>
      <div className="panel-head">
        <span className="badge connection">Connection</span>
        <button
          className="danger"
          onClick={() => {
            if (confirm('Delete this connection?')) {
              cancelCommit();
              void deleteConnection(connection.id);
            }
          }}
        >
          Delete
        </button>
      </div>

      <div className="endpoints">
        <button className="link" title={groupTitle(source, groups)} onClick={() => focusLocation(connection.sourceId, selectLocation)}>
          <span>{source?.name || 'Unnamed Location'}</span>
          {groupSuffix(source, groups) && <span className="muted small">{groupSuffix(source, groups)}</span>}
        </button>
        <span className="arrow">{directionGlyph(draft)}</span>
        <button className="link" title={groupTitle(target, groups)} onClick={() => focusLocation(connection.targetId, selectLocation)}>
          <span>{target?.name || 'Unnamed Location'}</span>
          {groupSuffix(target, groups) && <span className="muted small">{groupSuffix(target, groups)}</span>}
        </button>
        <button
          className="icon"
          title="Swap Endpoints"
          onClick={() =>
            /* endpoints are not draft fields, and the row that comes back is
               merged into whatever is half-typed, so nothing needs suspending */
            void updateConnection(connection.id, {
              sourceId: connection.targetId,
              targetId: connection.sourceId
            })
          }
        >
          ⇅
        </button>
      </div>

      <p className="muted small">Drag Either Amber Handle On The Map To Re-Attach That End To Another Room.</p>

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
        <select value={directionOf(draft)} onChange={(e) => setDraft({ ...draft, ...arrowsFor(e.target.value as any) })}>
          {DIRECTION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>

      <div className="row">
        <label>
          Line Style
          <select value={draft.travelKind} onChange={(e) => setDraft({ ...draft, travelKind: e.target.value })}>
            {LINE_STYLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
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
        <ColorField label="Line Color" value={draft.color} fallback={PALETTE.edge} onChange={(color) => setDraft({ ...draft, color })} />
        <ColorField
          label="Text Color"
          value={draft.textColor}
          fallback={PALETTE.edgeText}
          onChange={(textColor) => setDraft({ ...draft, textColor })}
        />
      </div>

      <div className="check-row">
        <InlineCheckField
          label="Ephemeral"
          title='Draw as detached "To X" / "From Y" stubs'
          checked={draft.ephemeral}
          onChange={(v) => setDraft({ ...draft, ephemeral: v })}
        />
        <InlineCheckField label="Locked" checked={draft.locked} onChange={(v) => setDraft({ ...draft, locked: v })} />
      </div>

      {draft.locked && (
        <fieldset className="lock-box">
          <legend>Unlock Conditions</legend>
          <p className="muted small">
            The connection opens once <em>all</em> of these locations have been visited. Leave it empty for a
            permanently locked link.
          </p>
          <ul className="req-list">
            {draft.requires.map((id) => (
              <li key={id}>
                <span className={visitedSet.has(id) ? 'ok' : 'pending'}>{visitedSet.has(id) ? '✔' : '○'}</span>
                <button className="link" onClick={() => focusLocation(id, selectLocation)}>
                  {locations[id]?.name || 'Unnamed Location'}
                </button>
                <button
                  className="icon danger"
                  onClick={() => setDraft({ ...draft, requires: draft.requires.filter((r) => r !== id) })}
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
                    {l.name || 'Unnamed Location'}{l.layer ? ` — ${l.layer}` : ''}
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

      <h3>Labels</h3>
      <LabelChips
        labels={connection.labelIds.map((id) => connectionLabels[id]).filter(Boolean) as ConnectionLabel[]}
        onApply={(labelId) => void applyConnectionLabelStyling(connection.id, labelId)}
        onRemove={(labelId) => void unassignConnectionLabel(connection.id, labelId)}
      />
      <LabelPicker
        labels={Object.values(connectionLabels)}
        exclude={new Set(connection.labelIds)}
        onPick={(labelId) => void assignConnectionLabel(connection.id, labelId)}
        onCreateNew={() => void createConnectionLabel('New Label')}
      />

      <label>
        Notes
        <textarea rows={6} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
      </label>

      <div className="row actions">
        <button disabled={!dirty} onClick={commit}>Apply</button>
        <button disabled={!dirty} onClick={revert}>Revert</button>
      </div>

      <p className="muted small">Updated {new Date(connection.updatedAt).toLocaleString()}</p>
    </>
  );
}

/* --------------------------------------------------------- Grouping form */

function GroupInspector({ group }: { group: Group }) {
  const locations = useGraphStore((s) => s.locations);
  const groups = useGraphStore((s) => s.groups);
  const updateGroup = useGraphStore((s) => s.updateGroup);
  const deleteGroup = useGraphStore((s) => s.deleteGroup);
  const ungroupAll = useGraphStore((s) => s.ungroupAll);
  const setLocationGroup = useGraphStore((s) => s.setLocationGroup);
  const setGroupParent = useGraphStore((s) => s.setGroupParent);
  const selectLocation = useGraphStore((s) => s.selectLocation);
  const selectGroup = useGraphStore((s) => s.selectGroup);
  const runLayout = useGraphStore((s) => s.runLayout);

  /* the parent is structural: it validates and re-layouts, so it goes its own way */
  const save = useCallback(
    (id: string, patch: Partial<Group>) => {
      const { parentId, ...rest } = patch;
      const writes: Array<Promise<unknown>> = [];
      if (Object.keys(rest).length) writes.push(updateGroup(id, rest));
      if (parentId !== undefined) writes.push(setGroupParent(id, parentId));
      return Promise.all(writes);
    },
    [updateGroup, setGroupParent]
  );
  const { draft, setDraft, dirty, commit, revert, cancelCommit } = useDraft(group, GROUP_FIELDS, save);

  const [toAdd, setToAdd] = useState('');

  const members = useMemo(
    () => Object.values(locations).filter((l) => l.groupId === group.id).sort(byName),
    [locations, group.id]
  );
  const outsiders = useMemo(
    () => Object.values(locations).filter((l) => l.groupId !== group.id).sort(byName),
    [locations, group.id]
  );
  const groupList = useMemo(() => Object.values(groups).sort(byName), [groups]);
  const subGroups = groupList.filter((g) => g.parentId === group.id);

  return (
    <>
      <div className="panel-head">
        <span className="badge group">Grouping</span>
        <button
          className="danger"
          onClick={() => {
            if (confirm('Delete this grouping? The rooms inside it are kept.')) {
              cancelCommit();
              void deleteGroup(group.id);
            }
          }}
        >
          Delete
        </button>
      </div>

      <label>
        Name
        <input
          value={draft.name}
          placeholder="House, Old Town, Deck 4…"
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>

      <div className="field">
        <span className="field-label">Parent Grouping</span>
        <GroupPicker
          groups={groupList}
          value={draft.parentId}
          excludeIds={descendantGroupIds(groupList, group.id)}
          noneLabel="Top Level (No Parent)"
          onPick={(parentId) => setDraft((d) => ({ ...d, parentId }))}
        />
      </div>

      <div className="row">
        <ColorField
          label="Body Color"
          value={draft.color}
          fallback={PALETTE.groupFill}
          onChange={(color) =>
            setDraft((d) => ({
              ...d,
              color,
              /* the title tracks the body only while they are identical, so the
                 first manual title change decouples them for good */
              textColor: d.textColor === d.color ? color : d.textColor
            }))
          }
        />
        <ColorField
          label="Title Color"
          value={draft.textColor}
          fallback={draft.color || PALETTE.groupBorder}
          onChange={(textColor) => setDraft((d) => ({ ...d, textColor }))}
        />
      </div>

      <label>
        Notes
        <textarea rows={5} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
      </label>

      <div className="row actions">
        <button disabled={!dirty} onClick={commit}>Apply</button>
        <button disabled={!dirty} onClick={revert}>Revert</button>
        <button onClick={runLayout}>Re-Layout</button>
      </div>

      <h3>Rooms In This Grouping ({members.length})</h3>
      <ul className="hit-list dense">
        {members.map((l) => (
          <li key={l.id}>
            <button className="link" onClick={() => focusLocation(l.id, selectLocation)}>
              <span className="hit-title">{l.name || 'Unnamed Location'}</span>
              <span className="muted small">{l.layer || 'No Layer'}</span>
            </button>
            <button className="icon danger" title="Remove From Grouping" onClick={() => void setLocationGroup(l.id, null)}>
              ✕
            </button>
          </li>
        ))}
        {members.length === 0 && <li className="muted small">Empty Groupings Are Not Drawn On The Map.</li>}
      </ul>

      <h3>Sub-Groupings</h3>
      <ul className="hit-list dense">
        {subGroups.map((g) => (
          <li key={g.id}>
            <button className="link" onClick={() => focusGroup(g.id, selectGroup)}>
              <span className="hit-title">{g.name || 'Unnamed Grouping'}</span>
            </button>
            <button className="icon danger" title="Move To Top Level" onClick={() => void setGroupParent(g.id, null)}>
              ✕
            </button>
          </li>
        ))}
        {subGroups.length === 0 && <li className="muted small">None.</li>}
      </ul>

      <div className="row">
        <select value={toAdd} onChange={(e) => setToAdd(e.target.value)}>
          <option value="">Add A Room…</option>
          {outsiders.map((l) => (
            <option key={l.id} value={l.id}>{l.name || 'Unnamed Location'}</option>
          ))}
        </select>
        <button
          disabled={!toAdd}
          onClick={() => {
            void setLocationGroup(toAdd, group.id);
            setToAdd('');
          }}
        >
          Add
        </button>
      </div>

      <button disabled={members.length === 0} onClick={() => void ungroupAll(group.id)}>
        Remove All Rooms
      </button>

      <p className="muted small">Updated {new Date(group.updatedAt).toLocaleString()}</p>
    </>
  );
}

/* ------------------------------------------------- Location label form */

function LocationLabelInspector({ label }: { label: LocationLabel }) {
  const groups = useGraphStore((s) => s.groups);
  const locations = useGraphStore((s) => s.locations);
  const updateLocationLabel = useGraphStore((s) => s.updateLocationLabel);
  const deleteLocationLabel = useGraphStore((s) => s.deleteLocationLabel);
  const applyToAll = useGraphStore((s) => s.applyLocationLabelToAll);
  const selectLocation = useGraphStore((s) => s.selectLocation);

  const save = useCallback(
    (id: string, patch: Partial<LocationLabel>) => updateLocationLabel(id, patch),
    [updateLocationLabel]
  );
  const { draft, setDraft, dirty, commit, revert, cancelCommit } = useDraft(label, LOCATION_LABEL_FIELDS, save);

  const groupList = useMemo(() => Object.values(groups), [groups]);
  const members = useMemo(
    () => Object.values(locations).filter((l) => l.labelIds.includes(label.id)),
    [locations, label.id]
  );

  return (
    <>
      <div className="panel-head">
        <span className="badge label">Location Label</span>
        <button
          className="danger"
          onClick={() => {
            if (confirm('Delete this label? Rooms keep the styling they were given.')) {
              cancelCommit();
              void deleteLocationLabel(label.id);
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

      <ColorField label="Chip Color" value={draft.color} fallback="#8897ad" onChange={(color) => setDraft({ ...draft, color })} />

      <h3>Defaults (Opt-In)</h3>
      <p className="muted small">
        Anything left blank is never applied. These are stamped onto a room when the label is applied to it.
      </p>

      <label>
        Default Shape
        <select value={draft.defaultKind} onChange={(e) => setDraft({ ...draft, defaultKind: e.target.value })}>
          <option value="">No Override</option>
          {SHAPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>

      <label>
        Default Size
        <input
          type="number"
          min={0.1}
          max={MAX_SIZE}
          step={0.1}
          value={draft.defaultSize ?? ''}
          placeholder="No Override"
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              defaultSize: e.target.value === '' ? null : parseSize(e.target.value, d.defaultSize ?? 1)
            }))
          }
        />
      </label>

      <div className="row">
        <OptionalColorField
          label="Default Box Color"
          value={draft.defaultColor}
          fallback={PALETTE.nodeFill}
          onChange={(defaultColor) => setDraft({ ...draft, defaultColor })}
        />
        <OptionalColorField
          label="Default Text Color"
          value={draft.defaultTextColor}
          fallback={PALETTE.nodeText}
          onChange={(defaultTextColor) => setDraft({ ...draft, defaultTextColor })}
        />
      </div>

      <label>
        Default Layer
        <input
          value={draft.defaultLayer}
          placeholder="Blank = No Override"
          onChange={(e) => setDraft({ ...draft, defaultLayer: e.target.value })}
        />
      </label>

      <div className="field">
        <span className="field-label">Default Grouping</span>
        <GroupPicker
          groups={groupList}
          value={draft.defaultGroupId}
          noneLabel="No Override"
          onPick={(defaultGroupId) => setDraft((d) => ({ ...d, defaultGroupId }))}
        />
      </div>

      <label>
        Notes
        <textarea rows={4} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
      </label>

      <div className="row actions">
        <button disabled={!dirty} onClick={commit}>Apply</button>
        <button disabled={!dirty} onClick={revert}>Revert</button>
      </div>

      <button
        disabled={!members.length}
        onClick={async () => {
          /* stamp the defaults the user can see, not the ones last saved */
          await commit();
          await applyToAll(label.id);
        }}
      >
        Re-Apply Styling To All {members.length} Rooms
      </button>

      <h3>Rooms With This Label ({members.length})</h3>
      <ul className="hit-list dense">
        {members.map((l) => (
          <li key={l.id}>
            <button className="link" onClick={() => focusLocation(l.id, selectLocation)}>
              <span className="hit-title">{l.name || 'Unnamed Location'}</span>
            </button>
          </li>
        ))}
        {!members.length && <li className="muted small">None Yet.</li>}
      </ul>

      <p className="muted small">Updated {new Date(label.updatedAt).toLocaleString()}</p>
    </>
  );
}

/* ----------------------------------------------- Connection label form */

const triState = (v: boolean | null) => (v === null ? '' : v ? 'yes' : 'no');
const fromTri = (v: string): boolean | null => (v === '' ? null : v === 'yes');

function ConnectionLabelInspector({ label }: { label: ConnectionLabel }) {
  const locations = useGraphStore((s) => s.locations);
  const connections = useGraphStore((s) => s.connections);
  const updateConnectionLabel = useGraphStore((s) => s.updateConnectionLabel);
  const deleteConnectionLabel = useGraphStore((s) => s.deleteConnectionLabel);
  const applyToAll = useGraphStore((s) => s.applyConnectionLabelToAll);
  const selectConnection = useGraphStore((s) => s.selectConnection);

  const save = useCallback(
    (id: string, patch: Partial<ConnectionLabel>) => updateConnectionLabel(id, patch),
    [updateConnectionLabel]
  );
  const { draft, setDraft, dirty, commit, revert, cancelCommit } = useDraft(label, CONNECTION_LABEL_FIELDS, save);

  const [reqToAdd, setReqToAdd] = useState('');

  const members = useMemo(
    () => Object.values(connections).filter((c) => c.labelIds.includes(label.id)),
    [connections, label.id]
  );
  const sortedLocations = useMemo(() => Object.values(locations).sort(byName), [locations]);

  return (
    <>
      <div className="panel-head">
        <span className="badge label">Connection Label</span>
        <button
          className="danger"
          onClick={() => {
            if (confirm('Delete this label? Connections keep the styling they were given.')) {
              cancelCommit();
              void deleteConnectionLabel(label.id);
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

      <ColorField label="Chip Color" value={draft.color} fallback="#8897ad" onChange={(color) => setDraft({ ...draft, color })} />

      <h3>Defaults (Opt-In)</h3>
      <p className="muted small">Anything set to "No Override" is never applied.</p>

      <div className="row">
        <OptionalColorField
          label="Default Line Color"
          value={draft.defaultColor}
          fallback={PALETTE.edge}
          onChange={(defaultColor) => setDraft({ ...draft, defaultColor })}
        />
        <OptionalColorField
          label="Default Text Color"
          value={draft.defaultTextColor}
          fallback={PALETTE.edgeText}
          onChange={(defaultTextColor) => setDraft({ ...draft, defaultTextColor })}
        />
      </div>

      <div className="row">
        <label>
          Default Direction
          <select value={draft.defaultDirection} onChange={(e) => setDraft({ ...draft, defaultDirection: e.target.value })}>
            <option value="">No Override</option>
            {DIRECTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          Default Line Style
          <select value={draft.defaultTravelKind} onChange={(e) => setDraft({ ...draft, defaultTravelKind: e.target.value })}>
            <option value="">No Override</option>
            {LINE_STYLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="row">
        <label>
          Default Weight
          <input
            type="number"
            min={0.1}
            step={0.5}
            value={draft.defaultWeight ?? ''}
            placeholder="No Override"
            onChange={(e) =>
              setDraft({ ...draft, defaultWeight: e.target.value === '' ? null : Number(e.target.value) || 1 })
            }
          />
        </label>
        <label>
          Default Ephemeral
          <select value={triState(draft.defaultEphemeral)} onChange={(e) => setDraft({ ...draft, defaultEphemeral: fromTri(e.target.value) })}>
            <option value="">No Override</option>
            <option value="yes">Ephemeral</option>
            <option value="no">Not Ephemeral</option>
          </select>
        </label>
      </div>

      <label>
        Default Locked
        <select value={triState(draft.defaultLocked)} onChange={(e) => setDraft({ ...draft, defaultLocked: fromTri(e.target.value) })}>
          <option value="">No Override</option>
          <option value="yes">Locked</option>
          <option value="no">Unlocked</option>
        </select>
      </label>

      {draft.defaultLocked !== null && (
        <fieldset className="lock-box">
          <legend>Default Unlock Conditions</legend>
          <ul className="req-list">
            {draft.defaultRequires.map((id) => (
              <li key={id}>
                <span className="pending">○</span>
                <span className="hit-title">{locations[id]?.name || 'Unnamed Location'}</span>
                <button
                  className="icon danger"
                  onClick={() =>
                    setDraft({ ...draft, defaultRequires: draft.defaultRequires.filter((r) => r !== id) })
                  }
                >
                  ✕
                </button>
              </li>
            ))}
            {!draft.defaultRequires.length && <li className="muted">None.</li>}
          </ul>
          <div className="row">
            <select value={reqToAdd} onChange={(e) => setReqToAdd(e.target.value)}>
              <option value="">Add Required Location…</option>
              {sortedLocations
                .filter((l) => !draft.defaultRequires.includes(l.id))
                .map((l) => (
                  <option key={l.id} value={l.id}>{l.name || 'Unnamed Location'}</option>
                ))}
            </select>
            <button
              disabled={!reqToAdd}
              onClick={() => {
                setDraft({ ...draft, defaultRequires: [...draft.defaultRequires, reqToAdd] });
                setReqToAdd('');
              }}
            >
              Add
            </button>
          </div>
          <label>
            Default Lock Note
            <input
              value={draft.defaultLockNote}
              placeholder="Blank = No Override"
              onChange={(e) => setDraft({ ...draft, defaultLockNote: e.target.value })}
            />
          </label>
        </fieldset>
      )}

      <label>
        Notes
        <textarea rows={4} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
      </label>

      <div className="row actions">
        <button disabled={!dirty} onClick={commit}>Apply</button>
        <button disabled={!dirty} onClick={revert}>Revert</button>
      </div>

      <button
        disabled={!members.length}
        onClick={async () => {
          /* stamp the defaults the user can see, not the ones last saved */
          await commit();
          await applyToAll(label.id);
        }}
      >
        Re-Apply Styling To All {members.length} Connections
      </button>

      <h3>Connections With This Label ({members.length})</h3>
      <ul className="hit-list dense">
        {members.map((c) => (
          <li key={c.id}>
            <button className="link" onClick={() => selectConnection(c.id)}>
              <span className="hit-title">
                {c.name ||
                  `${locations[c.sourceId]?.name || 'Unnamed'} → ${locations[c.targetId]?.name || 'Unnamed'}`}
              </span>
            </button>
          </li>
        ))}
        {!members.length && <li className="muted small">None Yet.</li>}
      </ul>

      <p className="muted small">Updated {new Date(label.updatedAt).toLocaleString()}</p>
    </>
  );
}

/* --------------------------------------------------- Multiple rooms form */

function MultiInspector({ ids }: { ids: string[] }) {
  const locations = useGraphStore((s) => s.locations);
  const groups = useGraphStore((s) => s.groups);
  const locationLabels = useGraphStore((s) => s.locationLabels);
  const bulkUpdateLocations = useGraphStore((s) => s.bulkUpdateLocations);
  const bulkAssignLocationLabel = useGraphStore((s) => s.bulkAssignLocationLabel);
  const createGroupFrom = useGraphStore((s) => s.createGroupFrom);
  const deleteLocations = useGraphStore((s) => s.deleteLocations);
  const selectLocation = useGraphStore((s) => s.selectLocation);

  const members = useMemo(() => ids.map((id) => locations[id]).filter(Boolean) as Location[], [ids, locations]);

  const [shape, setShape] = useState('__keep__');
  const [groupId, setGroupId] = useState('__keep__');
  const [visited, setVisited] = useState<'__keep__' | 'yes' | 'no'>('__keep__');
  const [changeFill, setChangeFill] = useState(false);
  const [fill, setFill] = useState('#ffffff');
  const [changeText, setChangeText] = useState(false);
  const [textColor, setTextColor] = useState(PALETTE.nodeText);
  const [changeSize, setChangeSize] = useState(false);
  const [size, setSize] = useState(1);

  /* mirror the form so the commit closure always sees the latest values */
  const formRef = useRef({
    shape, groupId, visited, changeFill, fill, changeText, textColor, changeSize, size
  });
  formRef.current = {
    shape, groupId, visited, changeFill, fill, changeText, textColor, changeSize, size
  };
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const skipRef = useRef(false);

  const patchFrom = (f: typeof formRef.current) => {
    const patch: Partial<Location> = {};
    if (f.shape !== '__keep__') patch.kind = f.shape;
    if (f.visited !== '__keep__') patch.visited = f.visited === 'yes';
    if (f.changeFill) patch.color = f.fill;
    if (f.changeText) patch.textColor = f.textColor;
    if (f.changeSize) patch.size = f.size;
    if (f.groupId !== '__keep__' && f.groupId !== '__new__') {
      patch.groupId = f.groupId === '' ? null : f.groupId;
    }
    return patch;
  };

  const reset = () => {
    setShape('__keep__');
    setGroupId('__keep__');
    setVisited('__keep__');
    setChangeFill(false);
    setChangeText(false);
    setChangeSize(false);
  };

  /** Apply everything that was actually changed, then go back to "Keep Current". */
  const commit = useCallback(() => {
    if (skipRef.current) return;
    const f = formRef.current;
    const patch = patchFrom(f);
    const makeGroup = f.groupId === '__new__';
    if (!makeGroup && Object.keys(patch).length === 0) return;

    /* clear first so a second outside-click cannot re-apply the same edit */
    formRef.current = {
      ...f,
      shape: '__keep__',
      groupId: '__keep__',
      visited: '__keep__',
      changeFill: false,
      changeText: false,
      changeSize: false
    };
    reset();

    if (makeGroup) void createGroupFrom(idsRef.current);
    if (Object.keys(patch).length) void bulkUpdateLocations(idsRef.current, patch);
  }, [bulkUpdateLocations, createGroupFrom]);

  /* same contract as the single-element inspectors: click-out / unmount applies */
  useEffect(() => {
    inspectorCommit.current = commit;
    return () => {
      if (inspectorCommit.current === commit) inspectorCommit.current = null;
      commit();
    };
  }, [commit]);

  const groupList = useMemo(() => Object.values(groups).sort(byName), [groups]);
  const hasChanges = Object.keys(patchFrom(formRef.current)).length > 0 || groupId === '__new__';

  return (
    <>
      <div className="panel-head">
        <span className="badge multi">{members.length} Locations</span>
        <button
          className="danger"
          onClick={() => {
            if (confirm(`Delete these ${members.length} locations and their connections?`)) {
              skipRef.current = true;
              void deleteLocations(idsRef.current);
            }
          }}
        >
          Delete All
        </button>
      </div>

      <p className="muted small">
        Changes Below Are Applied To Every Selected Room When You Press Apply Or Click Away. Fields That Must Be
        Unique Per Room Are Disabled.
      </p>

      <label className="disabled-field">
        Name
        <input value="" disabled placeholder="Not Editable For Multiple Rooms" />
      </label>
      <label className="disabled-field">
        Layer
        <input value="" disabled placeholder="Not Editable For Multiple Rooms" />
      </label>

      <label>
        Shape
        <select value={shape} onChange={(e) => setShape(e.target.value)}>
          <option value="__keep__">Keep Current</option>
          {SHAPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>

      <InlineCheckField label="Change Size" checked={changeSize} onChange={setChangeSize} />
      {changeSize && (
        <div className="color-row">
          <input
            type="number"
            min={0.1}
            max={MAX_SIZE}
            step={0.1}
            value={size}
            onChange={(e) => setSize((prev) => parseSize(e.target.value, prev))}
          />
          <button
            onClick={() => {
              setChangeSize(false);
              void bulkUpdateLocations(idsRef.current, { size: 1 });
            }}
          >
            Reset To Normal
          </button>
        </div>
      )}

      <div className="field">
        <span className="field-label">Grouping</span>
        <GroupPicker
          groups={groupList}
          value={groupId === '__keep__' ? KEEP : groupId === '' ? null : groupId}
          keepLabel="Keep Current"
          onKeep={() => setGroupId('__keep__')}
          onPick={(gid) => setGroupId(gid ?? '')}
          newLabel="+ New Grouping From These Rooms"
          onCreateNew={() => setGroupId('__new__')}
        />
      </div>

      <div className="field">
        <span className="field-label">Add Label To All</span>
        <LabelPicker
          labels={Object.values(locationLabels)}
          onPick={(labelId) => void bulkAssignLocationLabel(idsRef.current, labelId)}
          buttonLabel="+ Apply Label"
        />
      </div>

      <label>
        Visited
        <select value={visited} onChange={(e) => setVisited(e.target.value as any)}>
          <option value="__keep__">Keep Current</option>
          <option value="yes">Visited</option>
          <option value="no">Not Visited</option>
        </select>
      </label>

      <InlineCheckField label="Change Box Color" checked={changeFill} onChange={setChangeFill} />
      {changeFill && (
        <div className="color-row">
          <input type="color" value={fill} onChange={(e) => setFill(e.target.value)} />
          <button
            onClick={() => {
              setChangeFill(false);
              void bulkUpdateLocations(idsRef.current, { color: '' });
            }}
          >
            Reset To Default
          </button>
        </div>
      )}

      <InlineCheckField label="Change Text Color" checked={changeText} onChange={setChangeText} />
      {changeText && (
        <div className="color-row">
          <input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)} />
          <button
            onClick={() => {
              setChangeText(false);
              void bulkUpdateLocations(idsRef.current, { textColor: '' });
            }}
          >
            Reset To Default
          </button>
        </div>
      )}

      <label className="disabled-field">
        Notes
        <textarea rows={4} value="" disabled placeholder="Not Editable For Multiple Rooms" />
      </label>

      <div className="row actions">
        <button disabled={!hasChanges} onClick={commit}>Apply To All</button>
        <button disabled={!hasChanges} onClick={reset}>Revert</button>
      </div>

      <h3>Selected Rooms</h3>
      <ul className="hit-list dense">
        {members.map((l) => (
          <li key={l.id}>
            <button className="link" onClick={() => selectLocation(l.id)}>
              <span className="hit-title">{l.name || 'Unnamed Location'}</span>
              <span className="muted small">
                {[l.layer, l.groupId ? groups[l.groupId]?.name : null].filter(Boolean).join(' · ') || 'No Layer'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/* --------------------------------------------------------------- container */

export default function DetailsPanel() {
  const selection = useGraphStore((s) => s.selection);
  const multiSelect = useGraphStore((s) => s.multiSelect);
  const locations = useGraphStore((s) => s.locations);
  const connections = useGraphStore((s) => s.connections);
  const groups = useGraphStore((s) => s.groups);
  const locationLabels = useGraphStore((s) => s.locationLabels);
  const connectionLabels = useGraphStore((s) => s.connectionLabels);

  const asideRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!asideRef.current || asideRef.current.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest('.menu-panel')) return; // don't commit while using a picker
      inspectorCommit.current?.();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, []);

  if (multiSelect.length > 1) {
    return (
      <aside className="inspector" ref={asideRef}>
        <h2>Inspector</h2>
        <MultiInspector key={multiSelect.join('|')} ids={multiSelect} />
      </aside>
    );
  }

  if (!selection) return null;

  const location = selection.type === 'location' ? locations[selection.id] : undefined;
  const connection = selection.type === 'connection' ? connections[selection.id] : undefined;
  const group = selection.type === 'group' ? groups[selection.id] : undefined;
  const locLabel = selection.type === 'location-label' ? locationLabels[selection.id] : undefined;
  const connLabel = selection.type === 'connection-label' ? connectionLabels[selection.id] : undefined;

  if (!location && !connection && !group && !locLabel && !connLabel) return null;

  return (
    <aside className="inspector" ref={asideRef}>
      <h2>Inspector</h2>
      {location && <LocationInspector key={location.id} location={location} />}
      {connection && <ConnectionInspector key={connection.id} connection={connection} />}
      {group && <GroupInspector key={group.id} group={group} />}
      {locLabel && <LocationLabelInspector key={locLabel.id} label={locLabel} />}
      {connLabel && <ConnectionLabelInspector key={connLabel.id} label={connLabel} />}
    </aside>
  );
}
