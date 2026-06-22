import { contextBridge, ipcRenderer } from 'electron'
import { CH, type SentinelAPI } from '@shared/ipc'
import type { StreamChunk } from '@shared/types'

const api: SentinelAPI = {
  listBots: () => ipcRenderer.invoke(CH.listBots),
  getBot: (id) => ipcRenderer.invoke(CH.getBot, id),
  importBot: (req) => ipcRenderer.invoke(CH.importBot, req),
  pickFolder: () => ipcRenderer.invoke(CH.pickFolder),
  updateManifest: (id, patch) => ipcRenderer.invoke(CH.updateManifest, id, patch),

  getEnv: (id) => ipcRenderer.invoke(CH.getEnv, id),
  saveEnv: (id, values) => ipcRenderer.invoke(CH.saveEnv, id, values),
  setupEnv: (id) => ipcRenderer.invoke(CH.setupEnv, id),

  start: (id) => ipcRenderer.invoke(CH.start, id),
  stop: (id) => ipcRenderer.invoke(CH.stop, id),
  restart: (id) => ipcRenderer.invoke(CH.restart, id),
  setAutostart: (id, on) => ipcRenderer.invoke(CH.setAutostart, id, on),
  removeBot: (id) => ipcRenderer.invoke(CH.removeBot, id),
  updateBot: (id) => ipcRenderer.invoke(CH.updateBot, id),

  startLogin: (id) => ipcRenderer.invoke(CH.startLogin, id),
  loginInput: (id, data) => ipcRenderer.send(CH.loginInput, id, data),
  stopLogin: (id) => ipcRenderer.send(CH.stopLogin, id),
  openInTerminal: (id) => ipcRenderer.invoke(CH.openInTerminal, id),

  startLogTail: (id) => ipcRenderer.invoke(CH.startLogTail, id),
  stopLogTail: (id) => ipcRenderer.send(CH.stopLogTail, id),

  checkUpdates: (id) => ipcRenderer.invoke(CH.checkUpdates, id),
  pushLive: (id) => ipcRenderer.invoke(CH.pushLive, id),
  startTestRun: (id) => ipcRenderer.invoke(CH.startTestRun, id),

  getConfig: () => ipcRenderer.invoke(CH.getConfig),
  setNotify: (patch) => ipcRenderer.invoke(CH.setNotify, patch),
  testNotify: () => ipcRenderer.invoke(CH.testNotify),
  setAutoUpdate: (on) => ipcRenderer.invoke(CH.setAutoUpdate, on),
  setBackgroundAgent: (on) => ipcRenderer.invoke(CH.setBackgroundAgent, on),
  setControl: (on) => ipcRenderer.invoke(CH.setControl, on),
  setAgent: (patch) => ipcRenderer.invoke(CH.setAgent, patch),
  testAgent: () => ipcRenderer.invoke(CH.testAgent),
  setGithubToken: (token) => ipcRenderer.invoke(CH.setGithubToken, token),

  getSystemInfo: () => ipcRenderer.invoke(CH.systemInfo),
  setAppAutoLaunch: (on) => ipcRenderer.invoke(CH.setAppAutoLaunch, on),
  openAutoLoginSettings: () => ipcRenderer.invoke(CH.openAutoLoginSettings),
  revealBotDir: (id) => ipcRenderer.invoke(CH.revealBotDir, id),

  onStream: (cb) => subscribe(CH.evtStream, (p) => cb(p as StreamChunk)),
  onLoginExit: (cb) => subscribe(CH.evtLoginExit, (p) => cb(p as { botId: string; code: number | null })),
  onBotsChanged: (cb) => subscribe(CH.evtBotsChanged, () => cb())
}

function subscribe(channel: string, handler: (payload: unknown) => void): () => void {
  const listener = (_e: unknown, payload: unknown): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('sentinel', api)
