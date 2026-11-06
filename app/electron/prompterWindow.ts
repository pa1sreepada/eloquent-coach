import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { liveMeetingId, onLiveMeetingChange } from './hudWindow'

// Voice-following teleprompter: a floating, click-through window just under the camera (like the HUD),
// hidden from screen share. The window renders `#prompter` and pulls its script from here on load.
interface Payload {
  scriptId: number | null
  title: string
  content: string
  targetWpm: number
  settings: { width: number; height: number; advanceSlides?: boolean } & Record<string, unknown>
  meetingId?: number | null
}

let win: BrowserWindow | null = null
let state: Payload | null = null
let closeTimer: NodeJS.Timeout | null = null

const SHORTCUTS: Record<string, string> = {
  'Alt+CommandOrControl+P': 'pause',
  'Alt+CommandOrControl+Up': 'prev',
  'Alt+CommandOrControl+Down': 'next',
}

const clampInt = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d

function cameraDisplay() {
  return screen.getAllDisplays().find(d => d.internal) ?? screen.getPrimaryDisplay()
}

function place() {
  if (!win || win.isDestroyed() || !state) return
  const { workArea } = cameraDisplay()
  const width = Math.min(workArea.width, clampInt(state.settings.width, 420, 1400, 760))
  const height = Math.min(workArea.height, clampInt(state.settings.height, 160, 800, 280))
  win.setBounds({ x: Math.round(workArea.x + (workArea.width - width) / 2), y: workArea.y + 4, width, height })
}

function create(preload: string, devUrl: string | undefined, distDir: string) {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    width: 760, height: 280,
    transparent: true, frame: false, hasShadow: false, resizable: false,
    focusable: false,            // never steals focus from Zoom/Keynote while I read
    skipTaskbar: true, show: false,
    backgroundColor: '#00000000',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setContentProtection(true)                // invisible to screen share and recordings
  win.setIgnoreMouseEvents(true, { forward: true })
  if (devUrl) void win.loadURL(`${devUrl}#prompter`)
  else void win.loadFile(path.join(distDir, 'index.html'), { hash: 'prompter' })
  win.on('closed', () => {
    win = null
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    unregisterShortcuts()
    broadcast('prompter:closed')
  })
  return win
}

const send = (ch: string, ...args: unknown[]) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...args) }

/** Tell every other window (the main app) — e.g. to refresh rehearsal history. */
function broadcast(ch: string, ...args: unknown[]) {
  for (const w of BrowserWindow.getAllWindows()) if (w !== win && !w.isDestroyed()) w.webContents.send(ch, ...args)
}

function registerShortcuts() {
  for (const [acc, cmd] of Object.entries(SHORTCUTS)) {
    if (!globalShortcut.isRegistered(acc)) globalShortcut.register(acc, () => send('prompter:command', cmd))
  }
}
function unregisterShortcuts() {
  for (const acc of Object.keys(SHORTCUTS)) globalShortcut.unregister(acc)
}

function parsePayload(p: unknown): Payload | null {
  if (!p || typeof p !== 'object') return null
  const o = p as Record<string, unknown>
  if (typeof o.content !== 'string' || !o.content.trim() || !o.settings || typeof o.settings !== 'object') return null
  return {
    scriptId: typeof o.scriptId === 'number' ? o.scriptId : null,
    title: typeof o.title === 'string' ? o.title.slice(0, 200) : '',
    content: o.content.slice(0, 200_000),
    targetWpm: clampInt(o.targetWpm, 60, 260, 150),
    settings: o.settings as Payload['settings'],
  }
}

/** Right-arrow in the front app (Keynote, PowerPoint, Slides). macOS asks once for Accessibility permission. */
function advanceSlide() {
  if (process.platform !== 'darwin' || !state?.settings.advanceSlides) return
  execFile('osascript', ['-e', 'tell application "System Events" to key code 124'], (err) => {
    if (err) send('prompter:notice', 'Couldn’t advance the slide. Allow Second Chair under System Settings → Privacy & Security → Accessibility.')
  })
}

export function registerPrompterIpc(preload: string, devUrl: string | undefined, distDir: string) {
  ipcMain.handle('prompter:state', () => state)
  ipcMain.on('prompter:open', (_e, payload: unknown) => {
    const p = parsePayload(payload)
    if (!p) return
    state = { ...p, meetingId: liveMeetingId() }
    const w = create(preload, devUrl, distDir)
    place()
    send('prompter:load', state)
    w.showInactive()
    registerShortcuts()
  })
  ipcMain.on('prompter:settings', (_e, settings: unknown) => {
    if (!state || !settings || typeof settings !== 'object') return
    state = { ...state, settings: settings as Payload['settings'] }
    place()
    send('prompter:settings', state.settings)
  })
  // Ask the window to save its read-through, then close (forced if it doesn't answer).
  ipcMain.on('prompter:stop', () => {
    if (!win) return
    send('prompter:command', 'finish')
    closeTimer = setTimeout(() => win?.destroy(), 2500)
  })
  ipcMain.on('prompter:close', () => { win?.destroy() })
  ipcMain.on('prompter:interactive', (_e, on: unknown) => { win?.setIgnoreMouseEvents(!on, { forward: true }) })
  ipcMain.on('prompter:run-saved', (_e, scriptId: unknown) => {
    if (typeof scriptId === 'number') broadcast('prompter:run-saved', scriptId)
  })
  ipcMain.on('prompter:slide', advanceSlide)
  ipcMain.handle('prompter:open?', () => !!win)
  // Start/end of a meeting while the prompter is up: follow the meeting's mic instead of opening a second one.
  onLiveMeetingChange((id) => {
    if (state) state = { ...state, meetingId: id }
    send('prompter:meeting', id)
  })
  screen.on('display-added', place)
  screen.on('display-removed', place)
  screen.on('display-metrics-changed', place)
}

export function unregisterPrompterShortcuts() { unregisterShortcuts() }
