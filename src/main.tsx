import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { DebugWindow } from './debug/debug-window'
import '@fontsource-variable/inter'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto-mono/400.css'
/** Wordmark font for the AdonisGM lockup, self-hosted by the logo package. */
import '@adonisgm/logo/styles.css'
import './styles/app.css'
import { followTheme } from './lib/theme'
import { followLanguage } from './i18n/follow'

// The same bundle serves the main window and the debug trace window.
const isDebug = new URLSearchParams(window.location.search).get('window') === 'debug'
followTheme()
followLanguage()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isDebug ? <DebugWindow /> : <App />}</React.StrictMode>,
)
