import { useEffect, useMemo, useRef } from 'react';
import { buildElements, groupNodeId } from '../graph/elements';
import { useGraphStore } from '../state/store';
import { pushEscapeHandler } from '../utils/escapeStack';
import GraphScrollbars from './GraphScrollbars';
import MenuPanel from './Menu';
import CoordinateGridLayer, { CoordinateGridRuler } from './canvas/CoordinateGridLayer';
import { useCanvasEvents } from './canvas/useCanvasEvents';
import { useCanvasSettings } from './canvas/useCanvasSettings';
import { useConnectGhost } from './canvas/useConnectGhost';
import { useContextMenu } from './canvas/useContextMenu';
import { useCytoscape } from './canvas/useCytoscape';
import { useDragModes } from './canvas/useDragModes';
import { useEdgeReconnect } from './canvas/useEdgeReconnect';
import { useElementSync } from './canvas/useElementSync';
import GroupShapeLayer from './canvas/GroupShapeLayer';
import { useGroupMemberDrag } from './canvas/useGroupMemberDrag';
import { useHighlight } from './canvas/useHighlight';
import { useLayoutRunner } from './canvas/useLayoutRunner';
import { useMarquee } from './canvas/useMarquee';
import { useMenuEntries } from './canvas/useMenuEntries';
import { usePortalFollow } from './canvas/usePortalFollow';
import { useSelectionSync } from './canvas/useSelectionSync';

/** Mounted with `key={mapId}` by App.tsx: a new map gets a renderer tuned to
 *  its own size, since `hideEdgesOnViewport`/`pixelRatio` can only be picked
 *  once, at Cytoscape construction. */
