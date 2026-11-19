import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  base: './',
  build: {
    manifest: true,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        'account-view': 'src/account.tsx',
        authorization: 'src/authorization.tsx',
        about: 'src/about.tsx',
        'desktop-library': 'src/desktop-library.tsx',
      },
      preserveEntrySignatures: 'strict',
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
