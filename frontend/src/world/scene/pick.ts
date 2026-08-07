/**
 * Turning a raycast hit into a block coordinate.
 *
 * Split out from the view because it is the one piece of picking that can be
 * wrong in a way nothing on screen makes obvious — a location placed one block
 * inside the wall you clicked looks fine until you fly round the other side.
 */

import type { Vector3 } from 'three';

/**
 * Nudge back along the ray before flooring, or a hit that lands exactly on a
 * block boundary — which is every hit, since these are axis-aligned cubes —
 * floors into the solid block instead of the air in front of it.
 */
const EPSILON = 0.01;

export interface BlockCoord {
  x: number;
  y: number;
  z: number;
}

/**
 * The empty block the ray passed through last, given where it stopped.
 *
 * Deliberately not derived from the face normal: the streamed chunk geometry
 * carries no normal attribute, and "the air I was looking through" is the
 * definition that matches what a player expects from placing a block anyway.
 */
export function blockInFrontOf(point: Vector3, direction: Vector3): BlockCoord {
  return {
    x: Math.floor(point.x - direction.x * EPSILON),
    y: Math.floor(point.y - direction.y * EPSILON),
    z: Math.floor(point.z - direction.z * EPSILON)
  };
}
