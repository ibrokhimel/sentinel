import { assemble } from './shell'
import { fleetView } from './views/fleet'
import { settingsView } from './views/settings'
export const MINIAPP_HTML = assemble([fleetView, settingsView])
