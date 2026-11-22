import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/frontend'),
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/frontend'),
    emptyOutDir: true,
  },
  server: { port: 5199, strictPort: true },
});
