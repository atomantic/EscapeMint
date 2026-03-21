import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig(({ mode }) => ({
  plugins: [react()],

  // GitHub Pages base path for production, root for development
  // Deployed at https://atomantic.github.io/EscapeMint/
  base: mode === 'production' ? '/EscapeMint/' : '/',

  resolve: {
    alias: {
      // Import engine directly (zero deps, browser-compatible)
      '@escapemint/engine': resolve(__dirname, '../packages/engine/src/index.ts'),
      // Import shared components from web package
      '~web': resolve(__dirname, '../packages/web/src')
    }
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,

    rollupOptions: {
      // Bundle everything (no external dependencies)
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/') || id.includes('node_modules/d3')) return 'vendor'
        }
      }
    }
  },

  // Development server
  // Port configured in ecosystem.config.cjs (PORTS.PAGES = 5561)
  server: {
    port: 5561,
    open: false  // PM2 manages startup, don't auto-open browser
  }
}))
