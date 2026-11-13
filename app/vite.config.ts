import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import type { Plugin } from 'vite'

// Packaged builds only: the dev server needs inline scripts for hot reload. The renderer may only
// load its own bundle and talk to the local backend, so injected content can't exfiltrate transcripts.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' http://127.0.0.1:8000 ws://127.0.0.1:8000",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const contentSecurityPolicy = (): Plugin => ({
  name: 'content-security-policy',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    contentSecurityPolicy(),
    react(),
    electron([
      {
        entry: 'electron/main.ts',
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload()
        },
        // Electron sandboxes preloads, and sandboxed preloads can't use ES `import`; without CommonJS
        // `window.eloquent` is never defined and the HUD button stays disabled.
        // (package.json is "type": "module", so the plugin would otherwise emit ESM).
        vite: {
          build: {
            lib: false,
            rolldownOptions: {
              input: 'electron/preload.ts',
              output: { format: 'cjs', entryFileNames: 'preload.cjs' },
            },
          },
        },
      },
    ]),
    renderer(),
  ],
})
