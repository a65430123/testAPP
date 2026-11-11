import { defineConfig } from 'vite';

// 用戶端建置設定：開發伺服器固定 5173 埠，方便之後 Nginx 反向代理
export default defineConfig({
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
