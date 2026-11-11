// Tiled JSON 地圖的型別與解析（只涵蓋本專案用到的欄位）

import { MAP_LAYER } from './constants';
import type { IsoGeometry, Point } from './iso';

export interface TiledProperty {
  name: string;
  type: string;
  value: unknown;
}

export interface TiledTileDef {
  id: number;
  properties?: TiledProperty[];
}

export interface TiledTileset {
  firstgid: number;
  name: string;
  image: string;
  imagewidth: number;
  imageheight: number;
  tilewidth: number;
  tileheight: number;
  tilecount: number;
  columns: number;
  margin: number;
  spacing: number;
  tiles?: TiledTileDef[];
}

export interface TiledObject {
  id: number;
  name: string;
  type?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  point?: boolean;
  properties?: TiledProperty[];
}

export interface TiledTileLayer {
  type: 'tilelayer';
  id: number;
  name: string;
  width: number;
  height: number;
  data: number[];
  visible: boolean;
  opacity: number;
  x: number;
  y: number;
}

export interface TiledObjectLayer {
  type: 'objectgroup';
  id: number;
  name: string;
  objects: TiledObject[];
  visible: boolean;
  opacity: number;
  x: number;
  y: number;
}

export type TiledLayer = TiledTileLayer | TiledObjectLayer;

export interface TiledMap {
  type: 'map';
  orientation: string;
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
  tilesets: TiledTileset[];
}

/** Tiled 用 gid 的最高 3 個位元記錄翻轉旗標，取圖磚編號前要先遮掉 */
const GID_MASK = 0x1fffffff;

/** 碰撞格：blocked[y * width + x] === 1 表示不可行走 */
export interface CollisionGrid {
  width: number;
  height: number;
  blocked: Uint8Array;
}

export function mapGeometry(map: TiledMap): IsoGeometry {
  return { tileWidth: map.tilewidth, tileHeight: map.tileheight };
}

export function getTileLayer(map: TiledMap, name: string): TiledTileLayer | undefined {
  const layer = map.layers.find((l) => l.name === name);
  return layer && layer.type === 'tilelayer' ? layer : undefined;
}

export function getObjectLayer(map: TiledMap, name: string): TiledObjectLayer | undefined {
  const layer = map.layers.find((l) => l.name === name);
  return layer && layer.type === 'objectgroup' ? layer : undefined;
}

export function getTileset(map: TiledMap, name: string): TiledTileset | undefined {
  return map.tilesets.find((t) => t.name === name);
}

/** 去掉翻轉旗標後的 gid（0 表示該格沒有圖磚） */
export function cleanGid(gid: number): number {
  return gid & GID_MASK;
}

/** 找出 gid 所屬的圖磚集 */
export function tilesetForGid(map: TiledMap, gid: number): TiledTileset | undefined {
  const id = cleanGid(gid);
  let found: TiledTileset | undefined;
  for (const ts of map.tilesets) {
    if (id >= ts.firstgid && id < ts.firstgid + ts.tilecount) {
      found = ts;
    }
  }
  return found;
}

/** 收集所有帶有 blocked=true 屬性的 gid */
function collectBlockedGids(map: TiledMap): Set<number> {
  const result = new Set<number>();
  for (const ts of map.tilesets) {
    for (const tile of ts.tiles ?? []) {
      const blocked = tile.properties?.some((p) => p.name === 'blocked' && p.value === true);
      if (blocked) {
        result.add(ts.firstgid + tile.id);
      }
    }
  }
  return result;
}

/**
 * 由 Tiled 地圖建立碰撞格。規則：
 * 1. ground 層：圖磚屬性 blocked=true 或沒有圖磚的格子不可行走
 * 2. props 層：只要有圖磚就不可行走
 */
export function buildCollisionGrid(map: TiledMap): CollisionGrid {
  const { width, height } = map;
  const blocked = new Uint8Array(width * height);
  const blockedGids = collectBlockedGids(map);

  const ground = getTileLayer(map, MAP_LAYER.ground);
  if (!ground) {
    throw new Error(`地圖缺少圖磚層：${MAP_LAYER.ground}`);
  }
  for (let i = 0; i < width * height; i++) {
    const gid = cleanGid(ground.data[i] ?? 0);
    if (gid === 0 || blockedGids.has(gid)) {
      blocked[i] = 1;
    }
  }

  const props = getTileLayer(map, MAP_LAYER.props);
  if (props) {
    for (let i = 0; i < width * height; i++) {
      if (cleanGid(props.data[i] ?? 0) !== 0) {
        blocked[i] = 1;
      }
    }
  }

  return { width, height, blocked };
}

export function inBounds(grid: CollisionGrid, tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < grid.width && ty < grid.height;
}

export function isWalkable(grid: CollisionGrid, tx: number, ty: number): boolean {
  return inBounds(grid, tx, ty) && grid.blocked[ty * grid.width + tx] === 0;
}

/**
 * 找出指定名稱的出生點，回傳格座標（浮點數）。
 * Tiled 斜視角地圖的物件座標以「tileheight 像素 = 1 格」計算。
 */
export function findSpawn(map: TiledMap, name: string): Point | undefined {
  const layer = getObjectLayer(map, MAP_LAYER.spawns);
  const obj = layer?.objects.find((o) => o.name === name);
  if (!obj) {
    return undefined;
  }
  return { x: obj.x / map.tileheight, y: obj.y / map.tileheight };
}
