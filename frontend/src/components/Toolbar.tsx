import { useRef } from 'react';
import { cyHolder } from '../graph/cyHolder';
import type { LabelMode } from '../graph/elements';
import { LAYOUT_LABELS, LayoutName } from '../graph/layouts';
import { DIRECTION_OPTIONS, type Direction } from '../graph/model';
import { useGraphStore } from '../state/store';

export default function Toolbar() {
  const fileRef = useRef<HTMLInputElement>(null);

  const mode = useGraphStore((s) => s.mode);
  const setMode = useGraphStore((s) => s.setMode);
  const layout = useGraphStore((s) => s.layout);
  const setLayout = useGraphStore((s) => s.setLayout);
  const runLayout = useGraphStore((s) => s.runLayout);
  const labelMode = useGraphStore((s) => s.labelMode);
  const setLabelMode = useGraphStore((s) => s.setLabelMode);
  const groupByLayer = useGraphStore((s) => s.groupByLayer);
  const setGroupByLayer = useGraphStore((s) => s.setGroupByLayer);
  const defaults = useGraphStore((s) => s.connectionDefaults);
  const setDefaults = useGraphStore((s) => s.setConnectionDefaults);
  const exportMap = useGraphStore((s) => s.exportCurrentMap);
  const importMapFile = useGraphStore((s) => s.importMapFile);
  const mapId = useGraphStore((s) => s.mapId);
  const busy = useGraphStore((s) => s.busy);

  const disabled = !mapId;

  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <strong className="brand">MapGraph</strong>
      </div>

      <div className="toolbar-group">
        <button
          className={mode === 'add-location' ? 'active' : ''}
          disabled={disabled}
          onClick={() => setMode(mode === 'add-location' ? 'select' : 'add-location')}
          title="Click The Canvas To Drop A New Location"
        >
          + Location
        </button>
        <button
          className={mode === 'connect' ? 'active' : ''}
          disabled={disabled}
          onClick={() => setMode(mode === 'connect' ? 'select' : 'connect')}
          title="Click A Source Location, Then A Target Location"
        >
          + Connection
        </button>
      </div>

      <div className="toolbar-group" title="Defaults Applied To New Connections">
        <label className="inline-label">
          New Direction
          <select
            value={defaults.direction}
            onChange={(e) => setDefaults({ direction: e.target.value as Direction })}
          >
            {DIRECTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="check-field">
          <span className="field-label">New Ephemeral</span>
          <input
            type="checkbox"
            checked={defaults.ephemeral}
            onChange={(e) => setDefaults({ ephemeral: e.target.checked })}
          />
        </div>
        <div className="check-field">
          <span className="field-label">New Locked</span>
          <input
            type="checkbox"
            checked={defaults.locked}
            onChange={(e) => setDefaults({ locked: e.target.checked })}
          />
        </div>
      </div>

      <div className="toolbar-group">
        <label className="inline-label">
          Layout
          <select
            value={layout}
            disabled={disabled}
            onChange={(e) => setLayout(e.target.value as LayoutName)}
          >
            {Object.entries(LAYOUT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button disabled={disabled || busy} onClick={runLayout}>
          Re-Layout
        </button>
        <button disabled={disabled} onClick={() => cyHolder.cy?.fit(undefined, 60)}>
          Fit
        </button>
      </div>

      <div className="toolbar-group">
        <label className="inline-label">
          Labels
          <select value={labelMode} onChange={(e) => setLabelMode(e.target.value as LabelMode)}>
            <option value="names">Names</option>
            <option value="all">Names And Badges</option>
            <option value="none">None</option>
          </select>
        </label>
        <div className="check-field">
          <span className="field-label">Group By Layer</span>
          <input
            type="checkbox"
            checked={groupByLayer}
            onChange={(e) => setGroupByLayer(e.target.checked)}
          />
        </div>
      </div>

      <div className="toolbar-group right">
        <button disabled={disabled} onClick={() => void exportMap()}>
          Export
        </button>
        <button onClick={() => fileRef.current?.click()}>Import</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importMapFile(f);
            e.target.value = '';
          }}
        />
      </div>
    </header>
  );
}
