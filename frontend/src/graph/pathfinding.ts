/**
 * Trip planning: shortest walk visiting waypoints in order, where visiting a
 * room can unlock gated connections. Pure + async (it yields periodically) so
 * the same code runs in a Web Worker or, as a fallback, on the main thread.
 */

import {
  isPermanentlySealed,
  traversalDirections,
  unmetRequirements
} from './connectionRules';

export type RouteMode = 'stops' | 'weight' | 'coords';

export interface AxisToggles {
  x: boolean;
  y: boolean;
  z: boolean;
}

export interface RouteOptions {
  mode: RouteMode;
  axes: AxisToggles;
}

export interface RouteStep {
  connectionId: string;
  fromId: string;
  toId: string;
  weight: number;
  coordChange: number;
  locked?: boolean;
  prerequisites?: string[];
  unlocks?: string[];
}

export interface DetourPickup {
  locationId: string;
  opens: string[];
}

export interface RouteLeg {
  fromId: string;
  toId: string;
  found: boolean;
  steps: RouteStep[];
  hops: number;
  weight: number;
  coordChange: number;
  detours: DetourPickup[];
}

export type RouteOutcome =
  /** searched exhaustively — this is the best route that exists */
  | 'optimal'
  /** a valid route, but the search was stopped before it could prove optimality */
  | 'suboptimal'
  /** proven: no route exists under the current directions, locks and visits */
  | 'impossible'
  /** stopped early with nothing found yet (should be rare) */
  | 'incomplete'
  | 'empty';

export type StopReason = 'time' | 'states' | 'cancelled';

export interface RoutePlan {
  mode: RouteMode;
  outcome: RouteOutcome;
  stopReason: StopReason | null;
  legs: RouteLeg[];
  ok: boolean;
  hops: number;
  weight: number;
  coordChange: number;
  locationIds: string[];
  connectionIds: string[];
  detourIds: string[];
  impossibleLeg: number | null;
  statesExplored: number;
  elapsedMs: number;
  keysRelevant: number;
  keysPruned: number;
}

/* ------------------------------------------------ worker-friendly inputs */
export interface PlannerLocation {
  id: string;
  visited: boolean;
  coordX: number | null;
  coordY: number | null;
  coordZ: number | null;
}

export interface PlannerConnection {
  id: string;
  sourceId: string;
  targetId: string;
  arrowSource: boolean;
  arrowTarget: boolean;
  weight: number;
  locked: boolean;
  requires: string[];
}

export interface PlannerBudget {
  /** Hard ceiling so a pathological map can never exhaust memory. */
  maxStates: number;
  /** Optional wall-clock budget in ms; null = run until exhausted. */
  maxMs: number | null;
}

export interface PlannerInput {
  locations: PlannerLocation[];
  connections: PlannerConnection[];
  waypoints: string[];
  options: RouteOptions;
  budget: PlannerBudget;
}

export interface PlannerHooks {
  onProgress?: (states: number, elapsedMs: number) => void;
  shouldStop?: () => boolean;
  /** expansions between event-loop yields */
  chunk?: number;
}

/** ~80 bytes of bookkeeping per state, so this caps the search near 350 MB. */
export const MAX_PLANNER_STATES = 4_000_000;
export const AUTO_PLAN_LIMIT_MS = 500;

export const ROUTE_MODE_LABELS: Record<RouteMode, string> = {
  stops: 'Fewest Stops',
  weight: 'Lowest Total Weight',
  coords: 'Least Coordinate Change'
};

const UNKNOWN_AXIS_COST = 1;
const HOP_EPSILON = 0.001;
const PROGRESS_EVERY_MS = 200;

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const yieldTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const axisDelta = (a: number | null, b: number | null) =>
  a === null || a === undefined || b === null || b === undefined
    ? UNKNOWN_AXIS_COST
    : Math.abs(a - b);

function coordChangeBetween(a: PlannerLocation, b: PlannerLocation, axes: AxisToggles) {
  let total = 0;
  if (axes.x) total += axisDelta(a.coordX, b.coordX);
  if (axes.y) total += axisDelta(a.coordY, b.coordY);
  if (axes.z) total += axisDelta(a.coordZ, b.coordZ);
  return total;
}