export default function GraphCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** Sits above the Cytoscape container, so it can intercept the wheel first. */
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const locations = useGraphStore((s) => s.locations);
  const connections = useGraphStore((s) => s.connections);
  const groups = useGraphStore((s) => s.groups);
  const locationLabels = useGraphStore((s) => s.locationLabels);
  const connectionLabels = useGraphStore((s) => s.connectionLabels);
  const pendingPositions = useGraphStore((s) => s.pendingPositions);
  const pendingPortalOffsets = useGraphStore((s) => s.pendingPortalOffsets);
  const selection = useGraphStore((s) => s.selection);
  const multiSelect = useGraphStore((s) => s.multiSelect);
  const labelMode = useGraphStore((s) => s.labelMode);
  const layout = useGraphStore((s) => s.layout);
  const layoutNonce = useGraphStore((s) => s.layoutNonce);
  const mode = useGraphStore((s) => s.mode);
  const pendingSource = useGraphStore((s) => s.pendingSource);
  const mapId = useGraphStore((s) => s.mapId);
  const settings = useGraphStore((s) => s.settings);
  const coordinateFrame = useGraphStore((s) => s.coordinateFrame);
  const routePlan = useGraphStore((s) => s.trip.plan);
  const waypoints = useGraphStore((s) => s.trip.waypoints);
  const pick = useGraphStore((s) => s.pick);
  const cancelPick = useGraphStore((s) => s.cancelPick);
  const requestPickSearch = useGraphStore((s) => s.requestPickSearch);

  const initialElementCount = useRef(
    Object.keys(useGraphStore.getState().locations).length +
      Object.keys(useGraphStore.getState().connections).length
  ).current;

  const handle = useCytoscape(containerRef, wrapperRef, initialElementCount);
  useCanvasSettings(handle, settings);

  /* above App's catch-all Escape, below any open menu: Esc disarms the picker
     without also tearing down the selection the picker was editing */
  const picking = !!pick;
  useEffect(() => {
    if (!picking) return;
    return pushEscapeHandler(() => useGraphStore.getState().cancelPick());
  }, [picking]);

  const labelNames = useMemo(
    () => ({
      locationLabelNames: Object.fromEntries(
        Object.values(locationLabels).map((l) => [l.id, l.name || 'Unnamed Label'])
      ),
      connectionLabelNames: Object.fromEntries(
        Object.values(connectionLabels).map((l) => [l.id, l.name || 'Unnamed Label'])
      )
    }),
    [locationLabels, connectionLabels]
  );

  const elements = useMemo(
    () =>
      buildElements(Object.values(locations), Object.values(connections), Object.values(groups), {
        labelMode,
        baseScale: settings.baseScale,
        ephemeralStyle: settings.ephemeralStyle,
        positionOverrides: pendingPositions,
        portalOffsetOverrides: pendingPortalOffsets,
        ...labelNames
      }),
    [
      locations,
      connections,
      groups,
      labelMode,
      settings.baseScale,
      settings.ephemeralStyle,
      pendingPositions,
      pendingPortalOffsets,
      labelNames
    ]
  );

  /* one switch for both halves: off, or nothing laid out on a lattice, means
     neither canvas ever subscribes to the render loop */
  const gridFrame = settings.showCoordinateGrid ? coordinateFrame : null;

  useElementSync(handle, elements, mapId);
  usePortalFollow(handle, elements);
  useCanvasEvents(handle);
  const marquee = useMarquee(handle);
  useConnectGhost(handle, mode, pendingSource);
  useEdgeReconnect(handle, selection, connections);
  useSelectionSync(handle, selection, multiSelect);
  useLayoutRunner(handle, layout, layoutNonce, mapId);
  useContextMenu(handle, containerRef);

  const pickedForDrag = useMemo(() => {
    const ids = new Set<string>(multiSelect);
    if (selection?.type === 'location') ids.add(selection.id);
    if (selection?.type === 'group') ids.add(groupNodeId(selection.id));
    return ids;
  }, [selection, multiSelect]);
  useDragModes(handle, settings.groupDrag, settings.locationDrag, pickedForDrag, elements);
  useGroupMemberDrag(handle);

  /** Selecting a label highlights everything carrying it. */
  const labelMembers = useMemo(() => {
    if (selection?.type === 'location-label') {
      return Object.values(locations)
        .filter((l) => l.labelIds.includes(selection.id))
        .map((l) => l.id);
    }
    if (selection?.type === 'connection-label') {
      return Object.values(connections)
        .filter((c) => c.labelIds.includes(selection.id))
        .map((c) => c.id);
    }
    return [];
  }, [selection, locations, connections]);

  useHighlight(handle, elements, selection, multiSelect, labelMembers, routePlan, waypoints, pick);

  const menuItems = useMenuEntries();
  const contextMenu = useGraphStore((s) => s.contextMenu);
  const closeMenu = useGraphStore((s) => s.closeContextMenu);

  return (
    <div
      ref={wrapperRef}
      className={`graph-canvas mode-${mode}${pick ? ' picking' : ''}`}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* behind the Cytoscape canvases, by DOM order — see GroupShapeLayer */}
      <CoordinateGridLayer handle={handle} frame={gridFrame} settings={settings} />
      <GroupShapeLayer handle={handle} />
      <div ref={containerRef} className="cy-host" />
      {/* …and the ruler above them, or a room at the edge would hide it */}
      <CoordinateGridRuler handle={handle} frame={gridFrame} settings={settings} />
      {handle && <GraphScrollbars />}
      {marquee && (
        <div
          className="marquee"
          style={{
            left: marquee.x1,
            top: marquee.y1,
            width: marquee.x2 - marquee.x1,
            height: marquee.y2 - marquee.y1
          }}
        />
      )}
      {pick && (
        <div className="canvas-hint picking-hint">
          <span>{pick.prompt}</span>
          <button className="hint-btn" onClick={requestPickSearch} title="Go back to the search box">
            🔍 Search Instead
          </button>
          <button className="hint-btn" onClick={cancelPick}>
            {pick.multi ? 'Done' : 'Cancel'} (Esc)
          </button>
        </div>
      )}
      {!pick && mode !== 'select' && (
        <div className="canvas-hint">
          {mode === 'add-location'
            ? 'Click Anywhere To Place A New Location (Esc To Cancel)'
            : pendingSource
              ? 'Drag To The Destination And Click It (Esc To Cancel)'
              : 'Click The Source Location (Esc To Cancel)'}
        </div>
      )}
      {multiSelect.length > 1 && (
        <div className="canvas-hint subtle">
          {multiSelect.length} Rooms Selected — Drag Any Of Them To Move Them Together
        </div>
      )}
      {contextMenu && (
        <MenuPanel x={contextMenu.x} y={contextMenu.y} items={menuItems} onClose={closeMenu} />
      )}
    </div>
  );
}
