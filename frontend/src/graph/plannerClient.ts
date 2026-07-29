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

/**
 * Runs the planner in a Worker so long searches never block the UI, and so the
 * user can cancel and still get whatever was found. Falls back to the main
 * thread (the planner yields, so the UI survives) if Workers are unavailable.
 */
export function runPlanner(
  input: PlannerInput,
  onProgress?: (states: number, elapsedMs: number) => void
): PlannerRun {
  const requestId = nextRequestId++;

  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('../workers/planner.worker.ts', import.meta.url), {
      type: 'module'
    });
  } catch {
    worker = null;
  }

  if (worker) {
    const active = worker;
    let settled = false;
    let finish: (plan: RoutePlan | null) => void = () => undefined;
    const promise = new Promise<RoutePlan | null>((resolve, reject) => {
      finish = resolve;
      active.onmessage = (ev: MessageEvent<any>) => {
        const msg = ev.data;
        if (msg?.requestId !== requestId) return;
        if (msg.type === 'progress') {
          onProgress?.(msg.states, msg.elapsedMs);
          return;
        }
        if (msg.type === 'error') {
          settled = true;
          active.terminate();
          reject(new Error(msg.message || 'route planning failed'));
          return;
        }
        if (msg.type === 'done') {
          settled = true;
          active.terminate();
          resolve(msg.plan as RoutePlan);
        }
      };
      active.onerror = (ev) => {
        if (settled) return;
        settled = true;
        ev.preventDefault?.();
        active.terminate();
        reject(new Error(ev.message || 'the route planner worker crashed'));
      };
      active.postMessage({ type: 'plan', requestId, input });
    });

    return {
      promise,
      cancel: () => {
        if (!settled) active.postMessage({ type: 'cancel', requestId });
      },
      discard: () => {
        if (settled) return;
        settled = true;
        active.terminate();
        /* never leave the promise dangling for a caller that still holds it */
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
