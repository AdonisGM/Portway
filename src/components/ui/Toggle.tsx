/**
 * The switch spec from README line 91, used eight times across the form and
 * Settings: track 30x17 (w-7.5 h-4.25), knob 13px (size-3.25) inset 2px.
 * On is accent with a base-coloured knob pushed right; off is `w12` with a
 * muted knob at the left.
 */
interface Props {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  id?: string
}

export function Toggle({ checked, onChange, label, id }: Props) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-block h-4.25 w-7.5 flex-none rounded-toggle transition-colors ${
        checked ? 'bg-accent' : 'bg-w12'
      }`}
    >
      <span
        className={`absolute top-0.5 size-3.25 rounded-full transition-all ${
          checked ? 'right-0.5 bg-base' : 'left-0.5 bg-muted'
        }`}
      />
    </button>
  )
}

/** Toggle plus its trailing label, the way the form's Advanced row reads. */
export function ToggleField({ checked, onChange, label }: Props & { label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.25 text-cell text-fg-2">
      <Toggle checked={checked} onChange={onChange} label={label} />
      {label}
    </label>
  )
}
