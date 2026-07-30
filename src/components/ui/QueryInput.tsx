import { useCallback, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  replaceRange,
  tokenAt,
  tokenizeQuery,
  type QualifierSpec,
  type QueryToken,
} from '@/lib/query'
import { useAnchoredPanel } from './useAnchoredPanel'

/**
 * A filter field with GitHub-style `key:value` qualifiers: the typed prefixes
 * are tinted, and a suggestion list offers the available keys and then that
 * key's values.
 *
 * Domain-agnostic on purpose — it takes a list of `QualifierSpec`s and returns
 * a string. Any future screen that wants the same filtering (Known hosts,
 * Tunnels) supplies its own specs and gets the same behaviour.
 *
 * Colouring a substring is impossible inside an `<input>`, so the text is
 * painted by a mirrored overlay sitting exactly behind a transparent input.
 * The two must keep identical metrics — same font, size and line-height — or
 * the caret drifts away from the glyphs.
 */

interface Props {
  value: string
  onChange: (value: string) => void
  qualifiers: QualifierSpec[]
  placeholder?: string
  'aria-label'?: string
  /** Rendered before the field — the Servers toolbar shows a `/` here. */
  prefix?: ReactNode
  inputRef?: RefObject<HTMLInputElement | null>
  className?: string
}

interface Suggestion {
  kind: 'key' | 'value'
  /** Replaces the whole active token. */
  insert: string
  label: string
  hint?: string
}

const ROW_HEIGHT = 30
const MAX_SUGGESTIONS = 8

