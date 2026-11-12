import Phaser from 'phaser';
import { tileToWorld, type IsoGeometry, type MonsterDef } from '@starmemory/shared';
import { MONSTER_FRAME, TEXTURE } from '../assets';
import { HpBar } from './HpBar';

const LABEL_DEPTH = 900000;
/** 滑鼠點擊時用來辨識物件種類的資料鍵 */
export const ENTITY_KIND = 'kind';
export const ENTITY_KEY = 'key';

/** 畫面上的一隻魔物：圖、名稱、血條。可以點擊選為攻擊目標。 */
export class MonsterEntity {
  readonly sprite: Phaser.GameObjects.Sprite;
  private readonly label: Phaser.GameObjects.Text;
  private readonly hpBar: HpBar;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly geo: IsoGeometry,
    key: string,
    readonly def: MonsterDef,
    tileX: number,
    tileY: number,
  ) {
    const pos = tileToWorld(tileX, tileY, geo);
    this.sprite = scene.add
      .sprite(pos.x, pos.y, TEXTURE.monsters, def.sprite)
      .setOrigin(0.5, MONSTER_FRAME.footY / MONSTER_FRAME.height)
      .setScale(def.scale ?? 1)
      .setDepth(pos.y)
      .setInteractive({ useHandCursor: true });
    this.sprite.setData(ENTITY_KIND, 'monster').setData(ENTITY_KEY, key);

    this.label = scene.add
      .text(pos.x, pos.y, `Lv.${def.level} ${def.name}`, {
        fontSize: '12px',
        // 會主動攻擊的魔物用紅色名稱提醒
        color: def.aggressive ? '#ff9a8a' : '#e8f0e8',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0)
      .setDepth(LABEL_DEPTH);
    // 首領的名稱用金色、血條加寬
    if (def.tier === 'boss') {
      this.label.setColor('#ffd23f').setFontSize(14);
    }
    this.hpBar = new HpBar(scene, def.tier === 'boss' ? 80 : 36, 0xe8554e, LABEL_DEPTH);
    this.hpBar.setVisible(false);
    this.layout();

    // 出現時淡入
    this.sprite.setAlpha(0);
    scene.tweens.add({ targets: this.sprite, alpha: 1, duration: 300 });
  }

  setTilePosition(tileX: number, tileY: number): void {
    const pos = tileToWorld(tileX, tileY, this.geo);
    const dx = pos.x - this.sprite.x;
    if (Math.abs(dx) > 0.01) {
      this.sprite.setFlipX(dx < 0);
    }
    this.sprite.setPosition(pos.x, pos.y).setDepth(pos.y);
    this.layout();
  }

  /** 更新血條；滿血時不顯示 */
  setHp(hp: number, maxHp: number): void {
    this.hpBar.set(hp, maxHp);
    this.hpBar.setVisible(hp < maxHp);
  }

  /** 受擊時閃一下 */
  flash(): void {
    this.sprite.setTintFill(0xffffff);
    this.scene.time.delayedCall(80, () => this.sprite.clearTint());
  }

  private layout(): void {
    const { x, y } = this.sprite;
    this.label.setPosition(x, y + 4);
    this.hpBar.setPosition(x, y - MONSTER_FRAME.footY * (this.def.scale ?? 1) - 6);
  }

  destroy(): void {
    this.hpBar.destroy();
    this.label.destroy();
    this.sprite.destroy();
  }
}
