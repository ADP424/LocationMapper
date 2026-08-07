import { useRef } from 'react';
import { cyHolder } from '../graph/cyHolder';
import type { LabelMode } from '../graph/elements';
import { LAYOUT_GROUPS, LAYOUT_LABELS, LayoutName } from '../graph/layouts';
import { DIRECTION_OPTIONS, type Direction } from '../graph/model';
import { useGraphStore } from '../state/store';
import { CheckField } from './fields';

export default function Toolbar() {
  const fileRef = useRef<HTMLInputElement>(null);

  const mode = useGraphStore((s) => s.mode);
  const setMode = useGraphStore((s) => s.setMode);
  const viewMode = useGraphStore((s) => s.viewMode);
  const setViewMode = useGraphStore((s) => s.setViewMode);
  const layout = useGraphStore((s) => s.layout);
  const setLayout = useGraphStore((s) => s.setLayout);
  const runLayout = useGraphStore((s) => s.runLayout);
  const labelMode = useGraphStore((s) => s.labelMode);
  const setLabelMode = useGraphStore((s) => s.setLabelMode);
  const defaults = useGraphStore((s) => s.connectionDefaults);
  const setDefaults = useGraphStore((s) => s.setConnectionDefaults);
  const exportMap = useGraphStore((s) => s.exportCurrentMap);
  const importMapFile = useGraphStore((s) => s.importMapFile);
  const mapId = useGraphStore((s) => s.mapId);
  const busy = useGraphStore((s) => s.busy);
  const openSettings = useGraphStore((s) => s.openSettings);

  const disabled = !mapId;

  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <strong className="brand">MapGraph</strong>
      </div>

      <div className="toolbar-group" title="The Same Map, Drawn Two Ways">
        <button
          className={viewMode === '2d' ? 'active' : ''}
          disabled={disabled}
          onClick={() => setViewMode('2d')}
        >
          2D Graph
        </button>
        <button
          className={viewMode === '3d' ? 'active' : ''}
          disabled={disabled}
          onClick={() => setViewMode('3d')}
          title="Show The Map In A Minecraft World, Using Its X/Y/Z Coordinates"
        >
          3D World
        </button>
      </div>

      <div className="toolbar-group">
        <button
          className={mode === 'add-location' ? 'active' : ''}
          disabled={disabled}
          onClick={() => setMode(mode === 'add-location' ? 'select' : 'add-location')}
          title={
            viewMode === '3d'
              ? 'Click A Block To Drop A New Location'
              : 'Click The Canvas To Drop A New Location'
          }
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
        <CheckField
          label="New Ephemeral"
          checked={defaults.ephemeral}
          onChange={(v) => setDefaults({ ephemeral: v })}
        />
        <CheckField
          label="New Locked"
          checked={defaults.locked}
          onChange={(v) => setDefaults({ locked: v })}
        />
      </div>

      {/* Arranging and fitting belong to the Cytoscape canvas; the 3D view has
          its own framing controls over the canvas itself. Removed rather than
          `hidden`, which `.toolbar-group { display: flex }` would override. */}
      {viewMode === '2d' && (
      <div className="toolbar-group">
        <label className="inline-label">
          Layout
          <select
            value={layout}
            disabled={disabled}
            onChange={(e) => setLayout(e.target.value as LayoutName)}
          >
            {LAYOUT_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((value) => (
                  <option key={value} value={value}>
                    {LAYOUT_LABELS[value]}
                  </option>
                ))}
              </optgroup>
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
      )}

      <div className="toolbar-group">
        <label className="inline-label">
          Labels
          <select value={labelMode} onChange={(e) => setLabelMode(e.target.value as LabelMode)}>
            <option value="names">Names</option>
            <option value="all">Names And Badges</option>
            <option value="none">None</option>
          </select>
        </label>
      </div>

      <div className="toolbar-group right">
        <button className="cog" title="Settings" onClick={openSettings} aria-label="Settings">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19.4 13a7.8 7.8 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-1.7-1l-.3-2.5h-4l-.3 2.5c-.6.2-1.2.6-1.7 1l-2.3-1-2 3.4L6.6 11a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.4 2.3-1c.5.4 1.1.8 1.7 1l.3 2.5h4l.3-2.5c.6-.2 1.2-.6 1.7-1l2.3 1 2-3.4-2-1.5ZM12 15.2A3.2 3.2 0 1 1 12 8.8a3.2 3.2 0 0 1 0 6.4Z"
            />
          </svg>
        </button>
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
