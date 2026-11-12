import { fileURLToPath } from 'node:url';
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
    // 兩個頁面：遊戲本體與管理後台
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
    },
  },
});
