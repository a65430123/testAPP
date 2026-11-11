import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { WorldScene } from './scenes/WorldScene';
import { ChatBox } from './ui/chat';
import { showLogin } from './ui/login';
import { REGISTRY } from './assets';

// 遊戲進入點：先登入，成功後才建立 Phaser 遊戲實例
const session = await showLogin();
const chat = new ChatBox();

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#1b2a22',
  pixelArt: true,
  // 本遊戲不使用鍵盤操作角色；關閉 Phaser 的鍵盤處理，避免干擾聊天輸入
  input: { keyboard: false },
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: '100%',
    height: '100%',
  },
  callbacks: {
    // 把登入資訊與聊天視窗放進全域登錄表，讓各場景取用
    preBoot: (g) => {
      g.registry.set(REGISTRY.session, session);
      g.registry.set(REGISTRY.chat, chat);
    },
  },
  scene: [BootScene, WorldScene],
});

// 開發模式下把遊戲實例掛到 window，方便在主控台除錯
if (import.meta.env.DEV) {
  (window as unknown as { __game: Phaser.Game }).__game = game;
}
