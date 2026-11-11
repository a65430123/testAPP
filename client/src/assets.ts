// 資源鍵值與路徑集中管理，之後換成正式美術只需改這裡與圖檔

import { getMapProperty, type TiledMap } from '@starmemory/shared';
import c01Json from '@starmemory/shared/maps/c01_dawnsprout_town.json';
import f01Json from '@starmemory/shared/maps/f01_sprout_meadow.json';

export const TEXTURE = {
  ground: 'tileset_ground',
  props: 'tileset_props',
  player: 'player',
  monsters: 'monsters',
  drop: 'drop',
} as const;

export const TEXTURE_URL = {
  ground: 'assets/tilesets/ground.png',
  props: 'assets/tilesets/props.png',
  player: 'assets/sprites/player.png',
  monsters: 'assets/sprites/monsters.png',
  drop: 'assets/sprites/drop.png',
} as const;

/** 玩家圖集每格大小與腳底在格內的位置（用來對齊地面） */
export const PLAYER_FRAME = { width: 32, height: 48, footY: 44 } as const;

/** 魔物圖集每格大小與腳底在格內的位置 */
export const MONSTER_FRAME = { width: 48, height: 48, footY: 42 } as const;

/** Phaser 全域登錄表（registry）使用的鍵 */
export const REGISTRY = {
  session: 'session',
  chat: 'chat',
  inventory: 'inventory',
  status: 'status',
  skills: 'skills',
} as const;

/** 地圖資料（Tiled JSON），以地圖代號為鍵。新增地圖時在這裡加一行。 */
export const MAPS: Record<string, TiledMap> = {
  C01: c01Json as unknown as TiledMap,
  F01: f01Json as unknown as TiledMap,
};

/** 地圖的顯示名稱；找不到時回傳代號本身 */
export function mapDisplayName(mapId: string): string {
  const map = MAPS[mapId];
  return (map && getMapProperty(map, 'displayName')) ?? mapId;
}