/* --------------------------------------------------- numeric binary heap */
class MinHeap {
  private keys: number[] = [];
  private values: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, value: number) {
    this.keys.push(key);
    this.values.push(value);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }
  pop(): number {
    const top = this.values[0];
    const lastKey = this.keys.pop()!;
    const lastValue = this.values.pop()!;
    if (this.keys.length) {
      this.keys[0] = lastKey;
      this.values[0] = lastValue;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < this.keys.length && this.keys[l] < this.keys[best]) best = l;
        if (r < this.keys.length && this.keys[r] < this.keys[best]) best = r;
        if (best === i) break;
        this.swap(best, i);
        i = best;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const v = this.values[a];
    this.values[a] = this.values[b];
    this.values[b] = v;
  }
}

function emptyPlan(mode: RouteMode, outcome: RouteOutcome): RoutePlan {
  return {
    mode,
    outcome,
    stopReason: null,
    legs: [],
    ok: false,
    hops: 0,
    weight: 0,
    coordChange: 0,
    locationIds: [],
    connectionIds: [],
    detourIds: [],
    impossibleLeg: null,
    statesExplored: 0,
    elapsedMs: 0,
    keysRelevant: 0,
    keysPruned: 0
  };
}

export async function planRoute(
  input: PlannerInput,
  hooks: PlannerHooks = {}
): Promise<RoutePlan> {
  const t0 = nowMs();
  const { locations, connections, waypoints, options, budget } = input;
  const mode = options.mode;
  const chunk = hooks.chunk ?? 25_000;
  const axes =
    options.axes.x || options.axes.y || options.axes.z
      ? options.axes
      : { x: true, y: true, z: true };

  if (waypoints.length < 2) return emptyPlan(mode, 'empty');

  /* ---------------------------------------------------------- indexing */
  const index = new Map<string, number>();
  locations.forEach((l, i) => index.set(l.id, i));
  const n = locations.length;

  const wpIdx: number[] = [];
  for (const id of waypoints) {
    const i = index.get(id);
    if (i === undefined) {
      const plan = emptyPlan(mode, 'impossible');
      plan.elapsedMs = nowMs() - t0;
      return plan;
    }
    wpIdx.push(i);
  }
  const mFull = wpIdx.length;

  /* -------------------------------------------- arcs + per-door needs */
  const connNeeds: number[][] = [];
  const arcFrom: number[] = [];
  const arcTo: number[] = [];
  const arcConn: number[] = [];
  const arcWeight: number[] = [];
  const arcCoord: number[] = [];
  const arcCost: number[] = [];
  const outArcs: number[][] = Array.from({ length: n }, () => []);
  const inArcs: number[][] = Array.from({ length: n }, () => []);

  const pushArc = (from: number, to: number, ci: number, w: number, cc: number, cost: number) => {
    const ai = arcFrom.length;
    arcFrom.push(from);
    arcTo.push(to);
    arcConn.push(ci);
    arcWeight.push(w);
    arcCoord.push(cc);
    arcCost.push(cost);
    outArcs[from].push(ai);
    inArcs[to].push(ai);
  };

  const visitedIds = new Set(locations.filter((l) => l.visited).map((l) => l.id));

  connections.forEach((c, ci) => {
    const needs: number[] = [];
    let sealed = isPermanentlySealed(c);
    for (const r of unmetRequirements(c, visitedIds)) {
      const ri = index.get(r);
      if (ri === undefined) {
        sealed = true; // requirement room is gone
        break;
      }
      if (!needs.includes(ri)) needs.push(ri);
    }
    connNeeds[ci] = needs;
    if (sealed) return;

    const s = index.get(c.sourceId);
    const t = index.get(c.targetId);
    if (s === undefined || t === undefined || s === t) return;
    const dirs = traversalDirections(c); // no arrowheads = walkable both ways
    if (!dirs.forward && !dirs.backward) return;

    const weight = Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 1;
    const coord = coordChangeBetween(locations[s], locations[t], axes);
    const cost = mode === 'weight' ? weight : mode === 'coords' ? coord + HOP_EPSILON : 1;
    if (dirs.forward) pushArc(s, t, ci, weight, coord, cost);
    if (dirs.backward) pushArc(t, s, ci, weight, coord, cost);
  });

  const arcCount = arcFrom.length;

  /* ---------------------------------------------------------------------
   * Relevance pruning, rule 1: optimistic closure from the trip start.
   * A room that cannot be visited even when every openable door is open can
   * never be collected, so every door needing it is impassable for good.
   * ------------------------------------------------------------------- */
  const unmet = connNeeds.map((needs) => needs.length);
  const gatedBy = new Map<number, number[]>();
  connNeeds.forEach((needs, ci) =>
    needs.forEach((r) => {
      const list = gatedBy.get(r);
      if (list) list.push(ci);
      else gatedBy.set(r, [ci]);
    })
  );

  const reachable = new Uint8Array(n);
  const deferred = new Map<number, number[]>();
  const pending: number[] = [wpIdx[0]];
  while (pending.length) {
    const node = pending.pop()!;
    if (reachable[node]) continue;
    reachable[node] = 1;
    for (const ci of gatedBy.get(node) ?? []) {
      if (unmet[ci] > 0 && --unmet[ci] === 0) {
        const waitingArcs = deferred.get(ci);
        if (waitingArcs) {
          deferred.delete(ci);
          for (const ai of waitingArcs) pending.push(arcTo[ai]);
        }
      }
    }
    for (const ai of outArcs[node]) {
      const ci = arcConn[ai];
      if (unmet[ci] === 0) pending.push(arcTo[ai]);
      else {
        const list = deferred.get(ci);
        if (list) list.push(ai);
        else deferred.set(ci, [ai]);
      }
    }
  }
  /* unmet[ci] === 0 now means "every prerequisite of this door is collectable" */
  const openable = (ci: number) => unmet[ci] === 0;

  /* ---------------------------------------------------------------------
   * Rule 2: a door can only ever be walked if it sits on some walk from one
   * waypoint to the next — including detours, since a detour *is* such a walk.
   * So `from` must be forward-reachable from w_i and `to` must be able to
   * reach w_(i+1), both measured optimistically.
   * ------------------------------------------------------------------- */
  const forwardFrom = (start: number) => {
    const seen = new Uint8Array(n);
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const v = stack.pop()!;
      for (const ai of outArcs[v]) {
        if (!openable(arcConn[ai])) continue;
        const to = arcTo[ai];
        if (!seen[to]) {
          seen[to] = 1;
          stack.push(to);
        }
      }
    }
    return seen;
  };
  const backwardTo = (goal: number) => {
    const seen = new Uint8Array(n);
    const stack = [goal];
    seen[goal] = 1;
    while (stack.length) {
      const v = stack.pop()!;
      for (const ai of inArcs[v]) {
        if (!openable(arcConn[ai])) continue;
        const from = arcFrom[ai];
        if (!seen[from]) {
          seen[from] = 1;
          stack.push(from);
        }
      }
    }
    return seen;
  };

  const legFwd: Uint8Array[] = [];
  const legBwd: Uint8Array[] = [];
  for (let i = 0; i + 1 < mFull; i++) {
    legFwd[i] = forwardFrom(wpIdx[i]);
    legBwd[i] = backwardTo(wpIdx[i + 1]);
  }

  /* fast, sound impossibility proof: the next stop isn't even optimistically
     reachable, so search only the feasible prefix */
  let closureImpossibleLeg: number | null = null;
  for (let i = 0; i + 1 < mFull; i++) {
    if (!legFwd[i][wpIdx[i + 1]]) {
      closureImpossibleLeg = i;
      break;
    }
  }

  const relevantConn = new Uint8Array(connections.length);
  for (let ai = 0; ai < arcCount; ai++) {
    const ci = arcConn[ai];
    if (relevantConn[ci] || !openable(ci)) continue;
    for (let i = 0; i + 1 < mFull; i++) {
      if (legFwd[i][arcFrom[ai]] && legBwd[i][arcTo[ai]]) {
        relevantConn[ci] = 1;
        break;
      }
    }
  }

  const searchOut: number[][] = Array.from({ length: n }, () => []);
  for (let ai = 0; ai < arcCount; ai++) {
    const ci = arcConn[ai];
    if (openable(ci) && relevantConn[ci]) searchOut[arcFrom[ai]].push(ai);
  }

  /* rule 3 (doors whose prerequisites are already visited) is implicit:
     `connNeeds` only lists rooms that are still unvisited */
  const allKeys = new Set<number>();
  connNeeds.forEach((needs) => needs.forEach((r) => allKeys.add(r)));
  const keyBit = new Map<number, number>();
  connections.forEach((_c, ci) => {
    if (!openable(ci) || !relevantConn[ci]) return;
    for (const r of connNeeds[ci]) if (!keyBit.has(r)) keyBit.set(r, keyBit.size);
  });
  const keyCount = keyBit.size;
  const words = Math.max(1, Math.ceil(keyCount / 32));

  /* ------------------------------------------- interned key-set bitsets */
  const maskStore: Uint32Array[] = [];
  const maskIds = new Map<string, number>();
  const internMask = (bits: Uint32Array) => {
    const key = bits.join(',');
    let id = maskIds.get(key);
    if (id === undefined) {
      id = maskStore.length;
      maskStore.push(bits);
      maskIds.set(key, id);
    }
    return id;
  };
  const EMPTY_MASK = internMask(new Uint32Array(words));
  const withBitCache = new Map<string, number>();
  const maskWithNode = (maskId: number, node: number) => {
    const bit = keyBit.get(node);
    if (bit === undefined) return maskId;
    const word = bit >>> 5;
    const flag = 1 << (bit & 31);
    if ((maskStore[maskId][word] & flag) !== 0) return maskId;
    const cacheKey = `${maskId}:${bit}`;
    const hit = withBitCache.get(cacheKey);
    if (hit !== undefined) return hit;
    const next = Uint32Array.from(maskStore[maskId]);
    next[word] |= flag;
    const id = internMask(next);
    withBitCache.set(cacheKey, id);
    return id;
  };
  /** a ⊇ b */
  const containsAll = (a: number, b: number) => {
    if (a === b || b === EMPTY_MASK) return true;
    const x = maskStore[a];
    const y = maskStore[b];
    for (let i = 0; i < words; i++) if ((x[i] & y[i]) !== y[i]) return false;
    return true;
  };

  const arcRequired = new Int32Array(arcCount).fill(EMPTY_MASK);
  for (let ai = 0; ai < arcCount; ai++) {
    const needs = connNeeds[arcConn[ai]];
    if (!needs.length) continue;
    let maskId = EMPTY_MASK;
    for (const r of needs) maskId = maskWithNode(maskId, r);
    arcRequired[ai] = maskId;
  }

  /* --------------------------------------------------------- the search */
  const searchWp = closureImpossibleLeg === null ? wpIdx : wpIdx.slice(0, closureImpossibleLeg + 1);
  const mSearch = searchWp.length;
  const advance = (node: number, idx: number) => {
    while (idx < mSearch && node === searchWp[idx]) idx++;
    return idx;
  };

  const stNode: number[] = [];
  const stMask: number[] = [];
  const stIdx: number[] = [];
  const stCost: number[] = [];
  const stPrev: number[] = [];
  const stArc: number[] = [];
  const stDead: boolean[] = [];
  const stSettled: boolean[] = [];
  const frontier = new Map<number, number[]>();

  let bestGoal = -1;
  let bestPartial = -1;

  /**
   * Dominance is safe for both modes:
   *  • extra keys never forbid an arc and costs are key-independent, so
   *    (mask ⊇ mask′, cost ≤ cost′) really does dominate;
   *  • in BFS, states are created in non-decreasing cost order, so a newcomer
   *    can only kill an already-expanded state at *equal* cost, and it is itself
   *    queued — nothing optimal is lost;
   *  • a goal state can only be pruned by another goal state at ≤ cost, which
   *    was created earlier and already ended the search.
   * `stDead` states stay in the arrays because `stPrev` chains through them for
   * reconstruction; they are merely skipped when popped.
   */
  const addState = (node: number, maskId: number, idx: number, cost: number, prev: number, arc: number) => {
    /* idx ∈ [1, mSearch], so the stride must be mSearch + 1 to stay collision-free */
    const pos = node * (mSearch + 1) + idx;
    let list = frontier.get(pos);
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const sid = list[i];
        if (stDead[sid]) continue;
        if (stCost[sid] <= cost && containsAll(stMask[sid], maskId)) return -1;
      }
      for (let i = list.length - 1; i >= 0; i--) {
        const sid = list[i];
        if (stDead[sid]) {
          list.splice(i, 1);
          continue;
        }
        if (cost <= stCost[sid] && containsAll(maskId, stMask[sid])) {
          stDead[sid] = true;
          list.splice(i, 1);
        }
      }
    } else {
      list = [];
      frontier.set(pos, list);
    }

    const id = stNode.length;
    stNode.push(node);
    stMask.push(maskId);
    stIdx.push(idx);
    stCost.push(cost);
    stPrev.push(prev);
    stArc.push(arc);
    stDead.push(false);
    stSettled.push(false);
    list.push(id);

    if (idx === mSearch && (bestGoal < 0 || cost < stCost[bestGoal])) bestGoal = id;
    if (bestPartial < 0 || idx > stIdx[bestPartial] || (idx === stIdx[bestPartial] && cost < stCost[bestPartial])) {
      bestPartial = id;
    }
    return id;
  };

  let aborted = false;
  let stopReason: StopReason | null = null;
  let goalState = -1;
  let expansions = 0;
  let lastProgress = t0;

  const checkBudget = async () => {
    const elapsed = nowMs() - t0;
    if (hooks.shouldStop?.()) {
      aborted = true;
      stopReason = 'cancelled';
      return false;
    }
    if (budget.maxMs !== null && elapsed >= budget.maxMs) {
      aborted = true;
      stopReason = 'time';
      return false;
    }
    if (stNode.length >= budget.maxStates) {
      aborted = true;
      stopReason = 'states';
      return false;
    }
    if (hooks.onProgress && nowMs() - lastProgress >= PROGRESS_EVERY_MS) {
      lastProgress = nowMs();
      hooks.onProgress(stNode.length, elapsed);
    }
    await yieldTick();
    return true;
  };

  const startNode = searchWp[0];
  const startId = addState(startNode, maskWithNode(EMPTY_MASK, startNode), advance(startNode, 1), 0, -1, -1);
  if (stIdx[startId] === mSearch) goalState = startId;

  if (goalState < 0) {
    if (mode === 'stops') {
      /* uniform hop cost: breadth-first, so the first goal created is optimal */
      const queue = [startId];
      let head = 0;
      outer: while (head < queue.length) {
        if (++expansions % chunk === 0 && !(await checkBudget())) break;
        const id = queue[head++];
        if (stDead[id]) continue;
        const node = stNode[id];
        const maskId = stMask[id];
        const idx = stIdx[id];
        const cost = stCost[id];
        for (const ai of searchOut[node]) {
          if (!containsAll(maskId, arcRequired[ai])) continue;
          const to = arcTo[ai];
          const nid = addState(to, maskWithNode(maskId, to), advance(to, idx), cost + 1, id, ai);
          if (nid < 0) continue;
          if (stIdx[nid] === mSearch) {
            goalState = nid;
            break outer;
          }
          queue.push(nid);
        }
      }
    } else {
      const heap = new MinHeap();
      heap.push(0, startId);
      while (heap.size) {
        if (++expansions % chunk === 0 && !(await checkBudget())) break;
        const id = heap.pop();
        if (stDead[id] || stSettled[id]) continue;
        stSettled[id] = true;
        const idx = stIdx[id];
        if (idx === mSearch) {
          goalState = id;
          break;
        }
        const node = stNode[id];
        const maskId = stMask[id];
        const cost = stCost[id];
        for (const ai of searchOut[node]) {
          if (!containsAll(maskId, arcRequired[ai])) continue;
          const to = arcTo[ai];
          const nid = addState(to, maskWithNode(maskId, to), advance(to, idx), cost + arcCost[ai], id, ai);
          if (nid >= 0) heap.push(stCost[nid], nid);
        }
      }
    }
  }

  /* ------------------------------------------------------- reconstruct */
  const finalState = goalState >= 0 ? goalState : bestGoal >= 0 ? bestGoal : bestPartial;
  const steps: RouteStep[] = [];
  for (let id = finalState; id >= 0 && stPrev[id] >= 0; id = stPrev[id]) {
    const ai = stArc[id];
    steps.push({
      connectionId: connections[arcConn[ai]].id,
      fromId: locations[arcFrom[ai]].id,
      toId: locations[arcTo[ai]].id,
      weight: arcWeight[ai],
      coordChange: arcCoord[ai]
    });
  }
  steps.reverse();

  /* ------------------------------------- annotate gates and key pickups */
  const startVisited = new Set(locations.filter((l) => l.visited).map((l) => l.id));
  const byId = new Map(connections.map((c) => [c.id, c]));
  const firstVisit = new Map<string, number>();
  steps.forEach((s, i) => {
    if (!firstVisit.has(s.toId)) firstVisit.set(s.toId, i);
  });
  steps.forEach((s) => {
    const c = byId.get(s.connectionId);
    if (!c || !c.locked) return;
    const gating = c.requires.filter((r) => !startVisited.has(r));
    if (!gating.length) return;
    s.locked = true;
    s.prerequisites = gating;
    for (const r of gating) {
      if (r === waypoints[0]) continue;
      const vi = firstVisit.get(r);
      if (vi === undefined) continue;
      const pickup = steps[vi];
      if (!pickup.unlocks) pickup.unlocks = [];
      if (!pickup.unlocks.includes(s.connectionId)) pickup.unlocks.push(s.connectionId);
    }
  });

  /* --------------------------------------- split into the ordered legs */
  const makeLeg = (fromId: string, toId: string, legSteps: RouteStep[]): RouteLeg => ({
    fromId,
    toId,
    found: true,
    steps: legSteps,
    hops: legSteps.length,
    weight: legSteps.reduce((a, s) => a + s.weight, 0),
    coordChange: legSteps.reduce((a, s) => a + s.coordChange, 0),
    detours: legSteps
      .filter((s) => s.unlocks && s.unlocks.length)
      .map((s) => ({ locationId: s.toId, opens: s.unlocks! }))
  });

  const nodeSeq = [waypoints[0], ...steps.map((s) => s.toId)];
  const legs: RouteLeg[] = [];
  let idx = 1;
  let legStart = 0;
  for (let p = 0; p < nodeSeq.length && idx < mFull; p++) {
    while (idx < mFull && nodeSeq[p] === waypoints[idx]) {
      legs.push(makeLeg(waypoints[idx - 1], waypoints[idx], steps.slice(legStart, p)));
      legStart = p;
      idx++;
    }
  }
  while (idx < mFull) {
    legs.push({
      fromId: waypoints[idx - 1],
      toId: waypoints[idx],
      found: false,
      steps: [],
      hops: 0,
      weight: 0,
      coordChange: 0,
      detours: []
    });
    idx++;
  }

  /* ----------------------------------------------------------- outcome */
  let outcome: RouteOutcome;
  if (closureImpossibleLeg !== null) outcome = 'impossible';
  else if (goalState >= 0) outcome = 'optimal';
  else if (aborted) outcome = bestGoal >= 0 ? 'suboptimal' : 'incomplete';
  else outcome = 'impossible';

  const seenLoc = new Set<string>();
  const seenConn = new Set<string>();
  const locationIds: string[] = [];
  const connectionIds: string[] = [];
  const detourIds: string[] = [];
  const addLoc = (id: string) => {
    if (index.has(id) && !seenLoc.has(id)) {
      seenLoc.add(id);
      locationIds.push(id);
    }
  };
  waypoints.forEach(addLoc);
  for (const s of steps) {
    addLoc(s.toId);
    if (!seenConn.has(s.connectionId)) {
      seenConn.add(s.connectionId);
      connectionIds.push(s.connectionId);
    }
  }
  for (const leg of legs) {
    for (const d of leg.detours) {
      if (!detourIds.includes(d.locationId)) detourIds.push(d.locationId);
    }
  }

  return {
    mode,
    outcome,
    stopReason,
    legs,
    ok: outcome === 'optimal' || outcome === 'suboptimal',
    hops: legs.reduce((a, l) => a + l.hops, 0),
    weight: legs.reduce((a, l) => a + l.weight, 0),
    coordChange: legs.reduce((a, l) => a + l.coordChange, 0),
    locationIds,
    connectionIds,
    detourIds,
    impossibleLeg: outcome === 'impossible' ? legs.findIndex((l) => !l.found) : null,
    statesExplored: stNode.length,
    elapsedMs: Math.round(nowMs() - t0),
    keysRelevant: keyCount,
    keysPruned: Math.max(0, allKeys.size - keyCount)
  };
}
