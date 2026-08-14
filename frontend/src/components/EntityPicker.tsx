import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatCoordinates } from '../graph/coordinateLayout';
import { groupPathLabel } from '../graph/groups';
import { directionGlyph } from '../graph/model';
import { PICK_KIND_LABEL, useGraphStore, type PickKind, type PickRequest } from '../state/store';
import { pushEscapeHandler } from '../utils/escapeStack';
import { Help } from './fields';

/* ------------------------------------------------------------ pick ownership */

export type TokenRef = { current: number | null };

/**
 * Arms canvas picks on behalf of one component, and disarms whatever it armed
 * the moment that component goes away — an inspector that unmounts must never
 * leave the canvas waiting to call a dead callback.
 */
export function usePickOwner(): { arm: (req: PickRequest) => void; tokenRef: TokenRef } {
  const tokenRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      const store = useGraphStore.getState();
      if (tokenRef.current !== null && store.pick?.token === tokenRef.current) store.cancelPick();
    },
    []
  );
  const arm = useCallback((req: PickRequest) => {
    tokenRef.current = useGraphStore.getState().beginPick(req);
  }, []);
  return { arm, tokenRef };
}

/** The canvas banner's "Search Instead" hands the pointer back to whoever armed it. */
export function usePickSearchReopen(tokenRef: TokenRef, reopen: () => void) {
  const pickSearch = useGraphStore((s) => s.pickSearch);
  const clearPickSearch = useGraphStore((s) => s.clearPickSearch);
  const reopenRef = useRef(reopen);
  reopenRef.current = reopen;
  useEffect(() => {
    if (pickSearch === null || pickSearch !== tokenRef.current) return;
    clearPickSearch();
    reopenRef.current();
  }, [pickSearch, clearPickSearch, tokenRef]);
}

/* --------------------------------------------------------------- searching */

type Scope = 'all' | 'self' | 'grouping' | 'label' | 'location';

/**
 * The scope chips differ per kind only in *wording*: "self" is whatever the
 * picker is picking. Everything a row can be found by is always searched under
 * "All", even when it has no chip of its own.
 */
const SCOPES: Record<PickKind, Array<{ value: Scope; label: string }>> = {
  location: [
    { value: 'all', label: 'All' },
    { value: 'self', label: 'Location' },
    { value: 'grouping', label: 'Grouping' },
    { value: 'label', label: 'Label' }
  ],
  connection: [
    { value: 'all', label: 'All' },
    { value: 'self', label: 'Connection' },
    { value: 'location', label: 'Location' },
    { value: 'label', label: 'Label' }
  ],
  group: [
    { value: 'all', label: 'All' },
    { value: 'self', label: 'Grouping' },
    { value: 'location', label: 'Location' },
    { value: 'label', label: 'Label' }
  ]
};

/** A hit on the thing's own name outranks a hit on something it merely belongs to. */
const SCOPE_WEIGHT: Record<string, number> = { self: 1, location: 0.7, grouping: 0.6, label: 0.6 };

const MAX_ROWS = 250;

interface Candidate {
  id: string;
  title: string;
  sub: string;
  color: string;
  /** scope -> every string a query may be matched against */
  texts: Record<string, string[]>;
}

const scoreOne = (hay: string, needle: string) => {
  const h = (hay || '').toLowerCase();
  if (!h) return 0;
  if (h === needle) return 100;
  if (h.startsWith(needle)) return 70;
  if (h.includes(needle)) return 40;
  return 0;
};

const pushAll = (m: Map<string, string[]>, key: string, values: string[]) => {
  if (!values.length) return;
  const cur = m.get(key);
  if (cur) cur.push(...values);
  else m.set(key, [...values]);
};

