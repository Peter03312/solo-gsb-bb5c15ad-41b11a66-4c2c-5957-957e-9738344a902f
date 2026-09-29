import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发模式：5173 端口，/ws 代理到 Node 服务端 3000
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
