import { useState, type ReactNode } from 'react'
import { Chip } from '@/components/ui/Chip'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { Toggle } from '@/components/ui/Toggle'
import { MetaRow, SectionLabel } from '@/components/ui/primitives'
import { FooterBar, ScreenHeader, ScreenShell, ScreenSubtitle, ScreenTitle } from '@/components/layout/ScreenShell'
import { ACCENTS, useApp } from '@/store/appStore'

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <SectionLabel className="mb-3">{title}</SectionLabel>
      <div className="flex flex-col gap-2.75 text-body">{children}</div>
    </div>
  )
}

/** Settings rows put the label left in `fg-2` and the control hard right. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <MetaRow label={<span className="text-fg-2">{label}</span>}>{children}</MetaRow>
  )
}

const opts = (...values: string[]) => values.map((v) => ({ value: v, label: v }))

export function SettingsScreen() {
  const settings = useApp((s) => s.settings)
  const setSetting = useApp((s) => s.setSetting)

  /**
   * Local rather than in the store on purpose: none of these change how the
   * app behaves yet — there is no terminal to apply a font to, no transfer
   * queue to parallelise. They are real controls over placeholder values, and
   * they move to the store as each feature lands.
   */
  const [choices, setChoices] = useState({
    theme: 'Dark',
    density: 'compact',
    font: 'IBM Plex Mono · 13px',
    cursor: 'block · blink',
    idleLock: '15 min',
    strictHostKey: 'ask',
    downloadFolder: '~/Downloads',
    backup: 'local only',
  })
  const set = <K extends keyof typeof choices>(key: K) => (value: string) =>
    setChoices((c) => ({ ...c, [key]: value }))

  return (
    <ScreenShell
      header={
        <ScreenHeader>
          <ScreenTitle>Settings</ScreenTitle>
          <ScreenSubtitle>config stored at ~/.portway/config.toml</ScreenSubtitle>
        </ScreenHeader>
      }
      footer={
        <FooterBar>
          <span>Portway 0.4.1 · openssh 9.7p1</span>
        </FooterBar>
      }
    >
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 content-start gap-x-8.5 gap-y-6.5 overflow-y-auto px-6 py-5">
        <Group title="Appearance">
          <Row label="Theme">
            <Segmented
              aria-label="Theme"
              size="xs"
              options={opts('Auto', 'Dark')}
              value={choices.theme}
              onChange={set('theme')}
            />
          </Row>
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
          <Row label="Row density">
            <Select
              variant="inline"
              aria-label="Row density"
              options={opts('compact', 'cozy')}
              value={choices.density}
              onChange={set('density')}
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
          <Row label="Font">
            <Select
              variant="inline"
              aria-label="Terminal font"
              options={opts('IBM Plex Mono · 13px', 'IBM Plex Mono · 12px')}
              value={choices.font}
              onChange={set('font')}
            />
          </Row>
          <Row label="Cursor">
            <Select
              variant="inline"
              aria-label="Cursor"
              options={opts('block · blink', 'block', 'bar · blink')}
              value={choices.cursor}
              onChange={set('cursor')}
            />
          </Row>
          <Row label="Scrollback">
            <span className="font-mono text-cell text-muted">10 000 lines</span>
          </Row>
          <Row label="Bell">
            <Toggle label="Bell" checked={settings.bell} onChange={(v) => setSetting('bell', v)} />
          </Row>
        </Group>

        <Group title="Security">
          <Row label="Store secrets in OS keychain">
            <Toggle
              label="Store secrets in OS keychain"
              checked={settings.storeSecretsInKeychain}
              onChange={(v) => setSetting('storeSecretsInKeychain', v)}
            />
          </Row>
          <Row label="Confirm before connecting to prod">
            <Toggle
              label="Confirm before connecting to prod"
              checked={settings.confirmProd}
              onChange={(v) => setSetting('confirmProd', v)}
            />
          </Row>
          <Row label="Lock app after idle">
            <Select
              variant="inline"
              aria-label="Lock app after idle"
              options={opts('5 min', '15 min', '1 h', 'never')}
              value={choices.idleLock}
              onChange={set('idleLock')}
            />
          </Row>
          <Row label="Strict host key checking">
            <Select
              variant="inline"
              aria-label="Strict host key checking"
              options={opts('ask', 'yes', 'no')}
              value={choices.strictHostKey}
              onChange={set('strictHostKey')}
            />
          </Row>
        </Group>

        <Group title="Transfers & sync">
          <Row label="Default download folder">
            <Select
              variant="inline"
              aria-label="Default download folder"
              options={opts('~/Downloads', '~/Desktop')}
              value={choices.downloadFolder}
              onChange={set('downloadFolder')}
            />
          </Row>
          <Row label="Parallel transfers">
            <span className="font-mono text-cell text-muted">4</span>
          </Row>
          <Row label="Import from ~/.ssh/config">
            <Chip tone="strong" size="md">
              Sync now
            </Chip>
          </Row>
          <Row label="Config backup">
            <Select
              variant="inline"
              aria-label="Config backup"
              options={opts('local only', 'off')}
              value={choices.backup}
              onChange={set('backup')}
            />
          </Row>
        </Group>
      </div>
    </ScreenShell>
  )
}
