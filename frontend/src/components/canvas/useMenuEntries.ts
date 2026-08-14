import { useMemo } from 'react';
import { fitGraph } from '../../graph/cyHolder';
import { anchorGroupId, buildGroupTree, descendantGroupIds } from '../../graph/groups';
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
  const pick = useGraphStore((s) => s.pick);

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

    const buildBase = (): MenuEntry[] => {
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
            onSelect: () => void store.createLocationAt(contextMenu.graphX, contextMenu.graphY, [id])
          },
          {
            label: `+ Create Room Outside "${name}"`,
            onSelect: () => void store.createLocationAt(contextMenu.graphX, contextMenu.graphY)
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
        const isBulk = selected.length > 1;

        /* memberships are additive now: right-clicking a room only ever *adds* a
           grouping — dragging onto one is deliberately not a feature (see
           useDragModes), so this is the one place a room joins by pointer alone */
        const add = (groupId: string) =>
          isBulk
            ? void store.bulkAssignLocationGroup(selected, groupId)
            : void store.addLocationGroup(id, groupId);
        const addEntries = groupMenuEntries(tree, add, undefined, null);

        /* only offer to remove groupings every selected room is actually in,
           so a bulk action never silently no-ops for part of the batch */
        const commonGroupIds = selected
          .map((sid) => locations[sid])
          .filter((l): l is NonNullable<typeof l> => !!l)
          .reduce<string[] | null>(
            (acc, l) => (acc === null ? l.groupIds : acc.filter((gid) => l.groupIds.includes(gid))),
            null
          );
        const removeEntries = (commonGroupIds ?? [])
          .map((gid) => groups[gid])
          .filter((g): g is NonNullable<typeof g> => !!g)
          .map((g) => ({
            label: g.name || 'Unnamed Grouping',
            onSelect: () =>
              isBulk
                ? selected.forEach((sid) => void store.removeLocationGroup(sid, g.id))
                : void store.removeLocationGroup(id, g.id)
          }));

        return [
          { label: '+ Create Connection', onSelect: () => store.startConnectionFrom(id) },
          {
            label: isBulk ? `+ Create Grouping From ${selected.length} Rooms` : '+ Create Grouping From This Room',
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
          ...(addEntries.length
            ? [
                {
                  kind: 'submenu' as const,
                  label: isBulk ? `Add ${selected.length} Rooms To Grouping` : 'Add To Grouping',
                  items: addEntries
                }
              ]
            : []),
          ...(removeEntries.length
            ? [
                {
                  kind: 'submenu' as const,
                  label: isBulk ? `Remove ${selected.length} Rooms From Grouping` : 'Remove From Grouping',
                  items: removeEntries
                }
              ]
            : []),
          {
            label: isBulk ? `Delete ${selected.length} Locations` : 'Delete Location',
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
    };

    const base = buildBase();
    if (!pick) return base;

    /* A pick is armed: answer it from here too, and keep every other action
       reachable underneath — right-clicking must never be a dead end. */
    const picked: MenuEntry[] = [{ kind: 'heading', label: pick.prompt }];

    if (pick.kind === 'location' && contextMenu.locationId) {
      const id = contextMenu.locationId;
      picked.push({
        label: `Use "${locations[id]?.name || 'Unnamed Location'}"`,
        onSelect: () => store.resolvePick('location', id)
      });
    }
    if (pick.kind === 'connection' && contextMenu.connectionId) {
      const id = contextMenu.connectionId;
      picked.push({ label: 'Use This Connection', onSelect: () => store.resolvePick('connection', id) });
    }
    if (pick.kind === 'group') {
      if (contextMenu.groupId) {
        const id = contextMenu.groupId;
        picked.push({
          label: `Use "${groups[id]?.name || 'Unnamed Grouping'}"`,
          onSelect: () => store.resolvePick('group', id)
        });
      } else if (contextMenu.locationId) {
        const anchor = anchorGroupId(locations[contextMenu.locationId]!);
        if (anchor && groups[anchor]) {
          picked.push({
            label: `Use "${groups[anchor].name || 'Unnamed Grouping'}" (Around This Room)`,
            onSelect: () => store.resolvePick('group', anchor)
          });
        }
      }
    }

    picked.push({ label: '🔍 Search Instead…', onSelect: () => store.requestPickSearch() });
    picked.push({ label: 'Stop Picking', onSelect: () => store.cancelPick() });
    picked.push({ kind: 'heading', label: 'Other Actions' });

    return [...picked, ...base];
  }, [contextMenu, locations, groups, multiSelect, selection, pick]);
}
