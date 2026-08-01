import type { ReactNode } from 'react'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { Toggle } from '@/components/ui/Toggle'
import { MetaRow, SectionLabel } from '@/components/ui/primitives'
import {
  FooterBar,
  FooterRight,
  ScreenHeader,
  ScreenShell,
  ScreenSubtitle,
  ScreenTitle,
} from '@/components/layout/ScreenShell'
import { useVersion } from '@/lib/version'
import { ACCENTS, useApp, type CursorStyle, type Density, type HostKeyPolicy } from '@/store/appStore'

/**
 * Preferences, all of which do something.
 *
 * The screen the design drew carried sixteen controls; eight of them had no
 * feature behind them — a theme picker with one theme, an idle lock with no
 * lock, a parallel-transfer count nothing read. They are gone rather than
 * wired to a value nobody consults: a switch that does nothing is worse than
 * an absent one, because it is a promise the app does not keep.
 *
 * What is left is saved as it is changed. There is no Save button, and no
 * "restart to apply" — a font size chosen here moves the terminal in the
 * window next to it, because the write goes out on `settings://changed`.
 *
 * Two things the design named do not exist and are said so here rather than
 * pretended at: the config lives in the database, not `config.toml`, and this
 * is russh rather than OpenSSH, so no `openssh 9.7p1` is claimed.
 */

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <SectionLabel className="mb-3">{title}</SectionLabel>
      <div className="flex flex-col gap-2.75 text-body">{children}</div>
    </div>
  )
}

/** Settings rows put the label left in `fg-2` and the control hard right. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <MetaRow
      label={
        // `min-w-0` so a long hint wraps instead of squeezing the control
        // beside it — without it a two-line explanation shortens the select it
        // is explaining to `accept-n…`.
        <span className="flex min-w-0 flex-col">
          <span className="text-fg-2">{label}</span>
          {/* Only where the label alone would leave a real question open —
              what "strict" refuses, what the bell does without a sound. */}
          {hint ? <span className="text-meta text-faint">{hint}</span> : null}
        </span>
      }
    >
      <span className="flex flex-none items-center">{children}</span>
    </MetaRow>
  )
}

const opts = (...values: string[]) => values.map((v) => ({ value: v, label: v }))

export function SettingsScreen() {
  const settings = useApp((s) => s.settings)
  const setSetting = useApp((s) => s.setSetting)
  const version = useVersion()

  return (
    <ScreenShell
      header={
        <ScreenHeader>
          <ScreenTitle>Settings</ScreenTitle>
          <ScreenSubtitle>saved as you change them, in ~/.portway/portway.db</ScreenSubtitle>
        </ScreenHeader>
      }
      footer={
        <FooterBar>
          <span>Portway{version ? ` v${version}` : ''}</span>
          <FooterRight>every setting here changes something</FooterRight>
        </FooterBar>
      }
    >
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 content-start gap-x-8.5 gap-y-6.5 overflow-y-auto px-6 py-5">
        <Group title="Appearance">
          <Row label="Accent">
            <span className="flex gap-1.5">
              {ACCENTS.map((accent) => (
                <button
                  key={accent}
                  type="button"
                  aria-label={`Accent ${accent}`}
                  onClick={() => setSetting('accent', accent)}
                  style={{ background: accent }}
                  className={`size-4.25 rounded-full ${
                    settings.accent === accent ? 'ring-2 ring-w15' : ''
                  }`}
                />
              ))}
            </span>
          </Row>
          <Row label="Row density" hint="every table in the app">
            <Segmented
              aria-label="Row density"
              size="xs"
              options={opts('compact', 'cozy')}
              value={settings.density}
              onChange={(v) => setSetting('density', v as Density)}
            />
          </Row>
          <Row label="Colour hosts by group">
            <Toggle
              label="Colour hosts by group"
              checked={settings.colourHostsByGroup}
              onChange={(v) => setSetting('colourHostsByGroup', v)}
            />
          </Row>
        </Group>

        <Group title="Terminal">
          <Row label="Font size">
            <Select
              variant="inline"
              aria-label="Terminal font size"
              options={[12, 13, 14, 15].map((n) => ({ value: String(n), label: `${n}px` }))}
              value={String(settings.fontSize)}
              onChange={(v) => setSetting('fontSize', Number(v))}
            />
          </Row>
          <Row label="Cursor">
            <Select
              variant="inline"
              aria-label="Cursor"
              options={opts('block', 'bar', 'underline')}
              value={settings.cursorStyle}
              onChange={(v) => setSetting('cursorStyle', v as CursorStyle)}
            />
          </Row>
          <Row label="Cursor blink">
            <Toggle
              label="Cursor blink"
              checked={settings.cursorBlink}
              onChange={(v) => setSetting('cursorBlink', v)}
            />
          </Row>
          <Row label="Scrollback">
            <Select
              variant="inline"
              aria-label="Scrollback"
              options={[1000, 10_000, 50_000].map((n) => ({
                value: String(n),
                label: `${n.toLocaleString('en-GB').replace(/,/g, ' ')} lines`,
              }))}
              value={String(settings.scrollback)}
              onChange={(v) => setSetting('scrollback', Number(v))}
            />
          </Row>
          <Row label="Visual bell" hint="the pane flashes — there is no sound">
            <Toggle label="Visual bell" checked={settings.bell} onChange={(v) => setSetting('bell', v)} />
          </Row>
        </Group>

        <Group title="Security">
          {/* What this does *not* decide is said here rather than as a row of
              its own: a key that has changed is always refused, and a row
              reading "refused" with nothing to click would read as a setting
              somebody had greyed out. */}
          <Row
            label="Host keys"
            hint={`${
              settings.hostKeys === 'strict'
                ? 'a server not in known_hosts is refused'
                : 'a server nobody has met is recorded and trusted'
            } · a key that has changed is always refused`}
          >
            <Select
              variant="inline"
              aria-label="Host key checking"
              options={opts('accept-new', 'strict')}
              value={settings.hostKeys}
              onChange={(v) => setSetting('hostKeys', v as HostKeyPolicy)}
            />
          </Row>
          <Row label="Confirm before connecting to prod">
            <Toggle
              label="Confirm before connecting to prod"
              checked={settings.confirmProd}
              onChange={(v) => setSetting('confirmProd', v)}
            />
          </Row>
        </Group>
      </div>
    </ScreenShell>
  )
}