function useCandidates(kind: PickKind, includeIds?: Set<string> | null): Candidate[] {
  const locations = useGraphStore((s) => s.locations);
  const connections = useGraphStore((s) => s.connections);
  const groups = useGraphStore((s) => s.groups);
  const locationLabels = useGraphStore((s) => s.locationLabels);
  const connectionLabels = useGraphStore((s) => s.connectionLabels);

  return useMemo(() => {
    const locName = (id: string) => locations[id]?.name || 'Unnamed Location';
    /* both the plain name and the full path, so "House / Kitchen" finds it too */
    const groupTexts = (groupIds: string[]) =>
      groupIds.flatMap((gid) =>
        groups[gid] ? [groups[gid].name || 'Unnamed Grouping', groupPathLabel(groups, gid)] : []
      );

    if (kind === 'location') {
      return Object.values(locations)
        .filter((l) => !includeIds || includeIds.has(l.id))
        .map<Candidate>((l) => {
          const anchor = l.groupIds[0] && groups[l.groupIds[0]] ? groupPathLabel(groups, l.groupIds[0]) : '';
          return {
            id: l.id,
            title: l.name || 'Unnamed Location',
            sub:
              [anchor, formatCoordinates(l), l.visited ? 'Visited' : '']
                .filter(Boolean)
                .join(' · ') || '—',
            color: l.color || '#8fa7c4',
            texts: {
              self: [l.name],
              grouping: groupTexts(l.groupIds),
              label: l.labelIds.map((id) => locationLabels[id]?.name ?? '')
            }
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title));
    }

    if (kind === 'connection') {
      return Object.values(connections)
        .filter((c) => !includeIds || includeIds.has(c.id))
        .map<Candidate>((c) => {
          const a = locName(c.sourceId);
          const b = locName(c.targetId);
          const ends = `${a} ${directionGlyph(c)} ${b}`;
          return {
            id: c.id,
            title: c.name || ends,
            sub: [ends, c.ephemeral ? 'Ephemeral' : '', c.locked ? 'Locked' : '']
              .filter(Boolean)
              .join(' · '),
            color: c.color || '#5a6b85',
            texts: {
              self: [c.name],
              location: [a, b],
              grouping: groupTexts([
                ...(locations[c.sourceId]?.groupIds ?? []),
                ...(locations[c.targetId]?.groupIds ?? [])
              ]),
              label: c.labelIds.map((id) => connectionLabels[id]?.name ?? '')
            }
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title));
    }

    /* one pass over the rooms, so "which grouping has the Kitchen?" is cheap */
    const members = new Map<string, string[]>();
    const memberLabels = new Map<string, string[]>();
    for (const l of Object.values(locations)) {
      const labels = l.labelIds.map((id) => locationLabels[id]?.name ?? '').filter(Boolean);
      for (const gid of l.groupIds) {
        pushAll(members, gid, [l.name || 'Unnamed Location']);
        pushAll(memberLabels, gid, labels);
      }
    }

    return Object.values(groups)
      .filter((g) => !includeIds || includeIds.has(g.id))
      .map<Candidate>((g) => {
        const names = members.get(g.id) ?? [];
        return {
          id: g.id,
          title: g.name || 'Unnamed Grouping',
          sub: [groupPathLabel(groups, g.id), `${names.length} ${names.length === 1 ? 'Room' : 'Rooms'}`]
            .filter(Boolean)
            .join(' · '),
          color: g.color || '#8fa7c4',
          texts: {
            self: [g.name, groupPathLabel(groups, g.id)],
            location: names,
            label: memberLabels.get(g.id) ?? []
          }
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [kind, includeIds, locations, connections, groups, locationLabels, connectionLabels]);
}

/* ------------------------------------------------------------- the popover */

export interface EntityPickerPopoverProps {
  kind: PickKind;
  anchor: DOMRect;
  /** Shown on the canvas once the map is armed. */
  prompt: string;
  onPick: (id: string) => void;
  onClose: () => void;
  onArm: (req: PickRequest) => void;
  /** Restricts what may be chosen, in the list *and* on the canvas. */
  includeIds?: Set<string> | null;
  /** Already taken: listed, greyed, and refused. */
  excludeIds?: Set<string>;
  /** Keep going after a pick. */
  multi?: boolean;
  /** The same thing may be taken twice (trip stops). */
  allowDuplicates?: boolean;
  emptyLabel?: string;
  noneLabel?: string;
  onPickNone?: () => void;
  createLabel?: string;
  onCreateNew?: () => void;
  /** The button that opened us: a click on it toggles, it does not re-open. */
  ignoreEl?: HTMLElement | null;
}

export function EntityPickerPopover({
  kind,
  anchor,
  prompt,
  onPick,
  onClose,
  onArm,
  includeIds,
  excludeIds,
  multi,
  allowDuplicates,
  emptyLabel = 'No Matches.',
  noneLabel,
  onPickNone,
  createLabel,
  onCreateNew,
  ignoreEl
}: EntityPickerPopoverProps) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 4 });

  const candidates = useCandidates(kind, includeIds);
  const taken = (id: string) => !allowDuplicates && !!excludeIds?.has(id);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return candidates.slice(0, MAX_ROWS);
    const scored: Array<{ c: Candidate; score: number }> = [];
    for (const c of candidates) {
      let best = 0;
      const keys = scope === 'all' ? Object.keys(c.texts) : [scope];
      for (const k of keys) {
        const weight = scope === 'all' ? SCOPE_WEIGHT[k] ?? 0.5 : 1;
        for (const t of c.texts[k] ?? []) best = Math.max(best, scoreOne(t, needle) * weight);
      }
      if (best > 0) scored.push({ c, score: best });
    }
    scored.sort((a, b) => b.score - a.score || a.c.title.localeCompare(b.c.title));
    return scored.slice(0, MAX_ROWS).map((s) => s.c);
  }, [candidates, q, scope]);

  useEffect(() => setActive(0), [q, scope]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = anchor.left;
    let top = anchor.bottom + 4;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - r.width - 8);
    /* no room below: flip above the button rather than run off the screen */
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, anchor.top - r.height - 4);
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const offEscape = pushEscapeHandler(onClose);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (ignoreEl?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => {
      offEscape();
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose, ignoreEl]);

  useEffect(() => {
    (listRef.current?.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (id: string) => {
    if (taken(id)) return;
    onPick(id);
    if (!multi) {
      onClose();
      return;
    }
    setQ('');
    setActive(0);
  };

  const armCanvas = () => {
    onArm({
      kind,
      prompt,
      candidates: includeIds ?? null,
      chosen: excludeIds,
      multi,
      allowDuplicates,
      onPick
    });
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(Math.max(0, results.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = results[active];
      if (c) choose(c.id);
    }
  };

  /* `.menu-panel` is load-bearing: the inspector refuses to flush its draft for
     a mousedown inside one, so typing here never commits a half-edited form */
  return createPortal(
    <div
      ref={ref}
      className="menu-panel picker-popover"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <input
        className="picker-search"
        autoFocus
        value={q}
        placeholder={`Search ${PICK_KIND_LABEL[kind]}s…`}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="picker-scopes">
        {SCOPES[kind].map((s) => (
          <button
            key={s.value}
            className={`scope-chip ${scope === s.value ? 'active' : ''}`}
            title={
              s.value === 'all'
                ? 'Match the name, the groupings and the labels'
                : `Match ${s.label.toLowerCase()} names only`
            }
            onClick={() => setScope(s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <ul className="picker-results" ref={listRef}>
        {results.map((c, i) => {
          const isTaken = taken(c.id);
          return (
            <li key={c.id}>
              <button
                className={`picker-result ${i === active ? 'active' : ''} ${isTaken ? 'taken' : ''}`}
                disabled={isTaken}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(c.id)}
              >
                <span className="picker-dot" style={{ background: c.color }} />
                <span className="picker-text">
                  <span className="hit-title">{c.title}</span>
                  <span className="muted small">{c.sub}</span>
                </span>
                {isTaken && <span className="muted small">Added</span>}
              </button>
            </li>
          );
        })}
        {!results.length && <li className="muted small picker-empty">{emptyLabel}</li>}
      </ul>
      <div className="picker-foot">
        <button className="picker-canvas-btn" onClick={armCanvas}>
          🎯 Pick From The Map
        </button>
        {noneLabel && onPickNone && (
          <button
            onClick={() => {
              onPickNone();
              onClose();
            }}
          >
            {noneLabel}
          </button>
        )}
        {createLabel && onCreateNew && (
          <button
            onClick={() => {
              onCreateNew();
              onClose();
            }}
          >
            {createLabel}
          </button>
        )}
      </div>
      <p className="muted small picker-note">
        {results.length} Of {candidates.length}
        <Help text="↑↓ to move · Enter to choose · Esc to close" />
      </p>
    </div>,
    document.body
  );
}

/* --------------------------------------------------------------- the button */

export interface EntityPickerProps {
  kind: PickKind;
  buttonLabel: string;
  onPick: (id: string) => void;
  /** Replaces the caption once something is chosen. */
  valueLabel?: string | null;
  prompt?: string;
  includeIds?: Set<string> | null;
  excludeIds?: Set<string>;
  multi?: boolean;
  allowDuplicates?: boolean;
  disabled?: boolean;
  emptyLabel?: string;
  noneLabel?: string;
  onPickNone?: () => void;
  createLabel?: string;
  onCreateNew?: () => void;
}

export function EntityPickerButton({
  kind,
  buttonLabel,
  valueLabel,
  disabled,
  prompt,
  ...rest
}: EntityPickerProps) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const { arm, tokenRef } = usePickOwner();

  const open = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAnchor(r);
  }, []);
  usePickSearchReopen(tokenRef, open);

  const armed = useGraphStore((s) => !!s.pick && s.pick.token === tokenRef.current);

  return (
    <>
      <button
        ref={btnRef}
        className={`picker ${armed ? 'armed' : ''}`}
        disabled={disabled}
        onClick={() => (armed ? useGraphStore.getState().cancelPick() : open())}
      >
        <span className="picker-label">
          {armed ? 'Picking On The Map… (Esc)' : valueLabel ?? buttonLabel}
        </span>
        <span className="picker-arrow">{armed ? '✕' : '▾'}</span>
      </button>
      {anchor && (
        <EntityPickerPopover
          kind={kind}
          anchor={anchor}
          prompt={prompt ?? `Click A ${PICK_KIND_LABEL[kind]} On The Map`}
          onArm={arm}
          ignoreEl={btnRef.current}
          onClose={() => setAnchor(null)}
          {...rest}
        />
      )}
    </>
  );
}

export const LocationPicker = (props: Omit<EntityPickerProps, 'kind'>) => (
  <EntityPickerButton kind="location" {...props} />
);

/** Not wired into a panel yet — the canvas and the search both already support it. */
export const ConnectionPicker = (props: Omit<EntityPickerProps, 'kind'>) => (
  <EntityPickerButton kind="connection" {...props} />
);
