// Ported from HomeUI (home/apps/web/src/components/ui/toolbar.tsx).
import { Search, X } from 'lucide-react'
import { cx } from './primitives'
import { t } from '../../i18n'

/** The one search box of the app. */
export function SearchInput({
  value,
  onChange,
  placeholder = t('Tìm'),
  className,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <div
      className={cx(
        'flex h-8 min-w-[240px] items-center gap-2 rounded-lg border border-line2 bg-surface px-2.5 focus-within:border-accent',
        className,
      )}
    >
      <Search size={13} strokeWidth={2} className="flex-none text-muted" />
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 border-none bg-transparent text-[12.5px] text-ink outline-none select-text"
      />
      {value ? (
        <button type="button" onClick={() => onChange('')} title={t('Xoá ô tìm')} className="flex-none cursor-pointer text-muted hover:text-ink">
          <X size={13} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  )
}
