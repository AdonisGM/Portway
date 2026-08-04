import { useState } from 'react'
import { Labelled, fieldBox } from '@/components/ui/Field'

/**
 * The tag editor: chips for what is set, one input for what comes next.
 *
 * Enter and comma both commit, because a comma is what somebody types when
 * listing things and the alternative is a tag silently rejected on save — the
 * backend refuses commas, since one column holds the list. Backspace on an
 * empty box removes the last chip, which is the behaviour every tag input has
 * and the only way to correct a typo without reaching for the mouse.
 *
 * Suggestions are the tags already in use elsewhere. Left as a plain datalist
 * rather than a drawn panel: this is a two-word field, and a portalled listbox
 * over a form column would be more apparatus than the job needs.
 */
export function TagField({
  tags,
  onChange,
  suggestions,
}: {
  tags: string[]
  onChange: (tags: string[]) => void
  suggestions: string[]
}) {
  const [draft, setDraft] = useState('')

  /** Case-insensitive, because `Prod` and `prod` are one tag typed twice. */
  const add = (raw: string) => {
    const tag = raw.trim()
    if (tag === '') return
    if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) onChange([...tags, tag])
    setDraft('')
  }

  return (
    <Labelled
      label={
        <>
          Tags <span className="text-faint">(free-form — enter or comma to add)</span>
        </>
      }
    >
      <div className={`${fieldBox} flex flex-wrap items-center gap-1.5`}>
        {tags.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 rounded-chip bg-w13 py-0.75 pr-1 pl-2 font-mono text-mono text-fg-2"
          >
            {tag}
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              onClick={() => onChange(tags.filter((t) => t !== tag))}
              className="flex size-3.5 items-center justify-center rounded-nav text-faint transition-colors hover:bg-w15 hover:text-fg"
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          list="portway-tags"
          aria-label="Add a tag"
          placeholder={tags.length === 0 ? 'backup, customer-a, k8s' : ''}
          onChange={(e) => {
            // A comma pasted or typed mid-word commits what precedes it, so
            // pasting `a,b,c` lands three chips rather than one bad tag.
            const value = e.target.value
            if (!value.includes(',')) return setDraft(value)
            const parts = value.split(',')
            for (const part of parts.slice(0, -1)) add(part)
            setDraft(parts[parts.length - 1] ?? '')
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // The form's Save is not the intent here, and a bare Enter in a
              // text field would otherwise submit past the half-typed tag.
              e.preventDefault()
              add(draft)
            }
            if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
              onChange(tags.slice(0, -1))
            }
          }}
          onBlur={() => add(draft)}
          className="min-w-32 flex-1 bg-transparent font-mono text-body text-fg-2 outline-none placeholder:text-faint"
        />
        <datalist id="portway-tags">
          {suggestions
            .filter((s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase()))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      </div>
    </Labelled>
  )
}
