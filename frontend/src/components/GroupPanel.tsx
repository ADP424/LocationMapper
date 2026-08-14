import { useMemo, useState } from 'react';
import { focusGroup } from '../graph/cyHolder';
import { buildGroupTree, flattenGroupTree, hasGroupDefaults } from '../graph/groups';
import { useGraphStore } from '../state/store';
import { cssColor, readableOn } from '../utils/colors';

export default function GroupPanel() {
  const groups = useGraphStore((s) => s.groups);
  const locations = useGraphStore((s) => s.locations);
  const groupLayers = useGraphStore((s) => s.groupLayers);
  const selectGroup = useGraphStore((s) => s.selectGroup);
  const createGroup = useGraphStore((s) => s.createGroup);
  const mapId = useGraphStore((s) => s.mapId);
  const [name, setName] = useState('');
  /* the panel's real background, not a hard-coded hex — a future light theme
     needs no code change here, only the CSS variable's value */
  const panelBg = useMemo(() => cssColor('--bg-2', '#111722'), []);

  const rows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of Object.values(locations)) {
      for (const gid of l.groupIds) counts.set(gid, (counts.get(gid) ?? 0) + 1);
    }
    return flattenGroupTree(buildGroupTree(Object.values(groups))).map((node) => ({
      ...node,
      count: counts.get(node.group.id) ?? 0
    }));
  }, [groups, locations]);

  return (
    <section className="panel">
      <h2>Groupings</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          void createGroup(n);
          setName('');
        }}
      >
        <input
          value={name}
          disabled={!mapId}
          placeholder="New Grouping…"
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={!mapId}>
          Add
        </button>
      </form>
      <ul className="hit-list">
        {rows.map(({ group, depth, count }) => {
          const layer = groupLayers[group.id];
          const tint = group.textColor || group.color;
          /* the user's colour, nudged in lightness only, until it reads here */
          const color = tint ? readableOn(tint, panelBg) : undefined;
          return (
            <li key={group.id} style={{ paddingLeft: 10 + depth * 14 }}>
              <button className="link" onClick={() => focusGroup(group.id, selectGroup)}>
                <span className="hit-title" style={{ color }}>
                  <span className="group-dot" style={{ background: group.color || '#8fa7c4' }} />
                  {group.name || 'Unnamed Grouping'}
                </span>
                <span className="muted small">
                  {count} {count === 1 ? 'Room' : 'Rooms'}
                  {layer
                    ? ` · Layer ${layer.order}/${layer.total}${layer.note ? ` (${layer.note})` : ''}`
                    : ''}
                  {hasGroupDefaults(group) ? ' · Styles Its Rooms' : ''}
                  {count === 0 ? ' · Not Drawn Until It Has A Room' : ''}
                </span>
              </button>
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="muted small">
            None Yet — Add One Above, Or Right-Click A Room And Choose "Create Grouping From This
            Room".
          </li>
        )}
      </ul>
    </section>
  );
}
