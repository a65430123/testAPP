// 資源鍵值與路徑集中管理，之後換成正式美術只需改這裡與圖檔

import type { TiledMap } from '@starmemory/shared';
import f01Json from '@starmemory/shared/maps/f01_sprout_meadow.json';

export const TEXTURE = {
  ground: 'tileset_ground',
  props: 'tileset_props',
  player: 'player',
} as const;

export const TEXTURE_URL = {
  ground: 'assets/tilesets/ground.png',
  props: 'assets/tilesets/props.png',
  player: 'assets/sprites/player.png',
} as const;

/** 玩家圖集每格大小與腳底在格內的位置（用來對齊地面） */
export const PLAYER_FRAME = { width: 32, height: 48, footY: 44 } as const;

/** 地圖資料（Tiled JSON）。目前只有一張，之後改為依地圖代號動態載入。 */
export const MAPS: Record<string, TiledMap> = {
  F01: f01Json as unknown as TiledMap,
};

export const START_MAP_ID = 'F01';
