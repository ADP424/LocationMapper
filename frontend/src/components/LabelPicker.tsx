import type { MenuEntry } from './Menu';
import PickerButton from './PickerButton';

export interface PickableLabel {
  id: string;
  name: string;
  color: string;
}

interface Props {
  labels: PickableLabel[];
  exclude?: Set<string>;
  onPick: (labelId: string) => void;
  onCreateNew?: () => void;
  newLabel?: string;
  buttonLabel?: string;
  disabled?: boolean;
}

/** A dropdown menu for attaching a label to a location/connection (or many at once). */
export default function LabelPicker({
  labels,
  exclude,
  onPick,
  onCreateNew,
  newLabel = '+ New Label',
  buttonLabel = '+ Add Label',
  disabled
}: Props) {
  const available = labels
    .filter((l) => !exclude?.has(l.id))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const entries: MenuEntry[] = available.length
    ? available.map((l) => ({ label: l.name || 'Unnamed Label', onSelect: () => onPick(l.id) }))
    : [{ label: 'No Labels Available', onSelect: () => undefined, disabled: true }];

  if (onCreateNew) entries.push({ label: newLabel, onSelect: onCreateNew });

  return <PickerButton label={buttonLabel} entries={entries} disabled={disabled} />;
}
