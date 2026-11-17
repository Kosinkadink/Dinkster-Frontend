import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  root: 'gallery',
  base: './',
  plugins: [solid()],
  build: { outDir: '../dist/gallery', emptyOutDir: true },
})
