import { useMemo, useState } from 'react';
import { cyHolder, focusLocation } from '../graph/cyHolder';
import { ROUTE_MODE_LABELS, type RouteMode, type RoutePlan } from '../graph/pathfinding';
import { useGraphStore } from '../state/store';
import { CheckField } from './fields';

const round = (n: number) => (Math.round(n * 100) / 100).toString();
const thousands = (n: number) => n.toLocaleString();

function outcomeLine(plan: RoutePlan, legName: (i: number) => string) {
  switch (plan.outcome) {
    case 'optimal':
      return { cls: 'outcome-optimal', text: '✔ Best Possible Route (Search Completed)' };
    case 'suboptimal':
      return {
        cls: 'outcome-suboptimal',
        text:
          '~ Route Found, But Not Proven Optimal — ' +
          (plan.stopReason === 'cancelled'
            ? 'Search Cancelled'
            : plan.stopReason === 'time'
              ? 'Time Limit Reached'
              : 'Search Size Limit Reached')
      };
    case 'impossible':
      return {
        cls: 'outcome-impossible',
        text:
          '✖ Trip Is Impossible' +
          (plan.impossibleLeg !== null && plan.impossibleLeg >= 0
            ? ` — ${legName(plan.impossibleLeg)} Cannot Be Reached`
            : '')
      };
    case 'incomplete':
      return {
        cls: 'outcome-suboptimal',
        text: '⏹ Search Stopped Early — No Route Found Yet (Not Proven Impossible)'
      };
    default:
      return { cls: 'muted small', text: 'Add At Least Two Stops.' };
  }
}

