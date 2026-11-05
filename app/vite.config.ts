import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
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
