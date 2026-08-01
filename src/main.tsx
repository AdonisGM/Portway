import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import DebugWindow from './DebugWindow'
import SessionWindow from './SessionWindow'
import { installLogCapture } from './lib/log'
import './styles/global.css'

/**
 * Three entry points, one bundle.
 *
 * Every window loads the same `index.html`; the query says which one it is.
 * `?host=<id>` is a session and renders only that session — no rail, no host
 * list. `?debug=1` is the log console. Neither mounts the shell at all: a
 * session window would otherwise read the database and scan `~/.ssh` for a
 * sidebar it does not draw, and the console needs neither.
 *
 * A window added here also has to be named in `capabilities/default.json`, or
 * it renders perfectly and receives nothing the backend emits.
 */
const params = new URLSearchParams(window.location.search)
const hostParam = params.get('host')
const hostId = hostParam === null ? null : Number(hostParam)
const isSession = hostId !== null && Number.isInteger(hostId)
const isDebug = params.get('debug') !== null

// Before React, so an error thrown while the tree is first mounting is caught
// too — that is the failure with no visible symptom at all, because there is
// nothing on screen yet to look wrong.
installLogCapture(isDebug ? 'debug' : isSession ? `session-${hostId}` : 'main')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isDebug ? <DebugWindow /> : isSession ? <SessionWindow hostId={hostId} /> : <App />}
  </React.StrictMode>,
)
