import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  BASE_SCALE_RANGE,
  DRAG_LABELS,
  DRAG_MODES,
  EPHEMERAL_LABELS,
  EPHEMERAL_STYLES,
  SKELETON_LINE_WIDTH_RANGE,
  type DragMode,
  type EphemeralStyle
} from '../state/settings';
import { useGraphStore } from '../state/store';
import { pushEscapeHandler } from '../utils/escapeStack';
import { useFocusTrap } from './useFocusTrap';
import { InlineCheckField } from './fields';

/** The heading carries the meaning; the detail lives one hover away. */
function Help({ text }: { text: string }) {
  return (
    <span className="help" title={text} aria-label={text}>
      ?
    </span>
  );
}

function DragModeField({
  label,
  value,
  onChange
}: {
  label: string;
  value: DragMode;
  onChange: (next: DragMode) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as DragMode)}>
        {DRAG_MODES.map((m) => (
          <option key={m} value={m}>
            {DRAG_LABELS[m]}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function SettingsModal() {
  const open = useGraphStore((s) => s.settingsOpen);
  const settings = useGraphStore((s) => s.settings);
  const setSettings = useGraphStore((s) => s.setSettings);
  const resetSettings = useGraphStore((s) => s.resetSettings);
  const close = useGraphStore((s) => s.closeSettings);
  const trapRef = useFocusTrap(open);

  useEffect(() => {
    if (!open) return;
    return pushEscapeHandler(close);
  }, [open, close]);

  if (!open) return null;

  const strengthDisabled = !settings.constantSize;

  return createPortal(
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal"
        ref={trapRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id="settings-title">Settings</h2>
          <button className="icon" title="Close" onClick={close}>
            ✕
          </button>
        </header>

        <section className="modal-section">
          <h3>
            Scroll Sensitivity
            <Help text="How far one notch of the mouse wheel zooms." />
          </h3>
          <div className="slider-row">
            <input
              type="range"
              min={0.05}
              max={3}
              step={0.05}
              value={settings.scrollSensitivity}
              onChange={(e) => setSettings({ scrollSensitivity: Number(e.target.value) })}
            />
            <input
              className="num"
              type="number"
              min={0.05}
              max={4}
              step={0.05}
              value={settings.scrollSensitivity}
              onChange={(e) => setSettings({ scrollSensitivity: Number(e.target.value) })}
            />
          </div>
        </section>

        <section className="modal-section">
          <h3>
            Base Size
            <Help text="Scales every name — locations, connections, groupings. Boxes keep their natural size; names sit on a plate in the box's colour so they stay readable. Layouts leave room for the bigger names, so re-layout after changing it." />
          </h3>
          <div className="slider-row">
            <input
              type="range"
              min={BASE_SCALE_RANGE[0]}
              max={BASE_SCALE_RANGE[1]}
              step={0.25}
              value={settings.baseScale}
              onChange={(e) => setSettings({ baseScale: Number(e.target.value) })}
            />
            <input
              className="num"
              type="number"
              min={BASE_SCALE_RANGE[0]}
              max={BASE_SCALE_RANGE[1]}
              step={0.25}
              value={settings.baseScale}
              onChange={(e) => setSettings({ baseScale: Number(e.target.value) })}
            />
          </div>
        </section>

        <section className="modal-section">
          <h3>
            Zoom-Independent Sizing
            <Help text="Keeps names the same size on screen while you zoom — boxes always scale with the zoom. When too many names would be on screen at once, the effect eases back toward normal scaling so the small ones can be culled again." />
          </h3>
          <div className="slider-row">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              disabled={strengthDisabled}
              value={settings.sizeCompensation}
              onChange={(e) => setSettings({ sizeCompensation: Number(e.target.value) })}
            />
            <input
              className="num"
              type="number"
              min={0}
              max={1}
              step={0.05}
              disabled={strengthDisabled}
              value={settings.sizeCompensation}
              onChange={(e) => setSettings({ sizeCompensation: Number(e.target.value) })}
            />
            <InlineCheckField
              label="Enabled"
              checked={settings.constantSize}
              onChange={(v) => setSettings({ constantSize: v })}
            />
          </div>
        </section>

        <section className="modal-section">
          <h3>
            Zoomed-Out Skeleton
            <Help text="Past the zoom where a size-1 room's name stops being legible, the map flips to its skeleton: rooms and names fade out, and each grouping shows its name centred in its box. The flip happens at exactly the same zoom whether you are zooming in or out. Connection lines can hold a constant on-screen thickness there — or be dropped entirely, leaving only the groupings, which is the cheapest way to look at a very large map." />
          </h3>
          <div className="slider-row">
            <input
              type="range"
              min={SKELETON_LINE_WIDTH_RANGE[0]}
              max={SKELETON_LINE_WIDTH_RANGE[1]}
              step={0.25}
              disabled={!settings.skeletonLines}
              value={settings.skeletonLineWidth}
              onChange={(e) => setSettings({ skeletonLineWidth: Number(e.target.value) })}
            />
            <input
              className="num"
              type="number"
              min={SKELETON_LINE_WIDTH_RANGE[0]}
              max={SKELETON_LINE_WIDTH_RANGE[1]}
              step={0.25}
              disabled={!settings.skeletonLines}
              value={settings.skeletonLineWidth}
              onChange={(e) => setSettings({ skeletonLineWidth: Number(e.target.value) })}
            />
            <InlineCheckField
              label="Connection Lines"
              checked={settings.skeletonLines}
              onChange={(v) => setSettings({ skeletonLines: v })}
            />
          </div>
          <p className="muted small">
            Line Thickness In Pixels — A Weight-1 Connection Is Drawn At Exactly This. Turn The Lines
            Off To Leave Only The Groupings.
          </p>
          <div className="slider-row">
            <InlineCheckField
              label="Allow Zooming Out Into It"
              title="Off, the zoom stops at the transition point, so the skeleton is never reached"
              checked={settings.allowSkeletonZoom}
              onChange={(v) => setSettings({ allowSkeletonZoom: v })}
            />
            <span className="muted small">
              Off, The Zoom Stops At The Transition Point — Fit Will Not Show A Map Larger Than That.
            </span>
          </div>
        </section>

        <section className="modal-section">
          <h3>
            Ephemeral Connections
            <Help text="Detached stubs draw a labelled box near each room. Arrows draw only a short line into space, ending in whichever arrowhead the connection designates for that end, with the description alongside the line — less clutter on dense maps. Either way the ends stay draggable and keep their saved offsets, and the connection's name rides the line in italics." />
          </h3>
          <label>
            Display As
            <select
              value={settings.ephemeralStyle}
              onChange={(e) => setSettings({ ephemeralStyle: e.target.value as EphemeralStyle })}
            >
              {EPHEMERAL_STYLES.map((m) => (
                <option key={m} value={m}>
                  {EPHEMERAL_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="modal-section">
          <h3>Dragging</h3>
          <DragModeField
            label="Groupings"
            value={settings.groupDrag}
            onChange={(groupDrag) => setSettings({ groupDrag })}
          />
          <DragModeField
            label="Locations"
            value={settings.locationDrag}
            onChange={(locationDrag) => setSettings({ locationDrag })}
          />
        </section>

        <section className="modal-section">
          <h3>
            Trip Planner
            <Help text="Route planning can take exponential time on maps with many independently ordered locked doors. With the limit off the search runs until it is exhaustive — you can always cancel it from the Trip Planner panel." />
          </h3>
          <div className="slider-row">
            <InlineCheckField
              label="Limit Search Time"
              checked={settings.limitSearchTime}
              onChange={(v) => setSettings({ limitSearchTime: v })}
            />
            <input
              className="num"
              type="number"
              min={1}
              max={3600}
              step={1}
              disabled={!settings.limitSearchTime}
              value={settings.searchTimeLimitSeconds}
              onChange={(e) =>
                setSettings({ searchTimeLimitSeconds: Math.max(1, Math.round(Number(e.target.value) || 1)) })
              }
            />
            <span className="muted small">Seconds</span>
          </div>
        </section>

        <footer className="modal-foot">
          <button onClick={resetSettings}>Restore Defaults</button>
          <button onClick={close}>Done</button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
