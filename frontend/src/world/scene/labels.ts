/**
 * Location names as HTML, positioned by CSS2DRenderer.
 *
 * HTML rather than sprites because these are the same names the 2D canvas
 * draws, and they should be selectable, legible at any distance and styled from
 * the same stylesheet. The cost is a DOM node per placed location, which is
 * fine at the scale a hand-built map reaches and would not be at world scale.
 *
 * Culling is by distance, done here rather than in CSS: an off-screen label
 * still costs a layout, and `visible = false` skips it entirely.
 */

import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export interface LabelDatum {
  id: string;
  text: string;
  color: string;
  x: number;
  y: number;
  z: number;
}

/** Blocks above the marker centre, so the label clears the octahedron. */
const LIFT = 1.1;

interface Entry {
  object: CSS2DObject;
  element: HTMLDivElement;
  dot: HTMLSpanElement;
  text: Text;
  colour: string;
  label: string;
}

export class LabelLayer {
  readonly group = new THREE.Group();

  private readonly entries = new Map<string, Entry>();
  private selected: string | null = null;

  constructor() {
    this.group.name = 'labels';
  }

  setData(list: LabelDatum[]) {
    const seen = new Set<string>();

    for (const datum of list) {
      seen.add(datum.id);
      let entry = this.entries.get(datum.id);
      if (!entry) {
        entry = this.create();
        this.entries.set(datum.id, entry);
        this.group.add(entry.object);
      }
      /* Touching textContent or style unconditionally would dirty the DOM on
         every drag frame for every label in the map. */
      if (entry.label !== datum.text) {
        entry.text.data = datum.text;
        entry.label = datum.text;
      }
      if (entry.colour !== datum.color) {
        entry.dot.style.background = datum.color;
        entry.colour = datum.color;
      }
      entry.object.position.set(datum.x + 0.5, datum.y + 0.5 + LIFT, datum.z + 0.5);
    }

    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      this.destroy(entry);
      this.entries.delete(id);
    }

    this.applySelection();
  }

  setSelected(id: string | null) {
    if (this.selected === id) return;
    this.selected = id;
    this.applySelection();
  }

  /**
   * Hide labels further than `maxDistance` blocks from the camera. A distance
   * of zero hides all of them, which is what the "no labels" mode wants.
   */
  cull(camera: THREE.Camera, maxDistance: number) {
    const limit = maxDistance * maxDistance;
    for (const entry of this.entries.values()) {
      entry.object.visible =
        maxDistance > 0 && entry.object.position.distanceToSquared(camera.position) <= limit;
    }
  }

  dispose() {
    for (const entry of this.entries.values()) this.destroy(entry);
    this.entries.clear();
  }

  /* ------------------------------------------------------------ internals */

  private create(): Entry {
    const element = document.createElement('div');
    element.className = 'world-label';
    const dot = document.createElement('span');
    dot.className = 'world-label-dot';
    const text = document.createTextNode('');
    element.append(dot, text);

    const object = new CSS2DObject(element);
    /* Anchored at its bottom edge so the label sits above the marker rather
       than on top of it. */
    object.center.set(0.5, 1);

    return { object, element, dot, text, colour: '', label: '' };
  }

  private destroy(entry: Entry) {
    this.group.remove(entry.object);
    entry.element.remove();
  }

  private applySelection() {
    for (const [id, entry] of this.entries) {
      entry.element.classList.toggle('selected', id === this.selected);
    }
  }
}
