import { useRef, useState } from 'react';
import MenuPanel, { type MenuEntry } from './Menu';

/** A "▾" button that opens a cascading menu underneath itself. */
export default function PickerButton({
  label,
  entries,
  disabled
}: {
  label: string;
  entries: MenuEntry[];
  disabled?: boolean;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

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
    </>
  );
}
