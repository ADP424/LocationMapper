import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pushEscapeHandler } from '../utils/escapeStack';

export interface MenuAction {
  kind?: 'action';
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  active?: boolean;
}
export interface MenuSubmenu {
  kind: 'submenu';
  label: string;
  items: MenuEntry[];
}
export interface MenuHeading {
  kind: 'heading';
  label: string;
}
export type MenuEntry = MenuAction | MenuSubmenu | MenuHeading;

const isSubmenu = (e: MenuEntry): e is MenuSubmenu => (e as any).kind === 'submenu';
const isHeading = (e: MenuEntry): e is MenuHeading => (e as any).kind === 'heading';

/** Submenus render in a portal so they can stretch past their parent freely. */
function Submenu({
  anchor,
  items,
  onClose,
  onEnter,
  onLeave
}: {
  anchor: DOMRect;
  items: MenuEntry[];
  onClose: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.right - 3, top: anchor.top - 6 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = anchor.right - 3;
    let top = anchor.top - 6;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, anchor.left - r.width + 3);
    if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
    if (top < 8) top = 8;
    setPos({ left, top });
  }, [anchor, items]);

  return createPortal(
    <div
      ref={ref}
      className="menu-panel"
      style={{ left: pos.left, top: pos.top }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItems items={items} onClose={onClose} />
    </div>,
    document.body
  );
}

function MenuItems({ items, onClose }: { items: MenuEntry[]; onClose: () => void }) {
  const [open, setOpen] = useState<{ index: number; rect: DOMRect } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const cancelClose = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  const scheduleClose = () => {
    cancelClose();
    timer.current = window.setTimeout(() => setOpen(null), 260);
  };
  useEffect(() => cancelClose, []);

  return (
    <ul className="menu-items">
      {items.map((item, i) => {
        if (isHeading(item)) {
          return (
            <li key={`h${i}`} className="menu-heading">
              {item.label}
            </li>
          );
        }
        if (isSubmenu(item)) {
          const expanded = open?.index === i;
          return (
            <li
              key={`s${i}`}
              className="menu-row"
              onMouseEnter={(e) => {
                cancelClose();
                setOpen({ index: i, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
              }}
              onMouseLeave={scheduleClose}
            >
              <button
                className={`menu-button ${expanded ? 'expanded' : ''}`}
                onClick={(e) =>
                  setOpen(
                    expanded
                      ? null
                      : { index: i, rect: (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect() }
                  )
                }
              >
                <span className="menu-label">{item.label}</span>
                <span className="menu-arrow">▸</span>
              </button>
              {expanded && open && (
                <Submenu
                  anchor={open.rect}
                  items={item.items}
                  onClose={onClose}
                  onEnter={cancelClose}
                  onLeave={scheduleClose}
                />
              )}
            </li>
          );
        }
        return (
          <li key={`a${i}`} className="menu-row">
            <button
              className={`menu-button ${item.danger ? 'danger' : ''} ${item.active ? 'active' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                item.onSelect();
                onClose();
              }}
            >
              <span className="menu-label">{item.label}</span>
              {item.active && <span className="menu-check">✓</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Root panel, positioned at viewport coordinates. */
export default function MenuPanel({
  x,
  y,
  items,
  onClose
}: {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: x + r.width > window.innerWidth - 8 ? Math.max(8, window.innerWidth - r.width - 8) : x,
      top: y + r.height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - r.height - 8) : y
    });
  }, [x, y, items]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.menu-panel')) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    /* top of the Escape stack while open, so Escape closes only this panel */
    const offEscape = pushEscapeHandler(onClose);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      offEscape();
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="menu-panel root"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItems items={items} onClose={onClose} />
    </div>,
    document.body
  );
}
