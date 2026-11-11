// 容器（背包、倉庫）的共用操作。全部是純函式，放不下或數量不足時不會變動資料。

import { getItemDef } from './data';
import type { InventoryItem, ItemStack } from './equipment';

/** 背包與倉庫的格數 */
export const INVENTORY_SIZE = 40;
export const STORAGE_SIZE = 60;

/** 要放進容器的道具（還沒有唯一編號與格子位置） */
export interface NewItem {
  itemId: string;
  quantity: number;
  refine?: number;
  cardSlots?: number;
  cards?: string[];
}

export function cloneItems(items: readonly InventoryItem[]): InventoryItem[] {
  return items.map((item) => ({ ...item, cards: [...item.cards] }));
}

/** 有精煉、卡槽或卡片的道具各自獨立，不與其他道具堆疊 */
function isPlain(item: { refine?: number; cardSlots?: number; cards?: string[] }): boolean {
  return (item.refine ?? 0) === 0 && (item.cardSlots ?? 0) === 0 && (item.cards?.length ?? 0) === 0;
}

/**
 * 把道具放進容器：先疊到同種道具未滿的格子，剩下的放進最前面的空格。
 * @param newUid 產生唯一編號的函式（只有伺服器會真的新增道具）
 * @param keepUid 整份移入空格時沿用的編號（搬移既有的道具實體時傳入，讓編號跟著道具走）
 * @returns 是否成功；失敗時容器完全不變
 */
export function addToContainer(
  container: InventoryItem[],
  size: number,
  item: NewItem,
  newUid: () => string,
  keepUid?: string,
): boolean {
  const def = getItemDef(item.itemId);
  if (!def || !Number.isInteger(item.quantity) || item.quantity <= 0) {
    return false;
  }
  const next = cloneItems(container);
  let remaining = item.quantity;
  const stackable = def.maxStack > 1 && isPlain(item);

  if (stackable) {
    for (const existing of next) {
      if (remaining === 0) {
        break;
      }
      if (existing.itemId === item.itemId && isPlain(existing) && existing.quantity < def.maxStack) {
        const add = Math.min(def.maxStack - existing.quantity, remaining);
        existing.quantity += add;
        remaining -= add;
      }
    }
  }

  const used = new Set(next.map((i) => i.slot));
  // 整份都沒有被疊進既有格子時，第一個新格子沿用原本的編號
  let reuseUid = remaining === item.quantity ? keepUid : undefined;
  for (let slot = 0; slot < size && remaining > 0; slot++) {
    if (used.has(slot)) {
      continue;
    }
    const add = Math.min(def.maxStack, remaining);
    next.push({
      uid: reuseUid ?? newUid(),
      slot,
      itemId: item.itemId,
      quantity: add,
      refine: item.refine ?? 0,
      cardSlots: item.cardSlots ?? 0,
      cards: [...(item.cards ?? [])],
    });
    reuseUid = undefined;
    remaining -= add;
  }
  if (remaining > 0) {
    return false;
  }
  next.sort((a, b) => a.slot - b.slot);
  container.length = 0;
  container.push(...next);
  return true;
}

/**
 * 從指定格子取出若干數量；數量歸零時移除整格。
 * @returns 取出的道具（沿用原本的編號）；格子不存在或數量不足時回傳 null 且不變動
 */
export function takeFromSlot(container: InventoryItem[], slot: number, quantity: number): ItemStack | null {
  const index = container.findIndex((item) => item.slot === slot);
  const item = container[index];
  if (!item || !Number.isInteger(quantity) || quantity <= 0 || item.quantity < quantity) {
    return null;
  }
  item.quantity -= quantity;
  if (item.quantity === 0) {
    container.splice(index, 1);
  }
  return {
    uid: item.uid,
    itemId: item.itemId,
    quantity,
    refine: item.refine,
    cardSlots: item.cardSlots,
    cards: [...item.cards],
  };
}

/** 依道具代號扣除數量（可跨多格）；數量不足時回傳 false 且不變動 */
export function takeByItemId(container: InventoryItem[], itemId: string, quantity: number): boolean {
  const total = container.filter((i) => i.itemId === itemId).reduce((sum, i) => sum + i.quantity, 0);
  if (!Number.isInteger(quantity) || quantity <= 0 || total < quantity) {
    return false;
  }
  let remaining = quantity;
  for (const item of [...container]) {
    if (remaining === 0) {
      break;
    }
    if (item.itemId !== itemId) {
      continue;
    }
    const take = Math.min(item.quantity, remaining);
    item.quantity -= take;
    remaining -= take;
    if (item.quantity === 0) {
      container.splice(container.indexOf(item), 1);
    }
  }
  return true;
}

/**
 * 在兩個容器之間搬移道具（例如背包 ↔ 倉庫）。
 * 整疊搬到空格時沿用原本的編號；與既有的同種道具合併時，編號會併入對方。
 * @returns 是否成功；失敗時兩個容器都不變
 */
export function moveBetween(
  from: InventoryItem[],
  to: InventoryItem[],
  toSize: number,
  slot: number,
  quantity: number,
  newUid: () => string,
): ItemStack | null {
  const fromNext = cloneItems(from);
  const toNext = cloneItems(to);
  const source = fromNext.find((i) => i.slot === slot);
  const wholeStack = source !== undefined && source.quantity === quantity;
  const taken = takeFromSlot(fromNext, slot, quantity);
  if (!taken) {
    return null;
  }
  if (!addToContainer(toNext, toSize, taken, newUid, wholeStack ? taken.uid : undefined)) {
    return null;
  }
  from.length = 0;
  from.push(...fromNext);
  to.length = 0;
  to.push(...toNext);
  return taken;
}
