import { buildGroupTree, groupPathLabel, type GroupTreeNode } from '../graph/groups';
import type { Group } from '../types';
import type { MenuEntry } from './Menu';
import PickerButton from './PickerButton';

export const KEEP = '__keep__';

/** Grouping entries as nested sideways submenus, never a flat list. */
export function groupMenuEntries(
  nodes: GroupTreeNode[],
  onPick: (id: string) => void,
  exclude?: Set<string>,
  currentId?: string | null
): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const node of nodes) {
    if (exclude?.has(node.group.id)) continue;
    const label = node.group.name || 'Unnamed Grouping';
    const children = groupMenuEntries(node.children, onPick, exclude, currentId);

    if (!children.length) {
      out.push({ label, onSelect: () => onPick(node.group.id), active: currentId === node.group.id });
    } else {
      out.push({
        kind: 'submenu',
        label,
        items: [
          { label: `Use "${label}"`, onSelect: () => onPick(node.group.id), active: currentId === node.group.id },
          { kind: 'heading', label: 'Inside This Grouping' },
          ...children
        ]
      });
    }
  }
  return out;
}

interface Props {
  groups: Group[];
  /** A group id, `null` for none, or KEEP. */
  value: string | null | typeof KEEP;
  onPick: (groupId: string | null) => void;
  excludeIds?: Set<string>;
  noneLabel?: string;
  keepLabel?: string;
  onKeep?: () => void;
  newLabel?: string;
  onCreateNew?: () => void;
  disabled?: boolean;
}

export default function GroupPicker({
  groups,
  value,
  onPick,
  excludeIds,
  noneLabel = 'No Grouping',
  keepLabel,
  onKeep,
  newLabel,
  onCreateNew,
  disabled
}: Props) {
  const byId = Object.fromEntries(groups.map((g) => [g.id, g])) as Record<string, Group>;

  const label =
    value === KEEP
      ? keepLabel ?? 'Keep Current'
      : value && byId[value]
        ? groupPathLabel(byId, value)
        : noneLabel;

  const entries: MenuEntry[] = [];
  if (keepLabel) entries.push({ label: keepLabel, onSelect: () => onKeep?.(), active: value === KEEP });
  entries.push({ label: noneLabel, onSelect: () => onPick(null), active: value === null });

  const tree = groupMenuEntries(
    buildGroupTree(groups),
    (id) => onPick(id),
    excludeIds,
    typeof value === 'string' && value !== KEEP ? value : null
  );
  if (tree.length) {
    entries.push({ kind: 'heading', label: 'Groupings' });
    entries.push(...tree);
  }
  if (newLabel && onCreateNew) entries.push({ label: newLabel, onSelect: onCreateNew });

  return <PickerButton label={label} entries={entries} disabled={disabled} />;
}
