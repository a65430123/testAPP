// 啟動時載入 shared/maps 底下所有 Tiled 地圖，並預先算好碰撞格與傳送點

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildCollisionGrid,
  findPortals,
  findSpawn,
  getMapProperty,
  isWalkable,
  SPAWN_PLAYER,
  type CollisionGrid,
  type Point,
  type Portal,
  type TiledMap,
} from '@starmemory/shared';

export interface GameMap {
  id: string;
  displayName: string;
  grid: CollisionGrid;
  portals: Portal[];
  /** 預設出生點（格座標，浮點數，位於格子中心） */
  spawn: Point;
}

const MAP_DIR = fileURLToPath(new URL('../../shared/maps/', import.meta.url));

function loadMaps(): Map<string, GameMap> {
  const maps = new Map<string, GameMap>();
  for (const file of readdirSync(MAP_DIR).filter((f) => f.endsWith('.json'))) {
    const tiled = JSON.parse(readFileSync(MAP_DIR + file, 'utf-8')) as TiledMap;
    const id = getMapProperty(tiled, 'mapId');
    if (!id) {
      throw new Error(`地圖 ${file} 缺少 mapId 屬性`);
    }
    if (maps.has(id)) {
      throw new Error(`地圖代號重複：${id}`);
    }
    const spawn = findSpawn(tiled, SPAWN_PLAYER);
    if (!spawn) {
      throw new Error(`地圖 ${id} 缺少玩家出生點`);
    }
    maps.set(id, {
      id,
      displayName: getMapProperty(tiled, 'displayName') ?? id,
      grid: buildCollisionGrid(tiled),
      portals: findPortals(tiled),
      spawn,
    });
  }
  // 檢查每個傳送點的目的地都存在且可以站立，避免玩家被送進牆裡
  for (const map of maps.values()) {
    for (const portal of map.portals) {
      const target = maps.get(portal.targetMap);
      if (!target) {
        throw new Error(`地圖 ${map.id} 的傳送點「${portal.name}」指向不存在的地圖 ${portal.targetMap}`);
      }
      if (!isWalkable(target.grid, portal.targetX, portal.targetY)) {
        throw new Error(`地圖 ${map.id} 的傳送點「${portal.name}」目的地不可行走`);
      }
    }
  }
  return maps;
}

const MAPS = loadMaps();

export function getMap(id: string): GameMap | undefined {
  return MAPS.get(id);
}

export function allMaps(): GameMap[] {
  return [...MAPS.values()];
}
