import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: './src/electron-main.ts',
      fileName: () => 'main.js',
      formats: ['cjs'],
    },
    rollupOptions: {
      external: ['electron', 'path', 'fs', 'url'],
    },
    outDir: '.vite/build',
    emptyOutDir: false,
  },
});
