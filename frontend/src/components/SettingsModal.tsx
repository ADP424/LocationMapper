import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useGraphStore } from '../state/store';
import { pushEscapeHandler } from '../utils/escapeStack';
import { useFocusTrap } from './useFocusTrap';
import { InlineCheckField } from './fields';

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
          <h3>Scroll Sensitivity</h3>
          <p className="muted small">How far one notch of the mouse wheel zooms.</p>
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
          <h3>Zoom-Independent Sizing</h3>
          <p className="muted small">
            Keeps location boxes and connection names readable at any distance. Labels may
            overlap when zoomed far out.
          </p>
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
          <p className="muted small">
            1.00 = Exactly The Same Size On Screen · 0.00 = Scales Normally
          </p>
        </section>

        <section className="modal-section">
          <h3>Hide Tiny Text</h3>
          <p className="muted small">
            When On, Names Are Dropped Once They Would Render Too Small To Read. Turn It Off
            To Always Draw Them, However Far Out You Scroll (Slower On Very Large Maps).
          </p>
          <InlineCheckField
            label="Hide Tiny Text"
            checked={settings.hideSmallLabels}
            onChange={(v) => setSettings({ hideSmallLabels: v })}
          />
        </section>

        <section className="modal-section">
          <h3>Trip Planner</h3>
          <p className="muted small">
            Route planning can take exponential time on maps with many independently ordered
            locked doors. With the limit off, the search runs until it is exhaustive — you can
            always cancel it from the Trip Planner panel.
          </p>
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
