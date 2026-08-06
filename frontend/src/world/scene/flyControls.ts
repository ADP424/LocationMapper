/**
 * First-person fly camera: WASD to move, mouse to look, pointer locked.
 *
 * Orbiting works for inspecting a loaded area from outside, but this world is
 * mostly interior — an enclosed maze reads as a solid block from any orbit
 * distance, and the only way to see inside it is to be inside it. So both
 * cameras exist and share the same three.js camera object: switching hands the
 * camera over, it does not teleport.
 *
 * Movement is a noclip fly, not a walk. There is no collision because there is
 * no player: the point is to get anywhere quickly, including through a wall you
 * are trying to see the other side of.
 */

import type { PerspectiveCamera } from 'three';
import { Euler, Vector3 } from 'three';

/** Blocks per second at a standing walk, before any modifier. */
const BASE_SPEED = 22;
const SPRINT = 4;

/** Radians per pixel of mouse movement. Matches the usual FPS default. */
const SENSITIVITY = 0.0022;

/** Just short of straight up/down, so the view never flips over the pole. */
const MAX_PITCH = Math.PI / 2 - 0.001;

/** Seconds to reach ~63% of the target velocity. Zero would be twitchy. */
const SMOOTHING = 0.08;

/**
 * Movement keys.
 *
 * Deliberately no Ctrl and no Alt anywhere in this map, and it is worth saying
 * why: Minecraft sprints on Ctrl, and copying that here made *sprinting
 * forward* — Ctrl held, W pressed — the browser's close-tab chord. A page
 * cannot cancel that; `preventDefault` does not apply to browser-reserved
 * shortcuts, so the tab simply vanishes mid-flight and looks for all the world
 * like a crash. Sprint is on Shift, the web convention, and descent moved to C.
 * Alt is avoided too, since a bare Alt press focuses the Windows menu bar.
 */
const KEY_AXES: Record<string, [number, number, number]> = {
  KeyW: [0, 0, -1],
  KeyS: [0, 0, 1],
  KeyA: [-1, 0, 0],
  KeyD: [1, 0, 0],
  Space: [0, 1, 0],
  KeyC: [0, -1, 0],
  KeyQ: [0, -1, 0],
  ArrowUp: [0, 0, -1],
  ArrowDown: [0, 0, 1],
  ArrowLeft: [-1, 0, 0],
  ArrowRight: [1, 0, 0]
};

/** Held to sprint. Never Ctrl — see the note on KEY_AXES. */
const SPRINT_KEYS = ['ShiftLeft', 'ShiftRight'];

export interface FlyOptions {
  /** Called when pointer lock is gained or lost, including via Escape. */
  onActiveChange?: (active: boolean) => void;
}

export class FlyControls {
  private readonly held = new Set<string>();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly velocity = new Vector3();
  private readonly wish = new Vector3();
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private disposed = false;

  active = false;
  /** Multiplier on top of the base speed, so the UI can offer a range. */
  speedScale = 1;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly element: HTMLElement,
    private readonly options: FlyOptions = {}
  ) {
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    /* A window that loses focus mid-strafe would otherwise keep the key held
       forever, and the camera drifts off on its own. */
    window.addEventListener('blur', this.releaseAll);
  }

  /** Ask for pointer lock. The browser only grants it from a user gesture. */
  enter() {
    if (this.active) return;
    this.euler.setFromQuaternion(this.camera.quaternion);
    void this.element.requestPointerLock();
  }

  exit() {
    if (document.pointerLockElement === this.element) document.exitPointerLock();
  }

  dispose() {
    this.disposed = true;
    this.exit();
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.releaseAll);
  }

  /** Advance by `dt` seconds. Returns true if the camera actually moved. */
  update(dt: number): boolean {
    if (!this.active) {
      this.velocity.set(0, 0, 0);
      return false;
    }

    /* Camera-relative axes with the vertical component of forward kept: this is
       a fly camera, so looking down and pressing W should descend.

       Right comes from the yaw directly rather than from `forward x up`, which
       degenerates to a zero-length vector when looking straight up or down. */
    this.camera.getWorldDirection(this.forward);
    this.right.set(Math.cos(this.euler.y), 0, -Math.sin(this.euler.y));

    this.wish.set(0, 0, 0);
    for (const code of this.held) {
      const axis = KEY_AXES[code];
      if (!axis) continue;
      this.wish.addScaledVector(this.right, axis[0]);
      this.wish.addScaledVector(this.camera.up, axis[1]);
      this.wish.addScaledVector(this.forward, -axis[2]);
    }

    let speed = BASE_SPEED * this.speedScale;
    if (SPRINT_KEYS.some((k) => this.held.has(k))) speed *= SPRINT;

    if (this.wish.lengthSq() > 0) this.wish.normalize().multiplyScalar(speed);

    /* Exponential approach, framerate-independent: the same easing whether the
       tab is running at 60 or 144 fps. */
    const blend = 1 - Math.exp(-dt / SMOOTHING);
    this.velocity.lerp(this.wish, blend);

    if (this.velocity.lengthSq() < 1e-6) return false;
    this.camera.position.addScaledVector(this.velocity, dt);
    return true;
  }

  private readonly onLockChange = () => {
    if (this.disposed) return;
    this.active = document.pointerLockElement === this.element;
    if (!this.active) this.releaseAll();
    this.options.onActiveChange?.(this.active);
  };

  private readonly onMouseMove = (e: MouseEvent) => {
    if (!this.active) return;
    this.euler.y -= e.movementX * SENSITIVITY;
    this.euler.x -= e.movementY * SENSITIVITY;
    this.euler.x = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.euler.x));
    this.camera.quaternion.setFromEuler(this.euler);
  };

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.active) return;
    /* Space would scroll the page; while locked the camera owns it. Nothing
       here can defend against a browser-reserved chord, which is why the key
       map avoids forming one at all. */
    if (KEY_AXES[e.code]) e.preventDefault();
    this.held.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.held.delete(e.code);
  };

  private readonly releaseAll = () => {
    this.held.clear();
    this.velocity.set(0, 0, 0);
  };
}
