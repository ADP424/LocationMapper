import { useRef, useState } from 'react';
import MenuPanel, { type MenuEntry } from './Menu';

export interface PickableLabel {
  id: string;
  name: string;
  color: string;
}

interface Props {
  labels: PickableLabel[];
  exclude?: Set<string>;
  onPick: (labelId: string) => void;
  onCreateNew?: () => void;
  newLabel?: string;
  buttonLabel?: string;
  disabled?: boolean;
}

/** A dropdown menu for attaching a label to a location/connection (or many at once). */
export default function LabelPicker({
  labels,
  exclude,
  onPick,
  onCreateNew,
  newLabel = '+ New Label',
  buttonLabel = '+ Add Label',
  disabled
}: Props) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const available = labels
    .filter((l) => !exclude?.has(l.id))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const entries: MenuEntry[] = available.length
    ? available.map((l) => ({ label: l.name || 'Unnamed Label', onSelect: () => onPick(l.id) }))
    : [{ label: 'No Labels Available', onSelect: () => undefined, disabled: true }];

  if (onCreateNew) entries.push({ label: newLabel, onSelect: onCreateNew });

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
        <span className="picker-label">{buttonLabel}</span>
        <span className="picker-arrow">▾</span>
      </button>
      {menu && <MenuPanel x={menu.x} y={menu.y} items={entries} onClose={() => setMenu(null)} />}
    </>
  );
}
