// 用戶端與伺服器共用的常數

/** 角色基礎移動速度（格／秒）。之後伺服器會用同一個值驗證移動。 */
export const PLAYER_MOVE_SPEED = 4.5;

/** 點到不可行走的格子時，往外尋找可行走格子的最大半徑（格）。 */
export const NEAREST_WALKABLE_RADIUS = 4;

/** A* 最多展開的節點數，避免在超大地圖上卡住。 */
export const PATHFIND_MAX_NODES = 20000;

/** Tiled 地圖中的圖層／物件名稱約定。 */
export const MAP_LAYER = {
  /** 地面圖磚層（圖磚屬性 blocked=true 表示不可行走，例如水面） */
  ground: 'ground',
  /** 立體物件圖磚層（樹、石頭…），有圖磚的格子一律不可行走 */
  props: 'props',
  /** 出生點物件層 */
  spawns: 'spawns',
  /** 傳送點物件層 */
  portals: 'portals',
} as const;

/** 玩家出生點的物件名稱。 */
export const SPAWN_PLAYER = 'player_spawn';