export default function TripPlanner() {
  const locations = useGraphStore((s) => s.locations);
  const connections = useGraphStore((s) => s.connections);
  const groups = useGraphStore((s) => s.groups);
  const trip = useGraphStore((s) => s.trip);
  const addWaypoint = useGraphStore((s) => s.addWaypoint);
  const removeWaypoint = useGraphStore((s) => s.removeWaypoint);
  const moveWaypoint = useGraphStore((s) => s.moveWaypoint);
  const setTripMode = useGraphStore((s) => s.setTripMode);
  const setTripAxis = useGraphStore((s) => s.setTripAxis);
  const setAutoPlan = useGraphStore((s) => s.setAutoPlan);
  const startPlan = useGraphStore((s) => s.startPlan);
  const cancelPlan = useGraphStore((s) => s.cancelPlan);
  const clearTrip = useGraphStore((s) => s.clearTrip);
  const resetAllVisited = useGraphStore((s) => s.resetAllVisited);
  const selectLocation = useGraphStore((s) => s.selectLocation);
  const selectConnection = useGraphStore((s) => s.selectConnection);

  const [pick, setPick] = useState('');

  const sorted = useMemo(
    () => Object.values(locations).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [locations]
  );

  const name = (id: string) => locations[id]?.name || 'Unnamed Location';
  const suffix = (id: string) => {
    const gid = locations[id]?.groupId;
    return gid && groups[gid] ? ` (${groups[gid]!.name || 'Unnamed Grouping'})` : '';
  };
  const connName = (id: string) => {
    const c = connections[id];
    if (!c) return 'Removed Connection';
    return c.name || `${name(c.sourceId)} → ${name(c.targetId)}`;
  };

  const plan = trip.plan;
  const legName = (i: number) =>
    `Leg ${i + 1} (${name(trip.waypoints[i] ?? '')} → ${name(trip.waypoints[i + 1] ?? '')})`;

  const fitRoute = () => {
    const cy = cyHolder.cy;
    if (!cy || !plan) return;
    const wanted = new Set(plan.locationIds);
    const eles = cy.nodes('.location').filter((nd) => wanted.has(nd.id()));
    if (eles.nonempty()) cy.animate({ fit: { eles, padding: 80 } }, { duration: 350 });
  };

  return (
    <section className="panel">
      <h2>Trip Planner</h2>

      <ol className="trip-list">
        {trip.waypoints.map((id, i) => (
          <li key={`${id}:${i}`}>
            <span className="trip-index">{i + 1}</span>
            <button className="link" onClick={() => focusLocation(id, selectLocation)}>
              <span className="hit-title">
                {name(id)}
                <span className="in-group">{suffix(id)}</span>
              </span>
            </button>
            <button className="icon" title="Move Up" disabled={i === 0} onClick={() => moveWaypoint(i, -1)}>
              ↑
            </button>
            <button
              className="icon"
              title="Move Down"
              disabled={i === trip.waypoints.length - 1}
              onClick={() => moveWaypoint(i, 1)}
            >
              ↓
            </button>
            <button className="icon danger" title="Remove Stop" onClick={() => removeWaypoint(i)}>
              ✕
            </button>
          </li>
        ))}
        {trip.waypoints.length < 2 && (
          <li className="muted small">Add At Least Two Stops To Plan A Trip.</li>
        )}
      </ol>

      <div className="row">
        <select
          value={pick}
          onChange={(e) => {
            if (e.target.value) addWaypoint(e.target.value);
            setPick('');
          }}
        >
          <option value="">Add A Stop…</option>
          {sorted.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name || 'Unnamed Location'}
            </option>
          ))}
        </select>
      </div>

      <label className="field-center">
        Optimize For
        <select value={trip.mode} onChange={(e) => setTripMode(e.target.value as RouteMode)}>
          {Object.entries(ROUTE_MODE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      {trip.mode === 'coords' && (
        <div className="check-row triple">
          {(['x', 'y', 'z'] as const).map((axis) => (
            <CheckField
              key={axis}
              className="center"
              label={axis.toUpperCase()}
              checked={trip.axes[axis]}
              onChange={(v) => setTripAxis(axis, v)}
            />
          ))}
        </div>
      )}

      <CheckField
        className="center"
        label="Auto-Recompute"
        checked={trip.autoPlan}
        onChange={setAutoPlan}
      />

      {trip.running ? (
        <div className="trip-running">
          <span className="pulse">
            Searching… {thousands(trip.progress?.states ?? 0)} States ·{' '}
            {((trip.progress?.elapsedMs ?? 0) / 1000).toFixed(1)}s
          </span>
          <button onClick={cancelPlan}>Cancel & Use Best Found</button>
        </div>
      ) : (
        <div className="row actions">
          <button disabled={trip.waypoints.length < 2} onClick={() => void startPlan()}>
            {plan ? 'Re-Plan' : 'Plan'}
          </button>
          <button disabled={!plan} onClick={fitRoute}>
            Fit Route
          </button>
          <button disabled={!trip.waypoints.length} onClick={clearTrip}>
            Clear
          </button>
        </div>
      )}

      {trip.stale && plan && !trip.running && (
        <p className="trip-stale">
          This Plan Is Saved But Out Of Date — Press Re-Plan To Refresh It.
        </p>
      )}

      <button
        className="reset-visited"
        title="Treat every room as not yet visited"
        onClick={() => {
          if (confirm('Mark every location as unvisited? This re-locks any doors you had opened.')) {
            void resetAllVisited();
          }
        }}
      >
        Reset All Visited
      </button>

      <p className="muted small">
        Locked doors open once their prerequisite rooms have been visited — the planner detours
        through them when that is the only way. Visited status going in is respected.
      </p>

      {plan && (
        <>
          {(() => {
            const line = outcomeLine(plan, legName);
            return <p className={line.cls}>{line.text}</p>;
          })()}

          {plan.ok && (
            <p className="trip-summary">
              {plan.hops} Stops · Weight {round(plan.weight)} · Coordinate Change{' '}
              {round(plan.coordChange)}
              {plan.detourIds.length
                ? ` · ${plan.detourIds.length} Detour${plan.detourIds.length === 1 ? '' : 's'}`
                : ''}
            </p>
          )}

          <p className="muted small">
            Explored {thousands(plan.statesExplored)} States In {(plan.elapsedMs / 1000).toFixed(2)}s ·{' '}
            {plan.keysRelevant} Relevant Prerequisite{plan.keysRelevant === 1 ? '' : 's'}
            {plan.keysPruned ? `, ${plan.keysPruned} Pruned` : ''}
          </p>

          {plan.legs.map((leg, i) => (
            <div className="trip-leg" key={`${leg.fromId}:${leg.toId}:${i}`}>
              <h3>
                Leg {i + 1}: {name(leg.fromId)} → {name(leg.toId)}
              </h3>
              {!leg.found ? (
                <p className="trip-fail small">
                  {plan.outcome === 'impossible'
                    ? 'Unreachable — No Route Exists, Even Detouring To Unlock Doors.'
                    : 'Not Solved Before The Search Stopped.'}
                </p>
              ) : leg.steps.length === 0 ? (
                <p className="muted small">Already There.</p>
              ) : (
                <>
                  <ol className="hit-list dense">
                    {leg.steps.map((step, si) => (
                      <li
                        key={`${step.connectionId}:${si}`}
                        className={step.unlocks?.length ? 'trip-pickup' : ''}
                      >
                        <button className="link" onClick={() => selectConnection(step.connectionId)}>
                          <span className="hit-title">
                            {step.unlocks?.length ? '🔑 ' : step.locked ? '🔓 ' : ''}→ {name(step.toId)}
                            <span className="in-group">{suffix(step.toId)}</span>
                          </span>
                          <span className="muted small">
                            {[
                              connName(step.connectionId),
                              `Weight ${round(step.weight)}`,
                              trip.mode === 'coords' ? `Δ ${round(step.coordChange)}` : ''
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                          {step.locked && step.prerequisites?.length ? (
                            <span className="muted small needs">
                              Gate needs: {step.prerequisites.map(name).join(', ')}
                            </span>
                          ) : null}
                          {step.unlocks?.length ? (
                            <span className="muted small opens">
                              Opens: {step.unlocks.map(connName).join(', ')}
                            </span>
                          ) : null}
                        </button>
                        <button
                          className="icon"
                          title="Jump To This Stop"
                          onClick={() => focusLocation(step.toId, selectLocation)}
                        >
                          ⤴
                        </button>
                      </li>
                    ))}
                  </ol>

                  {leg.detours.length > 0 && (
                    <div className="trip-detours">
                      <span className="trip-detours-head">🔑 Detours To Unlock Gates</span>
                      <ul className="hit-list dense">
                        {leg.detours.map((d) => (
                          <li key={d.locationId}>
                            <button
                              className="link"
                              onClick={() => focusLocation(d.locationId, selectLocation)}
                            >
                              <span className="hit-title">{name(d.locationId)}</span>
                              <span className="muted small">
                                Opens: {d.opens.map(connName).join(', ')}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <p className="muted small">
                    {leg.hops} Stops · Weight {round(leg.weight)} · Coordinate Change{' '}
                    {round(leg.coordChange)}
                  </p>
                </>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
