// 格子 A* 尋路（八方向，不允許斜向切過障礙物的角）

import { NEAREST_WALKABLE_RADIUS, PATHFIND_MAX_NODES } from './constants';
import { isWalkable, type CollisionGrid } from './tiled';

export interface TilePoint {
  x: number;
  y: number;
}

const SQRT2 = Math.SQRT2;

/** 八個方向：[dx, dy, 移動成本] */
const NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

/** 八方向距離估計（octile distance） */
function heuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
}

/** 以 f 值排序的最小堆，存放格子索引 */
class MinHeap {
  private readonly items: number[] = [];
  private readonly scores: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, score: number): void {
    const items = this.items;
    const scores = this.scores;
    let i = items.length;
    items.push(item);
    scores.push(score);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (scores[parent]! <= score) {
        break;
      }
      items[i] = items[parent]!;
      scores[i] = scores[parent]!;
      i = parent;
    }
    items[i] = item;
    scores[i] = score;
  }

  pop(): number {
    const items = this.items;
    const scores = this.scores;
    const top = items[0]!;
    const lastItem = items.pop()!;
    const lastScore = scores.pop()!;
    const n = items.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = i * 2 + 1;
        if (child >= n) {
          break;
        }
        if (child + 1 < n && scores[child + 1]! < scores[child]!) {
          child++;
        }
        if (scores[child]! >= lastScore) {
          break;
        }
        items[i] = items[child]!;
        scores[i] = scores[child]!;
        i = child;
      }
      items[i] = lastItem;
      scores[i] = lastScore;
    }
    return top;
  }
}

/**
 * 尋找從 start 到 goal 的路徑。
 * @returns 依序要走過的格子（不含起點、包含終點）；起點等於終點時回傳空陣列；無法到達時回傳 null
 */
export function findPath(grid: CollisionGrid, start: TilePoint, goal: TilePoint): TilePoint[] | null {
  if (!isWalkable(grid, goal.x, goal.y) || !isWalkable(grid, start.x, start.y)) {
    return null;
  }
  if (start.x === goal.x && start.y === goal.y) {
    return [];
  }

  const { width, height } = grid;
  const size = width * height;
  const gScore = new Float32Array(size).fill(Infinity);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const open = new MinHeap();

  const startIdx = start.y * width + start.x;
  const goalIdx = goal.y * width + goal.x;
  gScore[startIdx] = 0;
  open.push(startIdx, heuristic(start.x, start.y, goal.x, goal.y));

  let expanded = 0;
  while (open.size > 0) {
    const current = open.pop();
    if (current === goalIdx) {
      return reconstruct(cameFrom, current, startIdx, width);
    }
    if (closed[current] === 1) {
      continue;
    }
    closed[current] = 1;
    if (++expanded > PATHFIND_MAX_NODES) {
      return null;
    }

    const cx = current % width;
    const cy = (current - cx) / width;
    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(grid, nx, ny)) {
        continue;
      }
      // 斜向移動時，兩側相鄰格都必須可走，避免穿過障礙物的角
      if (dx !== 0 && dy !== 0 && (!isWalkable(grid, cx + dx, cy) || !isWalkable(grid, cx, cy + dy))) {
        continue;
      }
      const nIdx = ny * width + nx;
      if (closed[nIdx] === 1) {
        continue;
      }
      const tentative = gScore[current]! + cost;
      if (tentative < gScore[nIdx]!) {
        gScore[nIdx] = tentative;
        cameFrom[nIdx] = current;
        open.push(nIdx, tentative + heuristic(nx, ny, goal.x, goal.y));
      }
    }
  }
  return null;
}

function reconstruct(cameFrom: Int32Array, endIdx: number, startIdx: number, width: number): TilePoint[] {
  const path: TilePoint[] = [];
  let idx = endIdx;
  while (idx !== startIdx && idx !== -1) {
    const x = idx % width;
    path.push({ x, y: (idx - x) / width });
    idx = cameFrom[idx]!;
  }
  path.reverse();
  return path;
}

/**
 * 目標格不可行走時，找最近的可行走格子（以直線距離為準）。
 * @returns 找不到時回傳 null
 */
export function nearestWalkable(
  grid: CollisionGrid,
  target: TilePoint,
  maxRadius: number = NEAREST_WALKABLE_RADIUS,
): TilePoint | null {
  if (isWalkable(grid, target.x, target.y)) {
    return target;
  }
  let best: TilePoint | null = null;
  let bestDist = Infinity;
  for (let dy = -maxRadius; dy <= maxRadius; dy++) {
    for (let dx = -maxRadius; dx <= maxRadius; dx++) {
      const x = target.x + dx;
      const y = target.y + dy;
      if (!isWalkable(grid, x, y)) {
        continue;
      }
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = { x, y };
      }
    }
  }
  return best;
}
