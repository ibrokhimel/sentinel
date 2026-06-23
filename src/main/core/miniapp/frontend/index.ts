import { assemble } from './shell'
import { fleetView } from './views/fleet'
import { chatView } from './views/chat'
import { settingsView } from './views/settings'
import { botsManageView } from './views/botsManage'
export const MINIAPP_HTML = assemble([fleetView, chatView, settingsView, botsManageView])
