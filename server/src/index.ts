// 伺服器佔位程式（本階段不連線）。
// 目的：確認 server 能匯入 shared，並用同一份地圖資料與尋路邏輯算出與用戶端相同的結果。
// Colyseus 房間、移動驗證會在後續階段加入。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildCollisionGrid,
  findPath,
  findSpawn,
  SPAWN_PLAYER,
  type TiledMap,
} from '@starmemory/shared';

const mapUrl = new URL('../../shared/maps/f01_sprout_meadow.json', import.meta.url);
const map = JSON.parse(readFileSync(fileURLToPath(mapUrl), 'utf-8')) as TiledMap;

const grid = buildCollisionGrid(map);
const blockedCount = grid.blocked.reduce((sum, v) => sum + v, 0);
const spawn = findSpawn(map, SPAWN_PLAYER);
if (!spawn) {
  throw new Error('地圖缺少玩家出生點');
}

const start = { x: Math.floor(spawn.x), y: Math.floor(spawn.y) };
const goal = { x: 5, y: 30 };
const path = findPath(grid, start, goal);

console.log(`[server] 地圖 F01 載入完成：${grid.width}×${grid.height}，不可行走格數 ${blockedCount}`);
console.log(`[server] 出生點格座標 (${start.x}, ${start.y})`);
console.log(
  path
    ? `[server] 從出生點到 (${goal.x}, ${goal.y}) 的路徑共 ${path.length} 步`
    : `[server] 從出生點無法到達 (${goal.x}, ${goal.y})`,
);
console.log('[server] 本階段尚未啟動網路服務。');
