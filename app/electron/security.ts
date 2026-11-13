import { app, ipcMain, session, shell, type WebContents } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Per-launch secret the backend requires on every request (see backend/api_auth.py). It reaches the
// backend via its environment and the owner-only token file, and the renderer via the preload.
export const API_TOKEN = crypto.randomBytes(32).toString('hex')

export function writeApiTokenFile() {
  const dir = process.env.ELOQUENT_STATE_DIR || path.join(os.homedir(), '.eloquent-coach')
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, 'api-token')
    fs.writeFileSync(file, API_TOKEN, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
  } catch (err) {
    console.error('Could not write the API token file; a manually started backend will reject the app.', err)
  }
}

export function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_TOKEN}` }
}

let devOrigin: string | null = null
let distPrefix = ''

/** True for the app's own pages: the Vite dev server, or the bundled index.html. */
export function isAppUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    if (devOrigin) return u.origin === devOrigin
    return u.protocol === 'file:' && u.href.startsWith(distPrefix)
  } catch {
    return false
  }
}

function openExternally(url: string) {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'https:' || protocol === 'mailto:') void shell.openExternal(url)
  } catch { /* not a URL */ }
}

function hardenContents(contents: WebContents) {
  // No new windows or in-app navigation away from the app; vetted links open in the default browser/mail app.
  contents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openExternally(url)
  })
  contents.on('will-attach-webview', event => event.preventDefault())
}

const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'])

export function applySecurityPolicy(devUrl: string | undefined, distDir: string) {
  devOrigin = devUrl ? new URL(devUrl).origin : null
  distPrefix = pathToFileURL(distDir + path.sep).href

  app.on('web-contents-created', (_e, contents) => hardenContents(contents))

  const ses = session.defaultSession
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl || contents.getURL()))
  })
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    ALLOWED_PERMISSIONS.has(permission) &&
    (isAppUrl(details.requestingUrl) || isAppUrl(requestingOrigin) || requestingOrigin === 'file://'))

  // Only app pages may read the token.
  ipcMain.on('api:token', event => {
    event.returnValue = isAppUrl(event.senderFrame?.url) ? API_TOKEN : ''
  })
}