export function QueryInput({
  value,
  onChange,
  qualifiers,
  placeholder,
  prefix,
  inputRef,
  className = '',
  ...rest
}: Props) {
  const ownRef = useRef<HTMLInputElement>(null)
  const input = inputRef ?? ownRef
  const anchorRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [caret, setCaret] = useState(0)

  const tokens = useMemo(() => tokenizeQuery(value, qualifiers), [value, qualifiers])
  const activeTok = useMemo(() => tokenAt(tokens, caret), [tokens, caret])

  const suggestions = useMemo<Suggestion[]>(() => {
    // Inside `key:` — offer that key's values.
    if (activeTok?.kind === 'qualifier') {
      const spec = qualifiers.find((q) => q.key === activeTok.key)
      const typed = activeTok.value.toLowerCase()
      return (spec?.values ?? [])
        .filter((v) => v.toLowerCase().includes(typed))
        .slice(0, MAX_SUGGESTIONS)
        .map((v) => ({
          kind: 'value' as const,
          insert: `${activeTok.prefix}${v}`,
          label: v,
        }))
    }

    // Otherwise offer keys, narrowed by whatever bare word is being typed.
    const typed = (activeTok?.value ?? '').toLowerCase()
    return qualifiers
      .filter(
        (q) =>
          !typed ||
          q.key.startsWith(typed) ||
          q.label.toLowerCase().startsWith(typed) ||
          (q.aliases ?? []).some((a) => a.startsWith(typed)),
      )
      .slice(0, MAX_SUGGESTIONS)
      .map((q) => ({
        kind: 'key' as const,
        insert: `${q.key}:`,
        label: q.label,
        hint: q.hint,
      }))
  }, [activeTok, qualifiers])

  const close = useCallback(() => setOpen(false), [])
  const { panelRef, style } = useAnchoredPanel(
    open && suggestions.length > 0,
    anchorRef,
    {
      align: 'stretch',
      estimatedHeight: suggestions.length * ROW_HEIGHT + 8,
      onDismiss: close,
    },
    [suggestions.length],
  )

  /** Reads the caret after the browser has applied the keystroke. */
  const syncCaret = () => setCaret(input.current?.selectionStart ?? 0)

  const apply = (suggestion: Suggestion) => {
    const start = activeTok?.start ?? caret
    const end = activeTok?.end ?? caret
    // A value completes the qualifier, so follow it with a space and move on.
    // A key does not — the user still has to say which value.
    const insert = suggestion.kind === 'value' ? `${suggestion.insert} ` : suggestion.insert
    const next = replaceRange(value, start, end, insert)

    onChange(next.text)
    setActive(0)
    setOpen(true)

    // The caret has to be restored after React has written the new value.
    requestAnimationFrame(() => {
      const el = input.current
      if (!el) return
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
      setCaret(next.caret)
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const listOpen = open && suggestions.length > 0

    if (e.key === 'Escape' && listOpen) {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (!listOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActive((i) => (i + 1) % suggestions.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        setActive((i) => (i - 1 + suggestions.length) % suggestions.length)
        break
      case 'Tab':
      case 'Enter':
        // Enter would otherwise reach the screen's global shortcut and open a
        // session; while the list is open it belongs to the list.
        e.preventDefault()
        e.stopPropagation()
        apply(suggestions[active])
        break
    }
  }

  return (
    <>
      <div
        ref={anchorRef}
        className={`flex items-center gap-2 rounded-field border border-w07 bg-field px-2.5 py-1.5 focus-within:border-accent-27 ${className}`}
      >
        {prefix}

        <div className="relative min-w-0 flex-1">
          {/* Painted text. Must match the input's metrics exactly. */}
          <div
            ref={overlayRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden text-body leading-5 whitespace-pre"
          >
            <Painted text={value} tokens={tokens} />
          </div>

          <input
            ref={input}
            value={value}
            onChange={(e) => {
              onChange(e.target.value)
              setActive(0)
              setOpen(true)
              syncCaret()
            }}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onFocus={() => {
              setOpen(true)
              syncCaret()
            }}
            onBlur={close}
            onKeyDown={onKeyDown}
            onScroll={(e) => {
              if (overlayRef.current) overlayRef.current.scrollLeft = e.currentTarget.scrollLeft
            }}
            placeholder={placeholder}
            aria-label={rest['aria-label']}
            aria-expanded={open && suggestions.length > 0}
            aria-autocomplete="list"
            role="combobox"
            spellCheck={false}
            autoComplete="off"
            className="relative w-full bg-transparent text-body leading-5 text-transparent caret-fg placeholder:text-muted"
          />
        </div>
      </div>

      {open &&
        suggestions.length > 0 &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            // Keeps focus in the input, so clicking a row never blurs the field
            // out from under itself.
            onMouseDown={(e) => e.preventDefault()}
            style={style}
            className="z-60 overflow-y-auto rounded-field border border-w10 bg-drawer py-1 shadow-drawer"
          >
            {suggestions.map((s, i) => (
              <div
                key={`${s.kind}-${s.insert}`}
                role="option"
                aria-selected={i === active}
                onPointerEnter={() => setActive(i)}
                onClick={() => apply(s)}
                className={`flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 ${
                  i === active ? 'bg-w07' : ''
                }`}
              >
                {s.kind === 'key' ? (
                  <>
                    <span className="font-mono text-cell text-accent">{s.insert}</span>
                    <span className="text-cell text-fg-2">{s.label}</span>
                    {s.hint ? (
                      <span className="ml-auto truncate font-mono text-mono text-faint">
                        {s.hint}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="truncate font-mono text-cell text-fg-2">{s.label}</span>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}

/** Repaints the raw string, tinting the recognised `key:` prefixes. */
function Painted({ text, tokens }: { text: string; tokens: QueryToken[] }) {
  const parts: ReactNode[] = []
  let cursor = 0

  tokens.forEach((token, i) => {
    if (token.start > cursor) parts.push(text.slice(cursor, token.start))
    if (token.kind === 'qualifier') {
      parts.push(
        <span key={`k${i}`} className="text-accent">
          {token.prefix}
        </span>,
      )
      parts.push(
        <span key={`v${i}`} className="text-fg">
          {token.value}
        </span>,
      )
    } else {
      parts.push(
        <span key={`t${i}`} className="text-fg">
          {token.value}
        </span>,
      )
    }
    cursor = token.end
  })

  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}
