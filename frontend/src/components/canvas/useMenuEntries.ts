import { useMemo } from 'react';
import { fitGraph } from '../../graph/cyHolder';
import { buildGroupTree, descendantGroupIds } from '../../graph/groups';
import { useGraphStore } from '../../state/store';
import { groupMenuEntries } from '../GroupPicker';
import type { MenuEntry } from '../Menu';

/** The context-menu entries for whatever `contextMenu` currently targets. Pure
 *  and store-driven, so it can be derived during render. */
export function useMenuEntries(): MenuEntry[] {
  const contextMenu = useGraphStore((s) => s.contextMenu);
  const locations = useGraphStore((s) => s.locations);
  const groups = useGraphStore((s) => s.groups);
  const multiSelect = useGraphStore((s) => s.multiSelect);
  const selection = useGraphStore((s) => s.selection);

  return useMemo(() => {
    if (!contextMenu) return [];
    const store = useGraphStore.getState();
    const groupList = Object.values(groups);
    const tree = buildGroupTree(groupList);
    /* makes "Draggable When Selected" comfortable: put the thing down from here */
    const deselect: MenuEntry[] =
      selection || multiSelect.length
        ? [{ label: 'Deselect', onSelect: () => store.select(null) }]
        : [];

    if (contextMenu.groupId) {
      const id = contextMenu.groupId;
      const name = groups[id]?.name || 'Unnamed Grouping';
      const forbidden = descendantGroupIds(groupList, id);
      const moveEntries = groupMenuEntries(
        tree,
        (parentId) => void store.setGroupParent(id, parentId),
        forbidden,
        groups[id]?.parentId ?? null
      );

      return [
        { kind: 'heading', label: name },
        {
          label: `+ Create Room Inside "${name}"`,
          onSelect: () => void store.createLocationAt(contextMenu.graphX, contextMenu.graphY, id)
        },
        {
          label: `+ Create Room Outside "${name}"`,
          onSelect: () => void store.createLocationAt(contextMenu.graphX, contextMenu.graphY, null)
        },
        { label: 'Inspect Grouping', onSelect: () => store.selectGroup(id) },
        ...deselect,
        {
          kind: 'submenu',
          label: 'Move Grouping Into',
          items: [
            {
              label: 'Top Level (No Parent)',
              onSelect: () => void store.setGroupParent(id, null),
              active: !groups[id]?.parentId
            },
            ...(moveEntries.length ? [{ kind: 'heading' as const, label: 'Groupings' }, ...moveEntries] : [])
          ]
        },
        { label: 'Remove All Rooms From Grouping', onSelect: () => void store.ungroupAll(id) },
        {
          label: 'Delete Grouping (Keep Contents)',
          danger: true,
          onSelect: () => void store.deleteGroup(id)
        }
      ];
    }

    if (contextMenu.locationId) {
      const id = contextMenu.locationId;
      const loc = locations[id];
      const selected = multiSelect.includes(id) ? multiSelect : [id];
      const assign = (groupId: string | null) =>
        selected.length > 1
          ? void store.bulkUpdateLocations(selected, { groupId })
          : void store.setLocationGroup(id, groupId);

      const groupEntries = groupMenuEntries(tree, assign, undefined, loc?.groupId ?? null);

      return [
        { label: '+ Create Connection', onSelect: () => store.startConnectionFrom(id) },
        {
          label:
            selected.length > 1
              ? `+ Create Grouping From ${selected.length} Rooms`
              : '+ Create Grouping From This Room',
          onSelect: () => void store.createGroupFrom(selected)
        },
        { label: 'Inspect Location', onSelect: () => store.selectLocation(id) },
        ...deselect,
        {
          label: `+ Add To Trip (Stop ${store.trip.waypoints.length + 1})`,
          onSelect: () => store.addWaypoint(id)
        },
        {
          label: loc?.visited ? 'Mark As Not Visited' : 'Mark As Visited',
          onSelect: () => void store.toggleVisited(id)
        },
        {
          kind: 'submenu',
          label: selected.length > 1 ? `Move ${selected.length} Rooms Into` : 'Move Into Grouping',
          items: [
            { label: 'No Grouping', onSelect: () => assign(null), active: !loc?.groupId },
            ...(groupEntries.length
              ? [{ kind: 'heading' as const, label: 'Groupings' }, ...groupEntries]
              : [])
          ]
        },
        {
          label: selected.length > 1 ? `Delete ${selected.length} Locations` : 'Delete Location',
          danger: true,
          onSelect: () => {
            if (confirm(`Delete ${selected.length} location(s) and their connections?`)) {
              void store.deleteLocations(selected);
            }
          }
        }
      ];
    }

    return [
      {
        label: '+ Create Room',
        onSelect: () => void store.createLocationAt(contextMenu.graphX, contextMenu.graphY)
      },
      ...deselect,
      { label: 'Fit To Screen', onSelect: () => fitGraph() }
    ];
  }, [contextMenu, locations, groups, multiSelect, selection]);
}
