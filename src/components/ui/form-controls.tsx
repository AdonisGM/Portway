// Ported from HomeUI (home/apps/web/src/components/ui/form-controls.tsx).
import { Select, createListCollection } from '@ark-ui/react/select'
import { Portal } from '@ark-ui/react/portal'
import { Check, ChevronDown } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { cx, Caption, Label } from './primitives'

export type Option = { value: string; label: string }

const inputBase =
  'h-[34px] w-full rounded-lg border border-line2 bg-sunken px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent'

export function Field({
  label,
  help,
  error,
  children,
  className,
}: {
  label?: ReactNode
  help?: ReactNode
  error?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      {label ? <Label>{label}</Label> : null}
      {children}
      {error ? <span className="text-[11px] text-danger">{error}</span> : help ? <Caption>{help}</Caption> : null}
    </div>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  numeric,
  align,
  className,
  onBlur,
  invalid,
  autoFocus,
  type = 'text',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  numeric?: boolean
  align?: 'right'
  className?: string
  onBlur?: () => void
  invalid?: boolean
  autoFocus?: boolean
  type?: 'text' | 'password'
}) {
  return (
    <input
      type={type}
      value={value}
      onBlur={onBlur}
      placeholder={placeholder}
      autoFocus={autoFocus}
      data-autofocus={autoFocus || undefined}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      inputMode={numeric ? 'numeric' : undefined}
      onChange={(e) => onChange(e.target.value)}
      className={cx(
        inputBase,
        numeric && 'num',
        align === 'right' && 'text-right',
        invalid && '!border-danger',
        'select-text',
        className,
      )}
    />
  )
}

/** Ark select: the list is drawn by us, so it follows the tokens unlike a native select.
 *  The list is at least as wide as the trigger and grows to fit the longest option,
 *  so options stay on one line even when the trigger is narrow. */
export function SelectField({
  value,
  onChange,
  options,
  placeholder = 'Chọn',
  className,
}: {
  value: string
  onChange: (v: string) => void
  options: Option[]
  placeholder?: string
  className?: string
}) {
  const collection = useMemo(
    () => createListCollection({ items: options, itemToValue: (i) => i.value, itemToString: (i) => i.label }),
    [options],
  )
  return (
    <Select.Root
      collection={collection}
      value={value ? [value] : []}
      onValueChange={(e) => onChange(e.value[0] ?? '')}
      positioning={{ placement: 'bottom-start' }}
    >
      <Select.Control>
        <Select.Trigger className={cx(inputBase, 'flex cursor-pointer items-center justify-between gap-2 text-left', className)}>
          <Select.ValueText placeholder={placeholder} className="truncate" />
          <ChevronDown size={14} strokeWidth={1.75} className="flex-none text-muted" />
        </Select.Trigger>
      </Select.Control>
      <Portal>
        <Select.Positioner className="z-50">
          <Select.Content className="max-h-64 w-max max-w-[360px] min-w-[var(--reference-width)] overflow-auto rounded-lg border border-line2 bg-surface p-1 shadow-pop focus:outline-none">
            {options.map((o) => (
              <Select.Item
                key={o.value}
                item={o}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] whitespace-nowrap data-[highlighted]:bg-sunken data-[state=checked]:text-accent"
              >
                <Select.ItemText>{o.label}</Select.ItemText>
                <Select.ItemIndicator className="ml-auto pl-2 text-accent">
                  <Check size={14} strokeWidth={2} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Portal>
    </Select.Root>
  )
}
