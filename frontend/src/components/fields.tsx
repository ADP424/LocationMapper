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
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
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
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
