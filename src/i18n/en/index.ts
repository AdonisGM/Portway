// English translations, one file per area of the app, keyed by the Vietnamese text.
import type { Dict } from '..'
import common from './common'
import layout from './layout'
import servers from './servers'
import server from './server'
import files from './files'
import transfer from './transfer'
import docker from './docker'
import services from './services'
import firewall from './firewall'
import tunnels from './tunnels'
import http from './http'
import nginx from './nginx'
import settings from './settings'
import debug from './debug'

const all: Dict = {
  ...common,
  ...layout,
  ...servers,
  ...server,
  ...files,
  ...transfer,
  ...docker,
  ...services,
  ...firewall,
  ...tunnels,
  ...http,
  ...nginx,
  ...settings,
  ...debug,
}

export default all
