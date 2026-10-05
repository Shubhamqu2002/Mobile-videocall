import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'client', plugins: [react()],
  server: { port: 5173, strictPort: true, proxy: {
    '/api': 'http://127.0.0.1:3001',
    '/socket.io': { target: 'http://127.0.0.1:3001', ws: true },
  } },
  build: { outDir: '../dist', emptyOutDir: true },
});
