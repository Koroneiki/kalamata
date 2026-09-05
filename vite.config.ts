import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import vueDevTools from 'vite-plugin-vue-devtools'
import { electrobunViteAliases } from './.hutch/devkit/api/config/electrobun-vite'

export default defineConfig({
  base: './',
  plugins: [tailwindcss(), vue(), vueDevTools()],
  resolve: {
    alias: [
      ...electrobunViteAliases(resolve(import.meta.dirname, '.hutch/devkit')),
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src', import.meta.url)),
      },
    ],
  },
  root: 'src/mainview',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
