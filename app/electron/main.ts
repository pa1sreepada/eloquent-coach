import { app, BrowserWindow, globalShortcut } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registerHudIpc, unregisterHudShortcuts } from './hudWindow'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)


// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.cjs
// │
const DIST = path.join(__dirname, '../dist')
const VITE_PUBLIC = app.isPackaged ? DIST : path.join(DIST, '../public')
process.env.DIST = DIST
process.env.VITE_PUBLIC = VITE_PUBLIC

import { spawn, type ChildProcess } from 'node:child_process'

let win: BrowserWindow | null = null
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const APP_NAME = 'Second Chair'
app.setName(APP_NAME)
let backendProcess: ChildProcess | null = null

// venv layout differs per OS; ELOQUENT_PYTHON overrides (e.g. a conda/pyenv interpreter).
function resolvePython(backendDir: string): string {
  if (process.env.ELOQUENT_PYTHON) return process.env.ELOQUENT_PYTHON
  const venv = path.join(backendDir, 'venv')
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python')
}

function startPythonBackend() {
  if (backendProcess && backendProcess.exitCode === null) return
  const backendDir = app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '../../backend')
  const pythonPath = resolvePython(backendDir)
  const scriptPath = path.join(backendDir, 'main.py')
  if (!fs.existsSync(pythonPath)) {
    console.error(`Python backend not found at ${pythonPath}. Run "python3 scripts/setup.py" from the repo root.`)
    return
  }

  console.log('Starting Python backend at:', scriptPath)
  
  backendProcess = spawn(pythonPath, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000'], {
    cwd: path.dirname(scriptPath),
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  })
  backendProcess.on('exit', () => { backendProcess = null })
  
  backendProcess.stdout?.on('data', (data) => {
    console.log(`Backend: ${data}`)
  })
  
  backendProcess.stderr?.on('data', (data) => {
    const message = data.toString()
    if (message.includes('ERROR') || message.includes('CRITICAL')) {
      console.error(`Backend Error: ${message}`)
    } else {
      console.log(`Backend: ${message}`)
    }
  })
}

function createWindow() {
  win = new BrowserWindow({
    title: APP_NAME,
    icon: path.join(VITE_PUBLIC, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
    width: 1200,
    height: 800,
    titleBarStyle: 'hiddenInset', // Mac OS typical window style
  })

  // Start the python backend when the window is created
  startPythonBackend()

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(DIST, 'index.html'))
  }
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (backendProcess) {
    backendProcess.kill()
  }
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('will-quit', () => {
  unregisterHudShortcuts()
  globalShortcut.unregisterAll()
})

app.on('before-quit', () => {
  if (backendProcess) {
    backendProcess.kill()
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  // Packaged builds take the dock icon from the .icns; `npm run dev` would otherwise show Electron's.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(VITE_PUBLIC, 'icon.png'))
  registerHudIpc(path.join(__dirname, 'preload.cjs'), VITE_DEV_SERVER_URL, DIST)
  createWindow()
})
