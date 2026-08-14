import { useGraphStore } from '../state/store';
import { Help } from './fields';

const GROUPING_HINT = {
  always: 'Grouping (Drag To Move Everything Inside)',
  selected: 'Grouping (Select It, Then Drag To Move Everything Inside)',
  never: 'Grouping (Drag Over It To Pan)'
} as const;

export default function Legend() {
  const groupDrag = useGraphStore((s) => s.settings.groupDrag);

  return (
    <section className="panel legend">
      <h2>Legend</h2>
      <ul>
        <li><span className="swatch node" /> Location</li>
        <li><span className="swatch node visited" /> Visited Location</li>
        <li><span className="swatch node notes" /> Has Notes (Double Border)</li>
        <li><span className="swatch group" /> {GROUPING_HINT[groupDrag]}</li>
        <li><span className="swatch edge" /> Connection (Thickness = Weight)</li>
        <li><span className="swatch edge dashed" /> Ephemeral Or Locked (Default Style Only)</li>
        <li>🔒 Locked Connection · 📝 Has Notes</li>
        <li>
          ★ Default Trip Start · ↻ Restart
          <Help text="A restart is a one-way move granted by a location label: every room carrying it may jump to the label's targets. It is never drawn, but the trip planner marks every one it takes, and a trip can turn them off." />
        </li>
      </ul>
      <p className="muted small">
        Colors And Line Styles Are Yours To Choose — Nothing Is Overridden. "Default"
        Line Style Means The App Picks (Dashed For Ephemeral Or Locked, Otherwise Solid).
        A Connection With No Arrowheads Is Undirected: The Trip Planner Walks It Both Ways.
      </p>
      <p className="muted small">
        Right-Click Empty Space Or A Grouping And Drag To Select Many Rooms. Right-Click
        Without Dragging For The Menu.
      </p>
    </section>
  );
}
