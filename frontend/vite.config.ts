import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    // Proxy keeps the browser same-origin in dev, so the refresh cookie
    // (path /api/auth, SameSite=Lax) is sent without CORS credential fuss.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // The charting libraries are large and only needed on a few routes.
        // Splitting them keeps the initial bundle small enough that the
        // dashboard paints quickly on a slow connection.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          lightweight: ['lightweight-charts'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
});
