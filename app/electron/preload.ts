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
  setLiveMeeting: (meetingId: number | null) => ipcRenderer.send('meeting:live', meetingId),
  getHudState: (): Promise<{ meetingId: number | null; script: string }> => ipcRenderer.invoke('hud:state'),
  setHudInteractive: (on: boolean) => ipcRenderer.send('hud:interactive', !!on),
  onHudMeeting: (cb: (id: number) => void) => subscribe('hud:meeting', cb),
  onHudScript: (cb: (s: string) => void) => subscribe('hud:script', cb),
  onHudCommand: (cb: (c: HudCommand) => void) => subscribe('hud:command', cb),
  // Teleprompter (main window side)
  openPrompter: (payload: unknown) => ipcRenderer.send('prompter:open', payload),
  updatePrompterSettings: (settings: unknown) => ipcRenderer.send('prompter:settings', settings),
  stopPrompter: () => ipcRenderer.send('prompter:stop'),
  isPrompterOpen: (): Promise<boolean> => ipcRenderer.invoke('prompter:open?'),
  onPrompterClosed: (cb: () => void) => subscribe('prompter:closed', cb),
  onPrompterRunSaved: (cb: (scriptId: number) => void) => subscribe('prompter:run-saved', cb),
  // Teleprompter (prompter window side)
  getPrompterState: (): Promise<unknown> => ipcRenderer.invoke('prompter:state'),
  onPrompterLoad: (cb: (p: unknown) => void) => subscribe('prompter:load', cb),
  onPrompterSettings: (cb: (s: unknown) => void) => subscribe('prompter:settings', cb),
  onPrompterMeeting: (cb: (id: number | null) => void) => subscribe('prompter:meeting', cb),
  onPrompterCommand: (cb: (c: string) => void) => subscribe('prompter:command', cb),
  onPrompterNotice: (cb: (msg: string) => void) => subscribe('prompter:notice', cb),
  setPrompterInteractive: (on: boolean) => ipcRenderer.send('prompter:interactive', !!on),
  prompterRunSaved: (scriptId: number) => ipcRenderer.send('prompter:run-saved', scriptId),
  advanceSlide: () => ipcRenderer.send('prompter:slide'),
  closePrompter: () => ipcRenderer.send('prompter:close'),
})
