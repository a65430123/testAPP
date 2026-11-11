/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 遊戲伺服器位址，例如 https://game.example.com；未設定時使用目前網域的 2567 埠 */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
