import { useEffect, useState } from 'react'
import { ConnectionsProvider } from './app/connections'
import { NavProvider } from './app/nav'
import { ServersProvider } from './app/servers'
import { SettingsProvider } from './app/settings'
import { SplashScreen } from './components/splash'
import { ToastProvider } from './components/toast'
import { TraceProvider } from './app/trace'
import { TunnelsProvider } from './app/tunnels'
import { TransfersProvider } from './app/transfers'
import { AppShell } from './layout/app-shell'

export default function App() {
  // Nothing to wait for at startup yet (later: opening the encrypted server vault),
  // so the app is ready once mounted; the splash still plays the full logo build.
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])

  return (
    <SettingsProvider>
      <ServersProvider>
        <ConnectionsProvider>
          <NavProvider>
            <ToastProvider>
              <TransfersProvider>
                <TraceProvider>
                  <TunnelsProvider>
                    <AppShell />
                    <SplashScreen ready={ready} />
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
