import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [solid({ ssr: true })],
  ssr: { noExternal: ['@dinkster/ui'] },
  base: './',
  build: {
    outDir: isSsrBuild ? 'dist/.callback' : 'dist',
    manifest: !isSsrBuild,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        'account-view': 'src/account.tsx',
        authorization: 'src/authorization.tsx',
        about: 'src/about.tsx',
        'desktop-library': 'src/desktop-library.tsx',
        'desktop-environments': 'src/desktop-environments.tsx',
      },
      preserveEntrySignatures: 'strict',
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
}))
