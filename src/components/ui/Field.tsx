import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react'

/**
 * The form's field box: an 11.5px muted label above a raised box on `field`
 * with a hairline border, value in mono 12.5px. Focus swaps the border to the
 * accent at 27% — derived from `--color-accent` so it follows the accent
 * picker, where the mock hardcodes `#5ec8b044`.
 */

export const fieldBox =
  'w-full rounded-field border border-w08 bg-field px-2.5 py-2 text-body transition-colors focus-within:border-accent-27'

interface LabelProps {
  label: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
}

export function Labelled({ label, htmlFor, children, className = '' }: LabelProps) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={htmlFor} className="text-meta text-muted">
        {label}
      </label>
      {children}
    </div>
  )
}

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  label: ReactNode
  /** Renders as a password with a `show` affordance, as the mock's masked rows do. */
  masked?: boolean
  wrapperClassName?: string
}

export function Field({ label, masked, wrapperClassName, className = '', ...rest }: FieldProps) {
  const id = useId()
  const [revealed, setRevealed] = useState(false)

  const input = (
    <input
      id={id}
      className={`min-w-0 flex-1 font-mono text-body placeholder:text-faint ${className}`}
      type={masked && !revealed ? 'password' : 'text'}
      {...rest}
    />
  )

  return (
    <Labelled label={label} htmlFor={id} className={wrapperClassName}>
      <div className={`${fieldBox} flex items-center gap-2`}>
        {input}
        {masked ? (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="flex-none text-mono text-faint transition-colors hover:text-fg-2"
          >
            {revealed ? 'hide' : 'show'}
          </button>
        ) : null}
      </div>
    </Labelled>
  )
}
