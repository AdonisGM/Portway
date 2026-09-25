import { useEffect, useState } from 'react'
import { NavProvider } from './app/nav'
import { SplashScreen } from './components/splash'
import { AppShell } from './layout/app-shell'

export default function App() {
  // Nothing to wait for at startup yet (later: opening the encrypted server vault),
  // so the app is ready once mounted; the splash still plays the full logo build.
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])

  return (
    <NavProvider>
      <AppShell />
      <SplashScreen ready={ready} />
    </NavProvider>
  )
}
