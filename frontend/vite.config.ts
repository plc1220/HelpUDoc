import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  css: {
    postcss: './postcss.config.js',
  },
  build: {
    modulePreload: false,
    manifest: true,
    rollupOptions: {
      input: {
        main: 'index.html',
      },
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined
          }

          if (id.includes('monaco-editor') || id.includes('@monaco-editor')) {
            return 'monaco'
          }

          if (id.includes('@mdxeditor')) {
            return 'mdxeditor'
          }

          if (id.includes('@hocuspocus') || id.includes('y-monaco') || id.includes('/yjs/')) {
            return 'collab'
          }

          if (id.includes('plotly.js') || id.includes('react-plotly.js')) {
            return 'plotly'
          }

          if (id.includes('mermaid')) {
            return 'mermaid'
          }

          // Let Rollup keep the general React/app dependency graph together.
          // Splitting react-vendor, mui, markdown, and generic vendor apart was
          // creating runtime cycles in production bundles.
          return undefined
        },
      },
    },
  },
})
