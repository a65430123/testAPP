// 角色的素質、衍生能力值與背包的共用邏輯（公式見 GDD 第 4 章）

import { getItemDef, type ClassDef } from './data';

/** 六項素質 */
export interface Stats {
  pow: number;
  swf: number;
  con: number;
  mnd: number;
  foc: number;
  for: number;
}

export const STAT_KEYS = ['pow', 'swf', 'con', 'mnd', 'foc', 'for'] as const;

/** 新角色的初始值 */
export const NEW_CHARACTER = {
  level: 1,
  /** 六項素質的初始值 */
  baseStat: 5,
  /** 創角時可自由分配的素質點 */
  statPoints: 10,
  coins: 100,
} as const;

export const MAX_LEVEL = 100;

/** 每個帳號最多可建立的角色數 */
export const MAX_CHARACTERS_PER_ACCOUNT = 3;

/** 背包格數 */
export const INVENTORY_SIZE = 40;

export function newStats(): Stats {
  const v = NEW_CHARACTER.baseStat;
  return { pow: v, swf: v, con: v, mnd: v, foc: v, for: v };
}

export function computeMaxHp(cls: ClassDef, level: number, stats: Stats): number {
  return Math.floor((100 + level * cls.hpCoef) * (1 + stats.con * 0.01));
}

export function computeMaxSp(cls: ClassDef, level: number, stats: Stats): number {
  return Math.floor((30 + level * cls.spCoef) * (1 + stats.mnd * 0.01));
}

/** 背包中的一格 */
export interface InventoryItem {
  /** 格子位置（0 起算） */
  slot: number;
  itemId: string;
  quantity: number;
}

/**
 * 把道具放進背包：先疊到同種道具未滿的格子，剩下的放進最前面的空格。
 * 放不下時完全不變動（不會只放一部分）。
 * @returns 是否成功
 */
export function addItemToInventory(
  inventory: InventoryItem[],
  itemId: string,
  quantity: number,
  size: number = INVENTORY_SIZE,
): boolean {
  const def = getItemDef(itemId);
  if (!def || !Number.isInteger(quantity) || quantity <= 0) {
    return false;
  }
  // 先在副本上試算，確定放得下才套用
  const next = inventory.map((item) => ({ ...item }));
  let remaining = quantity;
  for (const item of next) {
    if (remaining === 0) {
      break;
    }
    if (item.itemId === itemId && item.quantity < def.maxStack) {
      const add = Math.min(def.maxStack - item.quantity, remaining);
      item.quantity += add;
      remaining -= add;
    }
  }
  const used = new Set(next.map((item) => item.slot));
  for (let slot = 0; slot < size && remaining > 0; slot++) {
    if (used.has(slot)) {
      continue;
    }
    const add = Math.min(def.maxStack, remaining);
    next.push({ slot, itemId, quantity: add });
    remaining -= add;
  }
  if (remaining > 0) {
    return false;
  }
  next.sort((a, b) => a.slot - b.slot);
  inventory.length = 0;
  inventory.push(...next);
  return true;
}
