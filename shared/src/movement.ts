// 沿路徑移動的純邏輯（不依賴 Phaser，之後伺服器可直接重用）

import type { TilePoint } from './pathfinding';

export interface MoveState {
  /** 目前位置（格座標，浮點數） */
  x: number;
  y: number;
  /** 尚未走完的路徑（整數格），每一段的目的地是該格中心 */
  path: TilePoint[];
}

export function createMoveState(x: number, y: number): MoveState {
  return { x, y, path: [] };
}

export function isMoving(state: MoveState): boolean {
  return state.path.length > 0;
}

/** 目前所在的整數格 */
export function currentTile(state: MoveState): TilePoint {
  return { x: Math.floor(state.x), y: Math.floor(state.y) };
}

/**
 * 依經過時間沿路徑前進。
 * @param dtSec 經過秒數
 * @param speed 移動速度（格／秒）
 * @returns 這一步是否有實際移動
 */
export function advanceMove(state: MoveState, dtSec: number, speed: number): boolean {
  let remaining = speed * dtSec;
  let moved = false;
  while (remaining > 0 && state.path.length > 0) {
    const next = state.path[0]!;
    const targetX = next.x + 0.5;
    const targetY = next.y + 0.5;
    const dx = targetX - state.x;
    const dy = targetY - state.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= remaining) {
      // 抵達這一格的中心，繼續走下一段
      state.x = targetX;
      state.y = targetY;
      state.path.shift();
      remaining -= dist;
      moved = moved || dist > 0;
    } else {
      state.x += (dx / dist) * remaining;
      state.y += (dy / dist) * remaining;
      remaining = 0;
      moved = true;
    }
  }
  return moved;
}
