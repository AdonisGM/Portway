import { useEffect, useState } from 'react'
import { ConnectionsProvider } from './app/connections'
import { EditsProvider } from './app/edits'
import { NavProvider } from './app/nav'
import { ServersProvider } from './app/servers'
import { SettingsProvider } from './app/settings'
import { SplashScreen } from './components/splash'
import { ToastProvider } from './components/toast'
import { TraceProvider } from './app/trace'
import { TunnelsProvider } from './app/tunnels'
import { TransfersProvider } from './app/transfers'
import { AppShell } from './layout/app-shell'
import { useLang } from './i18n/use-lang'

export default function App() {
  // Nothing to wait for at startup yet (later: opening the encrypted server vault),
  // so the app is ready once mounted; the splash still plays the full logo build.
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  // The tree is built here, so a language change re-renders all of it (every
  // t() call reads the new language) while every provider keeps its state.
  useLang()

  return (
    <SettingsProvider>
      <ServersProvider>
        <ConnectionsProvider>
          <NavProvider>
            <ToastProvider>
              <TransfersProvider>
                <TraceProvider>
                  <TunnelsProvider>
                    <EditsProvider>
                      <AppShell />
                      <SplashScreen ready={ready} />
                    </EditsProvider>
                  </TunnelsProvider>
                </TraceProvider>
              </TransfersProvider>
            </ToastProvider>
          </NavProvider>
        </ConnectionsProvider>
      </ServersProvider>
    </SettingsProvider>
  )
}
