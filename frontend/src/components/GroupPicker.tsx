import { useRef, useState } from 'react';
import { buildGroupTree, groupPathLabel, type GroupTreeNode } from '../graph/groups';
import type { Group } from '../types';
import { EntityPickerPopover, usePickOwner, usePickSearchReopen } from './EntityPicker';
import MenuPanel, { type MenuEntry } from './Menu';

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
  /**
   * Whether "no grouping" is a real choice. Action pickers ("+ Add Grouping")
   * borrow `noneLabel` purely as a caption, and must not offer a no-op entry.
   */
  allowNone?: boolean;
  /** Banner text while the map is armed. */
  pickPrompt?: string;
}

/**
 * Three ways to the same answer, because a map can be organised three ways:
 * walk the nesting, search by name/room/label, or click the grouping itself.
 */
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
  disabled,
  allowNone = true,
  pickPrompt
}: Props) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [search, setSearch] = useState<DOMRect | null>(null);
  const { arm, tokenRef } = usePickOwner();

  const openSearch = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setSearch(r);
  };
  usePickSearchReopen(tokenRef, openSearch);

  const byId = Object.fromEntries(groups.map((g) => [g.id, g])) as Record<string, Group>;
  const label =
    value === KEEP
      ? keepLabel ?? 'Keep Current'
      : value && byId[value]
        ? groupPathLabel(byId, value)
        : noneLabel;

  /* whatever this picker would accept, the canvas and the search accept too */
  const candidates = new Set(groups.map((g) => g.id).filter((id) => !excludeIds?.has(id)));
  const prompt = pickPrompt ?? 'Click A Grouping On The Map';

  const entries: MenuEntry[] = [];
  if (keepLabel) entries.push({ label: keepLabel, onSelect: () => onKeep?.(), active: value === KEEP });
  if (allowNone) entries.push({ label: noneLabel, onSelect: () => onPick(null), active: value === null });

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

  entries.push({ kind: 'heading', label: 'Find It Another Way' });
  entries.push({ label: '🔍 Search Groupings…', onSelect: openSearch, disabled: !candidates.size });
  entries.push({
    label: '🎯 Pick From The Map',
    disabled: !candidates.size,
    onSelect: () => arm({ kind: 'group', prompt, candidates, onPick: (id) => onPick(id) })
  });

  if (newLabel && onCreateNew) entries.push({ label: newLabel, onSelect: onCreateNew });

  return (
    <>
      <button
        ref={btnRef}
        className="picker"
        disabled={disabled}
        onClick={() => {
          const r = btnRef.current?.getBoundingClientRect();
          if (r) setMenu({ x: r.left, y: r.bottom + 4 });
        }}
      >
        <span className="picker-label">{label}</span>
        <span className="picker-arrow">▾</span>
      </button>
      {menu && <MenuPanel x={menu.x} y={menu.y} items={entries} onClose={() => setMenu(null)} />}
      {search && (
        <EntityPickerPopover
          kind="group"
          anchor={search}
          prompt={prompt}
          includeIds={candidates}
          onPick={(id) => onPick(id)}
          onArm={arm}
          onClose={() => setSearch(null)}
          ignoreEl={btnRef.current}
          emptyLabel="No Groupings Match."
          noneLabel={allowNone ? noneLabel : undefined}
          onPickNone={allowNone ? () => onPick(null) : undefined}
          createLabel={newLabel}
          onCreateNew={onCreateNew}
        />
      )}
    </>
  );
}
