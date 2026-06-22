interface Props {
  checked: boolean
  onChange: (on: boolean) => void
  label?: string
  disabled?: boolean
}

/** Accessible on/off toggle. The native checkbox stays the a11y source of truth. */
export function Switch({ checked, onChange, label, disabled }: Props): React.ReactElement {
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" aria-hidden="true" />
      {label && <span>{label}</span>}
    </label>
  )
}
