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
    rollupOptions: {
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

          if (id.includes('lucide-react')) {
            return 'icons'
          }

          if (id.includes('react-markdown') || id.includes('remark-') || id.includes('rehype-')) {
            return 'markdown'
          }

          if (id.includes('@mui') || id.includes('@emotion')) {
            return 'mui'
          }

          if (id.includes('react') || id.includes('react-router')) {
            return 'react-vendor'
          }

          return 'vendor'
        },
      },
    },
  },
})
