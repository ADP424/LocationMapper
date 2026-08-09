/**
 * How fast the camera moves along a planned route.
 *
 * Split out of `worldView` because it is arithmetic with no scene in it: the
 * headless checks can import this without pulling three.js in, and the one
 * property that matters — that the user's weight scales the whole journey
 * rather than reshaping it — is then something a test can state directly.
 */

import { TOUR_SPEED_BASE } from '../worldPrefs';

/** Fraction of the route spent easing in and out of the cruise speed. */
export const TOUR_EASE = 0.06;
/** Speed floor, so the ends drift rather than stall. */
export const TOUR_MIN_RATE = 0.15;

const smoothstep = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * The ease ramp at a point along the route, in [TOUR_MIN_RATE, 1].
 *
 * Deliberately independent of the weight: the ramp is the shape of the
 * journey, and the weight is how fast that shape is played.
 */
export function tourRate(u: number): number {
  return (
    TOUR_MIN_RATE +
    (1 - TOUR_MIN_RATE) * smoothstep(u / TOUR_EASE) * smoothstep((1 - u) / TOUR_EASE)
  );
}

/**
 * How far along the curve to advance this frame, as a fraction of its length.
 *
 * Progress is in arc length, so `speed * dt / length` is genuinely constant
 * ground speed regardless of how the stops are spaced.
 */
export function tourStep(u: number, dt: number, length: number, weight = 1): number {
  return ((TOUR_SPEED_BASE * weight * dt) / Math.max(length, 1)) * tourRate(u);
}
