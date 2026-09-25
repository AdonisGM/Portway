import { useEffect, useState } from 'react'
import { SplashScreen } from './components/splash'

export default function App() {
  // Nothing to wait for at startup yet (later: opening the encrypted server vault),
  // so the app is ready once mounted; the splash still plays the full logo build.
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])

  return (
    <>
      <main className="relative h-full bg-bg">
        <div className="grain pointer-events-none absolute inset-0" style={{ opacity: 'var(--grain)' }} />
      </main>
      <SplashScreen ready={ready} />
    </>
  )
}
