/**
 * A handle on the mounted 3D view, for panels that need to move the camera.
 *
 * The sidebar's "jump to this location" and "fit the route" buttons were
 * written against Cytoscape, and in the 3D view they silently did nothing —
 * `cyHolder.cy` is null there, and every one of those helpers returns early.
 * This is the 3D counterpart, deliberately shaped the same way as `cyHolder`.
 *
 * It holds a plain callback record rather than the `WorldView` itself, and
 * imports nothing at all. That is what keeps `graph/cyHolder` — which is in the
 * main bundle — from reaching three.js through this file and undoing the code
 * split on the 3D canvas.
 */

export interface WorldFocusApi {
  /** Frame a single location. False if it has no coordinates to frame. */
  focusLocation(id: string): boolean;
  /** Frame every placed location in the list. False if none are placed. */
  fitToLocations(ids: string[]): boolean;
}

export const worldHolder: { view: WorldFocusApi | null } = { view: null };
