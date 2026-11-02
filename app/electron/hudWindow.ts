import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import path from 'node:path'

let hud: BrowserWindow | null = null
// Last meeting/script shown; the HUD page pulls this on load (its React bundle loads lazily and can miss pushes).
let state: { meetingId: number | null; script: string } = { meetingId: null, script: '' }

const WIDTH = 600
const HEIGHT = 340

// The built-in display hosts the camera, so the HUD sits just below it; fall back to the primary display.
function cameraDisplay() {
  return screen.getAllDisplays().find(d => d.internal) ?? screen.getPrimaryDisplay()
}

function placeHud() {
  if (!hud || hud.isDestroyed()) return
  const { workArea } = cameraDisplay()   // workArea starts below the menu bar (and the notch)
  hud.setBounds({ x: Math.round(workArea.x + (workArea.width - WIDTH) / 2), y: workArea.y + 4, width: WIDTH, height: HEIGHT })
}

export function createHudWindow(preload: string, devUrl: string | undefined, distDir: string) {
  if (hud && !hud.isDestroyed()) return hud
  hud = new BrowserWindow({
    width: WIDTH, height: HEIGHT,
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
  ipcMain.handle('hud:state', () => state)
  ipcMain.on('hud:show', (_e, meetingId: unknown, script: unknown) => {
    if (typeof meetingId !== 'number') return
    state = { meetingId, script: typeof script === 'string' ? script : '' }
    const w = createHudWindow(preload, devUrl, distDir)
    placeHud()
    send('hud:meeting', meetingId)
    if (state.script) send('hud:script', state.script)
    w.showInactive()
    registerHudShortcuts()
  })
  ipcMain.on('hud:hide', () => { hud?.hide(); unregisterHudShortcuts() })
  ipcMain.on('hud:interactive', (_e, on: unknown) => {
    hud?.setIgnoreMouseEvents(!on, { forward: true })
  })
  // Follow the camera display when monitors are plugged/unplugged or resolution changes.
  screen.on('display-added', placeHud)
  screen.on('display-removed', placeHud)
  screen.on('display-metrics-changed', placeHud)
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
