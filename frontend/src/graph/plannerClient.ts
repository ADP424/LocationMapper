import { planRoute, type PlannerInput, type RoutePlan } from './pathfinding';

export interface PlannerRun {
  /** Resolves with `null` when the run was discarded (superseded). */
  promise: Promise<RoutePlan | null>;
  /** Graceful: the search returns the best route found so far. */
  cancel: () => void;
  /** Hard stop, used when a newer request supersedes this one. */
  discard: () => void;
}

let nextRequestId = 1;

/** Kept warm across runs — spinning one up costs ~5-20ms, paid on every trip re-plan. */
let pooledWorker: Worker | null = null;
let pooledBusy = false;

function getWorker(): Worker | null {
  if (pooledWorker && !pooledBusy) return pooledWorker;
  if (pooledWorker) return null; // busy with another request; caller falls back
  try {
    pooledWorker = new Worker(new URL('../workers/planner.worker.ts', import.meta.url), {
      type: 'module'
    });
    return pooledWorker;
  } catch {
    pooledWorker = null;
    return null;
  }
}

function discardPool() {
  pooledWorker?.terminate();
  pooledWorker = null;
  pooledBusy = false;
}

/**
 * Runs the planner in a Worker so long searches never block the UI, and so the
 * user can cancel and still get whatever was found. Falls back to the main
 * thread (the planner yields, so the UI survives) if Workers are unavailable
 * or already busy with a superseded request.
 */
export function runPlanner(
  input: PlannerInput,
  onProgress?: (states: number, elapsedMs: number) => void
): PlannerRun {
  const requestId = nextRequestId++;
  const worker = pooledBusy ? null : getWorker();

  if (worker) {
    pooledBusy = true;
    let settled = false;
    let finish: (plan: RoutePlan | null) => void = () => undefined;
    const release = () => {
      settled = true;
      pooledBusy = false;
    };
    const promise = new Promise<RoutePlan | null>((resolve, reject) => {
      finish = resolve;
      worker.onmessage = (ev: MessageEvent<any>) => {
        const msg = ev.data;
        if (msg?.requestId !== requestId) return;
        if (msg.type === 'progress') {
          onProgress?.(msg.states, msg.elapsedMs);
          return;
        }
        if (msg.type === 'error') {
          release();
          reject(new Error(msg.message || 'route planning failed'));
          return;
        }
        if (msg.type === 'done') {
          release();
          resolve(msg.plan as RoutePlan);
        }
      };
      worker.onerror = (ev) => {
        if (settled) return;
        ev.preventDefault?.();
        /* the worker's state is unknown after an uncaught error — don't reuse it */
        discardPool();
        reject(new Error(ev.message || 'the route planner worker crashed'));
      };
      worker.postMessage({ type: 'plan', requestId, input });
    });

    return {
      promise,
      cancel: () => {
        if (!settled) worker.postMessage({ type: 'cancel', requestId });
      },
      discard: () => {
        if (settled) return;
        /* graceful: let the worker finish its current chunk and free itself up,
           rather than terminating and paying to spin up a fresh one next time */
        settled = true;
        pooledBusy = false;
        worker.postMessage({ type: 'cancel', requestId });
        worker.onmessage = null;
        finish(null);
      }
    };
  }

  /* ---- in-process fallback ---- */
  let cancelled = false;
  let discarded = false;
  const promise = planRoute(input, { onProgress, shouldStop: () => cancelled }).then((plan) =>
    discarded ? null : plan
  );
  return {
    promise,
    cancel: () => {
      cancelled = true;
    },
    discard: () => {
      discarded = true;
      cancelled = true;
    }
  };
}
