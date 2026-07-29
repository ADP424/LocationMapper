import { planRoute, type PlannerInput } from '../graph/pathfinding';

interface PlanMessage {
  type: 'plan';
  requestId: number;
  input: PlannerInput;
}
interface CancelMessage {
  type: 'cancel';
  requestId: number;
}

let cancelRequested = -1;

self.onmessage = async (ev: MessageEvent<PlanMessage | CancelMessage>) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    cancelRequested = msg.requestId;
    return;
  }
  if (msg.type !== 'plan') return;

  const { requestId, input } = msg;
  try {
    const plan = await planRoute(input, {
      onProgress: (states, elapsedMs) =>
        (self as unknown as Worker).postMessage({ type: 'progress', requestId, states, elapsedMs }),
      /* the planner yields with setTimeout, so cancel messages land between chunks */
      shouldStop: () => cancelRequested === requestId
    });
    (self as unknown as Worker).postMessage({ type: 'done', requestId, plan });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'error',
      requestId,
      message: err instanceof Error ? err.message : String(err)
    });
  }
};
