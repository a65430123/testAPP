import Phaser from 'phaser';
import { getTileset, MAP_LAYER } from '@starmemory/shared';
import { MAPS, MONSTER_FRAME, PLAYER_FRAME, REGISTRY, TEXTURE, TEXTURE_URL } from '../assets';
import type { Session } from '../net/session';

/** 載入場景：讀取圖檔與所有地圖，完成後進入世界場景 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload(): void {
    const { width, height } = this.scale;
    const label = this.add
      .text(width / 2, height / 2, '載入中… 0%', { fontSize: '20px', color: '#ffffff' })
      .setOrigin(0.5);
    this.load.on('progress', (value: number) => {
      label.setText(`載入中… ${Math.round(value * 100)}%`);
    });

    // 所有地圖共用同一套圖磚集，取任一張地圖的設定即可
    const anyMap = Object.values(MAPS)[0]!;
    const propsTileset = getTileset(anyMap, MAP_LAYER.props)!;

    this.load.image(TEXTURE.ground, TEXTURE_URL.ground);
    // 物件圖磚集當成圖集載入，每格就是一個立體物件
    this.load.spritesheet(TEXTURE.props, TEXTURE_URL.props, {
      frameWidth: propsTileset.tilewidth,
      frameHeight: propsTileset.tileheight,
    });
    this.load.spritesheet(TEXTURE.player, TEXTURE_URL.player, {
      frameWidth: PLAYER_FRAME.width,
      frameHeight: PLAYER_FRAME.height,
    });
    this.load.spritesheet(TEXTURE.monsters, TEXTURE_URL.monsters, {
      frameWidth: MONSTER_FRAME.width,
      frameHeight: MONSTER_FRAME.height,
    });
    this.load.image(TEXTURE.drop, TEXTURE_URL.drop);
    // 地圖資料已由打包工具內嵌，直接以物件形式交給 Phaser
    for (const [mapId, mapData] of Object.entries(MAPS)) {
      this.load.tilemapTiledJSON(mapId, mapData as unknown as object);
    }
  }

  create(): void {
    const session = this.registry.get(REGISTRY.session) as Session;
    this.scene.start('World', { mapId: session.mapId });
  }
}
