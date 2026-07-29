import { useMemo } from 'react';
import { focusGroup } from '../graph/cyHolder';
import { buildGroupTree, flattenGroupTree } from '../graph/groups';
import { useGraphStore } from '../state/store';

export default function GroupPanel() {
  const groups = useGraphStore((s) => s.groups);
  const locations = useGraphStore((s) => s.locations);
  const selectGroup = useGraphStore((s) => s.selectGroup);

  const rows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of Object.values(locations)) {
      if (l.groupId) counts.set(l.groupId, (counts.get(l.groupId) ?? 0) + 1);
    }
    return flattenGroupTree(buildGroupTree(Object.values(groups))).map((node) => ({
      ...node,
      count: counts.get(node.group.id) ?? 0
    }));
  }, [groups, locations]);

  return (
    <section className="panel">
      <h2>Groupings</h2>
      <ul className="hit-list">
        {rows.map(({ group, depth, count }) => (
          <li key={group.id} style={{ paddingLeft: 10 + depth * 14 }}>
            <button className="link" onClick={() => focusGroup(group.id, selectGroup)}>
              <span className="hit-title" style={{ color: group.textColor || undefined }}>
                <span className="group-dot" style={{ background: group.color || '#8fa7c4' }} />
                {group.name || 'Unnamed Grouping'}
              </span>
              <span className="muted small">
                {count} {count === 1 ? 'Room' : 'Rooms'}
                {count === 0 ? ' · Not Drawn Until It Has A Room' : ''}
              </span>
            </button>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="muted small">
            None Yet — Right-Click A Room And Choose "Create Grouping From This Room".
          </li>
        )}
      </ul>
    </section>
  );
}
