import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { version } from './package.json'

export default defineConfig(({ command }) => ({
  main: {},
  preload: {},
  renderer: {
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [react(), {
      name: 'development-react-csp',
      transformIndexHtml: {
        order: 'post',
        handler: (html) => command === 'serve'
          ? html.replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'")
          : html
      }
    }],
    worker: { format: 'iife' },
    server: { host: '127.0.0.1' }
  }
}))
