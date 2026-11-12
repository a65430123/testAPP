import Phaser from 'phaser';
import { tileToWorld, type IsoGeometry, type NpcDef } from '@starmemory/shared';
import { PLAYER_FRAME, TEXTURE } from '../assets';
import { ENTITY_KEY, ENTITY_KIND } from './MonsterEntity';

/** 各種 NPC 的佔位顏色（沿用玩家的圖，染色區分） */
const NPC_TINT: Record<NpcDef['type'], number> = {
  talk: 0xc8ffb0,
  shop: 0xffd98a,
  refine: 0xff9c8a,
  storage: 0x9cd0ff,
};

/** 畫面上的一位 NPC：站著不動，點擊後開啟對應的視窗 */
export class NpcEntity {
  readonly sprite: Phaser.GameObjects.Sprite;
  private readonly label: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, geo: IsoGeometry, def: NpcDef, tileX: number, tileY: number) {
    const pos = tileToWorld(tileX, tileY, geo);
    this.sprite = scene.add
      .sprite(pos.x, pos.y, TEXTURE.player, 0)
      .setOrigin(0.5, PLAYER_FRAME.footY / PLAYER_FRAME.height)
      .setScale(1.5)
      .setTint(NPC_TINT[def.type])
      .setDepth(pos.y)
      .setInteractive({ useHandCursor: true });
    this.sprite.setData(ENTITY_KIND, 'npc').setData(ENTITY_KEY, def.id);
    this.label = scene.add
      .text(pos.x, pos.y + 4, def.name, {
        fontSize: '13px',
        color: '#b8ffb0',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0)
      .setDepth(900000);
  }

  destroy(): void {
    this.label.destroy();
    this.sprite.destroy();
  }
}
