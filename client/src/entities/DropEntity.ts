import Phaser from 'phaser';
import { getItemDef, tileToWorld, type IsoGeometry } from '@starmemory/shared';
import { TEXTURE } from '../assets';
import { ENTITY_KEY, ENTITY_KIND } from './MonsterEntity';

/** 地上的掉落物：小袋子圖示與道具名稱。點擊即可撿取。 */
export class DropEntity {
  readonly image: Phaser.GameObjects.Image;
  private readonly label: Phaser.GameObjects.Text;
  /** 位置（格座標） */
  readonly tileX: number;
  readonly tileY: number;

  constructor(scene: Phaser.Scene, geo: IsoGeometry, key: string, itemId: string, tileX: number, tileY: number, mine: boolean) {
    this.tileX = tileX;
    this.tileY = tileY;
    const pos = tileToWorld(tileX, tileY, geo);
    this.image = scene.add
      .image(pos.x, pos.y, TEXTURE.drop)
      .setOrigin(0.5, 0.9)
      .setDepth(pos.y - 1)
      .setInteractive({ useHandCursor: true });
    this.image.setData(ENTITY_KIND, 'drop').setData(ENTITY_KEY, key);
    this.label = scene.add
      .text(pos.x, pos.y - 24, getItemDef(itemId)?.name ?? itemId, {
        fontSize: '12px',
        // 自己的掉落物用亮色，別人的（保護期間撿不到）用灰色
        color: mine ? '#fff3b0' : '#b8b8b8',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(pos.y - 1);

    // 掉落時彈跳一下
    scene.tweens.add({ targets: this.image, y: pos.y - 14, duration: 160, yoyo: true, ease: 'Quad.easeOut' });
  }

  destroy(): void {
    this.label.destroy();
    this.image.destroy();
  }
}
