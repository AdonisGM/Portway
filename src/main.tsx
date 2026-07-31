import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import SessionWindow from './SessionWindow'
import './styles/global.css'

/**
 * Two entry points, one bundle.
 *
 * A session opened in its own window loads the same `index.html` with
 * `?host=<id>` and renders only that session — no rail, no host list. The
 * branch is here rather than inside `App` so a session window never mounts the
 * shell at all: it would otherwise read the database and scan `~/.ssh` for a
 * sidebar it does not draw.
 */
const hostParam = new URLSearchParams(window.location.search).get('host')
const hostId = hostParam === null ? null : Number(hostParam)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {hostId !== null && Number.isInteger(hostId) ? <SessionWindow hostId={hostId} /> : <App />}
  </React.StrictMode>,
)
