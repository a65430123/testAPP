import Phaser from 'phaser';
import { getTileset, MAP_LAYER } from '@starmemory/shared';
import { MAPS, PLAYER_FRAME, START_MAP_ID, TEXTURE, TEXTURE_URL } from '../assets';

/** 載入場景：讀取圖檔與地圖，完成後進入世界場景 */
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

    const mapData = MAPS[START_MAP_ID]!;
    const propsTileset = getTileset(mapData, MAP_LAYER.props)!;

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
    // 地圖資料已由打包工具內嵌，直接以物件形式交給 Phaser
    this.load.tilemapTiledJSON(START_MAP_ID, mapData as unknown as object);
  }

  create(): void {
    this.scene.start('World', { mapId: START_MAP_ID });
  }
}
