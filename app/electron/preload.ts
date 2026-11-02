import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type HudCommand = 'next' | 'prev' | 'dismiss' | 'toggleLock'

function subscribe<T>(channel: string, cb: (v: T) => void) {
  const listener = (_e: IpcRendererEvent, v: T) => cb(v)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.off(channel, listener) }
}

// Narrow, allowlisted API — no raw ipcRenderer in the renderer.
contextBridge.exposeInMainWorld('eloquent', {
  showHud: (meetingId: number, script?: string) => ipcRenderer.send('hud:show', meetingId, script ?? ''),
  hideHud: () => ipcRenderer.send('hud:hide'),
  setHudInteractive: (on: boolean) => ipcRenderer.send('hud:interactive', !!on),
  onHudMeeting: (cb: (id: number) => void) => subscribe('hud:meeting', cb),
  onHudScript: (cb: (s: string) => void) => subscribe('hud:script', cb),
  onHudCommand: (cb: (c: HudCommand) => void) => subscribe('hud:command', cb),
})
