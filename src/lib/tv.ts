import { createTV } from 'tailwind-variants'

/**
 * tailwind-variants runs tailwind-merge over the classes it composes, and
 * tailwind-merge only knows Tailwind's stock scale. Our type ramp is custom
 * (`text-cell`, `text-meta`, …), so by default it falls through to the
 * text-colour group and collides with `text-fg-2` / `text-muted` — one of the
 * two silently loses.
 *
 * Registering the ramp as font sizes keeps colour and size independent, so a
 * variant can set the colour and a size can set the scale without either
 * dropping the other.
 */
export const tv = createTV({
  twMergeConfig: {
    extend: {
      classGroups: {
        'font-size': [
          {
            text: [
              'title',
              'host',
              'body',
              'cell',
              'meta',
              'mono',
              'label',
              'badge',
              'status',
            ],
          },
        ],
      },
    },
  },
})
