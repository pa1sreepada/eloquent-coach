import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import path from 'node:path'

let hud: BrowserWindow | null = null

export function createHudWindow(preload: string, devUrl: string | undefined, distDir: string) {
  if (hud && !hud.isDestroyed()) return hud
  const { workArea } = screen.getPrimaryDisplay()
  const width = 600
  hud = new BrowserWindow({
    width, height: 340,
    x: Math.round(workArea.x + (workArea.width - width) / 2), y: workArea.y + 4,
    transparent: true, frame: false, hasShadow: false, resizable: false,
    focusable: false,            // never steals focus from Zoom/Meet/Keynote
    skipTaskbar: true, show: false,
    backgroundColor: '#00000000',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  })
  hud.setAlwaysOnTop(true, 'screen-saver')                       // above full-screen apps
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  hud.setContentProtection(true)                                  // excluded from screen share/recording
  hud.setIgnoreMouseEvents(true, { forward: true })               // click-through; hover re-enables
  if (devUrl) void hud.loadURL(`${devUrl}#hud`)
  else void hud.loadFile(path.join(distDir, 'index.html'), { hash: 'hud' })
  hud.on('closed', () => { hud = null })
  return hud
}

const send = (ch: string, ...args: unknown[]) => hud?.webContents.send(ch, ...args)

export function registerHudIpc(preload: string, devUrl: string | undefined, distDir: string) {
  ipcMain.on('hud:show', (_e, meetingId: unknown, script: unknown) => {
    if (typeof meetingId !== 'number') return
    const w = createHudWindow(preload, devUrl, distDir)
    const push = () => {
      send('hud:meeting', meetingId)
      if (typeof script === 'string' && script) send('hud:script', script)
      w.showInactive()
    }
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', push)
    else push()
    registerHudShortcuts()
  })
  ipcMain.on('hud:hide', () => { hud?.hide(); unregisterHudShortcuts() })
  ipcMain.on('hud:interactive', (_e, on: unknown) => {
    hud?.setIgnoreMouseEvents(!on, { forward: true })
  })
}

const SHORTCUTS: Record<string, () => void> = {
  'CommandOrControl+Shift+H': () => (hud?.isVisible() ? hud.hide() : hud?.showInactive()),
  'CommandOrControl+Shift+Right': () => send('hud:command', 'next'),
  'CommandOrControl+Shift+Left': () => send('hud:command', 'prev'),
  'CommandOrControl+Shift+X': () => send('hud:command', 'dismiss'),
  'CommandOrControl+Shift+L': () => send('hud:command', 'toggleLock'),
}

function registerHudShortcuts() {
  for (const [acc, fn] of Object.entries(SHORTCUTS)) {
    if (!globalShortcut.isRegistered(acc)) globalShortcut.register(acc, fn)
  }
}
export function unregisterHudShortcuts() {
  for (const acc of Object.keys(SHORTCUTS)) globalShortcut.unregister(acc)
}
