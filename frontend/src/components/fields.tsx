import type { ReactNode } from 'react';

/** Caption above a checkbox, both inside a real <label> so the text is clickable. */
export function CheckField({
  label,
  checked,
  onChange,
  title,
  disabled,
  className = ''
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  title?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label className={`check-field ${className}`.trim()} title={title}>
      <span className="field-label">{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Caption beside the checkbox, for toolbars and slider rows. */
export function InlineCheckField({
  label,
  checked,
  onChange,
  title,
  disabled
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <label className="inline-label tight" title={title}>
      <span className="field-label">{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** A colour with a "use the theme default" escape hatch. */
export function ColorField({
  label,
  value,
  fallback,
  onChange
}: {
  label: string;
  value: string;
  fallback: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="color-field">
      <span className="field-label">{label}</span>
      <div className="color-row">
        <input type="color" value={value || fallback} onChange={(e) => onChange(e.target.value)} />
        <button onClick={() => onChange('')} disabled={!value} title="Use Theme Default">
          Default
        </button>
      </div>
    </div>
  );
}

/** A colour that may be "unset" (no override) — used by label default fields. */
export function OptionalColorField({
  label,
  value,
  fallback,
  onChange
}: {
  label: string;
  value: string;
  fallback: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="color-field">
      <span className="field-label">{label}</span>
      <div className="color-row">
        <input
          type="checkbox"
          checked={!!value}
          title="Override"
          onChange={(e) => onChange(e.target.checked ? value || fallback : '')}
        />
        <input type="color" value={value || fallback} disabled={!value} onChange={(e) => onChange(e.target.value)} />
        <span className="muted small">{value ? 'Override' : 'No Override'}</span>
      </div>
    </div>
  );
}

/** Chips with a per-label "Apply" so any earlier label's styling can be re-stamped. */
export function LabelChips({
  labels,
  onApply,
  onRemove
}: {
  labels: Array<{ id: string; name: string; color: string }>;
  onApply: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (!labels.length) return <p className="muted small">No Labels Applied.</p>;
  return (
    <ul className="chip-list">
      {labels.map((l) => (
        <li key={l.id} className="chip">
          <span className="chip-dot" style={{ background: l.color || '#8897ad' }} />
          <span className="chip-name">{l.name || 'Unnamed Label'}</span>
          <button className="chip-btn" title="Apply This Label's Styling" onClick={() => onApply(l.id)}>
            Apply
          </button>
          <button className="chip-btn danger" title="Remove Label" onClick={() => onRemove(l.id)}>
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}
