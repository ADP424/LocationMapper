import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { DRAG_LABELS, DRAG_MODES, type DragMode } from '../state/settings';
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
            <Help text="Scales every location and connection, independent of zoom. 2 = twice the natural size. Layouts space for it, so re-layout after changing it." />
          </h3>
          <div className="slider-row">
            <input
              type="range"
              min={0.25}
              max={32}
              step={0.25}
              value={settings.baseScale}
              onChange={(e) => setSettings({ baseScale: Number(e.target.value) })}
            />
            <input
              className="num"
              type="number"
              min={0.25}
              max={32}
              step={0.25}
              value={settings.baseScale}
              onChange={(e) => setSettings({ baseScale: Number(e.target.value) })}
            />
          </div>
        </section>

        <section className="modal-section">
          <h3>
            Zoom-Independent Sizing
            <Help text="Keeps boxes and names the same size on screen while you zoom. 1.00 = exactly constant, 0.00 = scales normally. It re-styles every element on each zoom step, so it is rate-limited on big maps and pauses itself past ~8,000 elements." />
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
            Hide Tiny Text
            <Help text="Drops names once they would render too small to read. Turn it off to always draw them, however far out you scroll — slower on very large maps." />
          </h3>
          <InlineCheckField
            label="Enabled"
            checked={settings.hideSmallLabels}
            onChange={(v) => setSettings({ hideSmallLabels: v })}
          />
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
