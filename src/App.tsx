import { useEffect, useState } from 'react'
import { SplashScreen } from './components/splash'

export default function App() {
  // Nothing to wait for at startup yet (later: opening the encrypted server vault),
  // so the app is ready once mounted; the splash still plays the full logo build.
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])

  return (
    <>
      <main className="h-full bg-bg" />
      {/* Grain over the whole app, above content like home's AppShell; it never
          takes clicks. */}
      <div className="grain pointer-events-none fixed inset-0 z-[1]" style={{ opacity: 'var(--grain)' }} />
      <SplashScreen ready={ready} />
    </>
  )
}
