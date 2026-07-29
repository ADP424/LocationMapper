export default function Legend() {
  return (
    <section className="panel legend">
      <h2>Legend</h2>
      <ul>
        <li><span className="swatch node" /> Location</li>
        <li><span className="swatch node visited" /> Visited Location</li>
        <li><span className="swatch node notes" /> Has Notes (Double Border)</li>
        <li><span className="swatch group" /> Grouping (Drag To Move Everything Inside)</li>
        <li><span className="swatch edge" /> Connection (Thickness = Weight)</li>
        <li><span className="swatch edge dashed" /> Ephemeral Or Locked (Default Style Only)</li>
        <li>🔒 Locked Connection · 📝 Has Notes</li>
      </ul>
      <p className="muted small">
        Colors And Line Styles Are Yours To Choose — Nothing Is Overridden. "Default"
        Line Style Means The App Picks (Dashed For Ephemeral Or Locked, Otherwise Solid).
        A Connection With No Arrowheads Is Undirected: The Trip Planner Walks It Both Ways.
      </p>
      <p className="muted small">
        Right-Click Empty Space And Drag To Select Many Rooms. Right-Click Without
        Dragging For The Menu.
      </p>
    </section>
  );
}
