import Phaser from 'phaser';
import { REGISTRY } from './assets';
import { clearSavedAuth, loadSavedAuth, saveAuth, type Auth, type Session } from './net/session';
import { BootScene } from './scenes/BootScene';
import { WorldScene } from './scenes/WorldScene';
import { showAuth } from './ui/auth';
import { showCharacterSelect } from './ui/characters';
import { ChatBox } from './ui/chat';
import { ItemUi } from './ui/ItemUi';
import { QuestUi } from './ui/quests';
import { SocialUi } from './ui/social';
import { SkillBar } from './ui/skills';
import { StatusPanel } from './ui/status';

/** 登入（或沿用上次保存的憑證）→ 選角，直到取得可以進入遊戲的連線資訊 */
async function obtainSession(): Promise<Session> {
  let auth: Auth | null = loadSavedAuth();
  for (;;) {
    if (!auth) {
      auth = await showAuth();
      saveAuth(auth);
    }
    const choice = await showCharacterSelect(auth);
    if (choice === 'logout') {
      clearSavedAuth();
      auth = null;
      continue;
    }
    return { ...auth, character: choice, mapId: choice.mapId };
  }
}

// 遊戲進入點：先完成登入與選角，才建立 Phaser 遊戲實例
const session = await obtainSession();
const chat = new ChatBox();
const itemUi = new ItemUi();
const socialUi = new SocialUi(session.character.id);
const questUi = new QuestUi();
// NPC 視窗裡的任務區塊由任務介面產生；任務或背包有變動時重畫 NPC 視窗
itemUi.npc.setQuestSection((npc) => questUi.renderForNpc(npc));
questUi.onChange(() => itemUi.npc.refresh());
const status = new StatusPanel(session.character.name, session.character.classId);
const skills = new SkillBar(session.character.classId);

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
    // 把連線資訊與介面元件放進全域登錄表，讓各場景取用
    preBoot: (g) => {
      g.registry.set(REGISTRY.session, session);
      g.registry.set(REGISTRY.chat, chat);
      g.registry.set(REGISTRY.itemUi, itemUi);
      g.registry.set(REGISTRY.socialUi, socialUi);
      g.registry.set(REGISTRY.questUi, questUi);
      g.registry.set(REGISTRY.status, status);
      g.registry.set(REGISTRY.skills, skills);
    },
  },
  scene: [BootScene, WorldScene],
});

// 開發模式下把遊戲實例掛到 window，方便在主控台除錯
if (import.meta.env.DEV) {
  (window as unknown as { __game: Phaser.Game }).__game = game;
}
