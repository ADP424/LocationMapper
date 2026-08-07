import type { Core, ElementDefinition } from 'cytoscape';
import { isInternalId } from './elements';

const IMMUTABLE = new Set(['id', 'source', 'target', 'parent']);
/** Owned by runtime passes (stacking, view scale) — a reconcile must not reset
 *  them: `tView`/`minFontView`/`skel`/`lineView`/`edgeHidden` are the
 *  ViewScaler's own write set, `boxW`/`boxH` are the layering pass's measured
 *  group box, and `zLayer`/`groupFillOpacity`/`groupBorderOpacity` are the
 *  stacking pass's. */
const RUNTIME = new Set([
  'zLayer',
  'groupFillOpacity',
  'groupBorderOpacity',
  'boxW',
  'boxH',
  'tView',
  'minFontView',
  'skel',
  'lineView',
  'edgeHidden'
]);
const BASE_CLASSES = [
  'group',
  'location',
  'visited',
  'unvisited',
  'has-notes',
  'connection',
  'portal',
  'portal-out',
  'portal-in',
  'stub',
  'stub-out',
  'stub-in'
];

const skip = (k: string) => IMMUTABLE.has(k) || RUNTIME.has(k);

/** Element data is all primitives, so identity is the right comparison. */
function sameData(current: Record<string, unknown>, next: Record<string, unknown>) {
  for (const k in next) {
    if (skip(k)) continue;
    if (current[k] !== next[k]) return false;
  }
  return true;
}

function mutableData(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!skip(k)) out[k] = v;
  return out;
}

export interface ReconcileResult {
  /** Elements were added or removed, or an edge was re-pointed. */
  structural: boolean;
  /** At least one element's position was written — the drawn extent moved. */
  moved: boolean;
  /** Element ids whose geometry-bearing data changed — feed to `ViewScaler.markDirty`. */
  dirty: string[];
}

/**
 * Reconcile by *definition identity* first: the builder (`buildElements`) hands
 * back the very same object for every row it did not rebuild, so an untouched
 * element costs one `Map.get` and one `===`. Only rebuilt rows are diffed field
 * by field, and runtime-owned fields (view-scale twins, z-layers) are never
 * touched here at all — that is what makes reconciling a click on one room cost
 * one write instead of a restyle of the whole graph.
 */
export function reconcile(
  cy: Core,
  desired: ElementDefinition[],
  fullReset: boolean,
  fallbackPosition: { x: number; y: number }
): ReconcileResult {
  const withFallback = (el: ElementDefinition) =>
    el.data?.source || el.position || el.data?.kind === 'group'
      ? el
      : { ...el, position: { ...fallbackPosition } };

  if (fullReset) {
    cy.elements().remove();
    cy.add(desired.map((el) => ({ ...withFallback(el), data: { ...withFallback(el).data } })));
    return { structural: true, moved: true, dirty: [] };
  }

  const result: ReconcileResult = { structural: false, moved: false, dirty: [] };
  cy.batch(() => {
    const wanted = new Map<string, ElementDefinition>();
    for (const el of desired) wanted.set(String(el.data!.id), el);

    const stale = cy.elements().filter((el) => !isInternalId(el.id()) && !wanted.has(el.id()));
    if (stale.nonempty()) {
      cy.remove(stale);
      result.structural = true;
    }

    const toAdd: ElementDefinition[] = [];
    wanted.forEach((el, id) => {
      const existing = cy.getElementById(id);
      if (existing.empty()) {
        const withPos = withFallback(el);
        toAdd.push({ ...withPos, data: { ...withPos.data } });
        result.structural = true;
        return;
      }

      /* Cytoscape cannot re-point an existing edge: rebuild it instead */
      if (existing.isEdge()) {
        const d = el.data as any;
        if (existing.source().id() !== d.source || existing.target().id() !== d.target) {
          cy.remove(existing);
          toAdd.push({ ...el, data: { ...el.data } });
          result.structural = true;
          return;
        }
      }

      const previousParent = existing.isNode()
        ? ((existing.parent().first().id() as string | undefined) ?? undefined)
        : undefined;

      /* a write that changes nothing still restyles the element: on a big map
         that is the difference between editing one room and restyling the lot */
      const next = el.data as Record<string, unknown>;
      if (!sameData(existing.data(), next)) {
        existing.data(mutableData(next));
        if (
          'w' in next ||
          'h' in next ||
          'lw' in next ||
          'lh' in next ||
          'spanW' in next ||
          'spanH' in next ||
          'labelWidth' in next ||
          'size' in next
        ) {
          result.dirty.push(id);
        }
      }

      const wantedClasses = new Set(
        (typeof el.classes === 'string' ? el.classes : '').split(' ').filter(Boolean)
      );
      for (const cls of BASE_CLASSES) {
        const want = wantedClasses.has(cls);
        if (existing.hasClass(cls) === want) continue;
        if (want) existing.addClass(cls);
        else existing.removeClass(cls);
      }

      /* locations, ephemeral stubs AND sub-groupings all follow data.parent so
         that nesting (including grouping-inside-grouping) stays in sync */
      if (
        existing.isNode() &&
        !existing.grabbed() &&
        !existing.hasClass('ghost') &&
        !existing.hasClass('handle')
      ) {
        const nextParent = (el.data as any).parent as string | undefined;
        if (previousParent !== nextParent) {
          existing.move({ parent: nextParent ?? null });
          result.structural = true;
        }
      }
      if (existing.isNode() && el.position && !existing.grabbed()) {
        const p = existing.position();
        if (Math.abs(p.x - el.position.x) > 0.5 || Math.abs(p.y - el.position.y) > 0.5) {
          existing.position(el.position);
          result.moved = true;
        }
      }
    });
    if (toAdd.length) {
      cy.add(toAdd);
      result.structural = true;
    }
  });
  return result;
}
