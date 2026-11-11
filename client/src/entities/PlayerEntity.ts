import Phaser from 'phaser';
import { tileToWorld, type IsoGeometry } from '@starmemory/shared';
import { PLAYER_FRAME, TEXTURE } from '../assets';
import { HpBar } from './HpBar';

/** 玩家圖的放大倍率 */
const PLAYER_SCALE = 1.5;
/** 名牌與對話泡泡的繪製深度（永遠在場景物件之上） */
const LABEL_DEPTH = 900000;
/** 位置停止變化多久後才切回待機動作（毫秒），避免動畫在走路與待機之間閃爍 */
const IDLE_GRACE_MS = 120;
/** 對話泡泡顯示時間（毫秒） */
const BUBBLE_MS = 4000;

const ANIM = {
  idleFront: 'player_idle_front',
  idleBack: 'player_idle_back',
  walkFront: 'player_walk_front',
  walkBack: 'player_walk_back',
} as const;

/** 建立玩家動畫。動畫是全域的，場景重啟時不需要重複建立。 */
function ensurePlayerAnims(scene: Phaser.Scene): void {
  const anims = scene.anims;
  if (anims.exists(ANIM.idleFront)) {
    return;
  }
  anims.create({ key: ANIM.idleFront, frames: [{ key: TEXTURE.player, frame: 0 }] });
  anims.create({ key: ANIM.idleBack, frames: [{ key: TEXTURE.player, frame: 3 }] });
  anims.create({
    key: ANIM.walkFront,
    frames: anims.generateFrameNumbers(TEXTURE.player, { frames: [1, 0, 2, 0] }),
    frameRate: 8,
    repeat: -1,
  });
  anims.create({
    key: ANIM.walkBack,
    frames: anims.generateFrameNumbers(TEXTURE.player, { frames: [4, 3, 5, 3] }),
    frameRate: 8,
    repeat: -1,
  });
}

/** 畫面上的一位玩家：角色圖、名牌、對話泡泡。自己與其他玩家共用這個類別。 */
export class PlayerEntity {
  readonly sprite: Phaser.GameObjects.Sprite;
  private readonly label: Phaser.GameObjects.Text;
  private bubble: Phaser.GameObjects.Text | null = null;
  private bubbleTimer: Phaser.Time.TimerEvent | null = null;
  private readonly hpBar: HpBar;
  private dead = false;
  private facingBack = false;
  private lastMovedAt = -Infinity;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly geo: IsoGeometry,
    name: string,
    level: number,
    tileX: number,
    tileY: number,
    isLocal: boolean,
  ) {
    ensurePlayerAnims(scene);
    const pos = tileToWorld(tileX, tileY, geo);
    this.sprite = scene.add
      .sprite(pos.x, pos.y, TEXTURE.player, 0)
      .setOrigin(0.5, PLAYER_FRAME.footY / PLAYER_FRAME.height)
      .setScale(PLAYER_SCALE)
      .setDepth(pos.y);
    this.sprite.play(ANIM.idleFront);

    this.label = scene.add
      .text(pos.x, pos.y, '', {
        fontSize: '13px',
        color: isLocal ? '#ffe98a' : '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0)
      .setDepth(LABEL_DEPTH);
    this.hpBar = new HpBar(scene, 36, 0x58c46a, LABEL_DEPTH);
    this.hpBar.setVisible(false);
    this.setInfo(name, level);
    this.layout();
  }

  /** 更新名牌上的等級與名稱 */
  setInfo(name: string, level: number): void {
    const text = `Lv.${level} ${name}`;
    if (this.label.text !== text) {
      this.label.setText(text);
    }
  }

  /** 設定位置（格座標），並依移動方向更新面向 */
  setTilePosition(tileX: number, tileY: number): void {
    const pos = tileToWorld(tileX, tileY, this.geo);
    const dx = pos.x - this.sprite.x;
    const dy = pos.y - this.sprite.y;
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
      return;
    }
    // 往畫面上方走顯示背面，往左走水平翻轉
    if (Math.abs(dy) > 0.01) {
      this.facingBack = dy < 0;
    }
    if (Math.abs(dx) > 0.01) {
      this.sprite.setFlipX(dx < 0);
    }
    this.sprite.setPosition(pos.x, pos.y).setDepth(pos.y);
    this.lastMovedAt = this.scene.time.now;
    this.layout();
  }

  /** 更新血條（滿血時不顯示）與倒地狀態 */
  setHp(hp: number, maxHp: number): void {
    this.hpBar.set(hp, maxHp);
    this.hpBar.setVisible(hp < maxHp && hp > 0);
    const dead = hp <= 0;
    if (dead !== this.dead) {
      this.dead = dead;
      // 倒地：角色躺平並變半透明
      this.sprite.setAngle(dead ? 90 : 0).setAlpha(dead ? 0.6 : 1);
    }
  }

  /** 受擊時閃紅 */
  flash(): void {
    this.sprite.setTint(0xff8080);
    this.scene.time.delayedCall(100, () => this.sprite.clearTint());
  }

  /** 每一幀呼叫：依是否正在移動切換動畫 */
  updateAnimation(): void {
    if (this.dead) {
      this.sprite.play(ANIM.idleFront, true);
      return;
    }
    const moving = this.scene.time.now - this.lastMovedAt < IDLE_GRACE_MS;
    const key = moving
      ? this.facingBack
        ? ANIM.walkBack
        : ANIM.walkFront
      : this.facingBack
        ? ANIM.idleBack
        : ANIM.idleFront;
    this.sprite.play(key, true);
  }

  /** 在頭上顯示對話泡泡 */
  say(text: string): void {
    this.bubbleTimer?.remove();
    this.bubble?.destroy();
    this.bubble = this.scene.add
      .text(0, 0, text, {
        fontSize: '13px',
        color: '#1a1a1a',
        backgroundColor: 'rgba(255,255,255,0.92)',
        padding: { x: 6, y: 4 },
        wordWrap: { width: 180, useAdvancedWrap: true },
      })
      .setOrigin(0.5, 1)
      .setDepth(LABEL_DEPTH + 1);
    this.layout();
    this.bubbleTimer = this.scene.time.delayedCall(BUBBLE_MS, () => {
      this.bubble?.destroy();
      this.bubble = null;
    });
  }

  /** 名牌放在腳下，對話泡泡放在頭上 */
  private layout(): void {
    const { x, y } = this.sprite;
    this.label.setPosition(x, y + 4);
    this.hpBar.setPosition(x, y - PLAYER_FRAME.footY * PLAYER_SCALE - 2);
    this.bubble?.setPosition(x, y - PLAYER_FRAME.footY * PLAYER_SCALE - 10);
  }

  destroy(): void {
    this.bubbleTimer?.remove();
    this.bubble?.destroy();
    this.hpBar.destroy();
    this.label.destroy();
    this.sprite.destroy();
  }
}
