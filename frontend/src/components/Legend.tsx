export default function Legend() {
  return (
    <section className="panel legend">
      <h2>Legend</h2>
      <ul>
        <li><span className="swatch node" /> Location</li>
        <li><span className="swatch node visited" /> Visited Location</li>
        <li><span className="swatch node notes" /> Has Notes (Double Border)</li>
        <li><span className="swatch edge" /> Connection (Thickness = Weight)</li>
        <li><span className="swatch edge locked" /> Locked Connection</li>
        <li><span className="swatch edge stub" /> Ephemeral Stub ("To X" / "From Y")</li>
      </ul>
      <p className="muted small">
        Right-Click The Canvas To Create A Room, Or Right-Click A Room To Start A
        Connection. Double-Click A Room To Toggle Visited.
      </p>
    </section>
  );
}
