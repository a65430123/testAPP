// 資料表（JSON）的型別與查詢。新增職業或道具只需要改 shared/data 底下的 JSON。

import classesJson from '../data/classes.json';
import itemsJson from '../data/items.json';

export interface StartItem {
  itemId: string;
  quantity: number;
}

export interface ClassDef {
  id: string;
  name: string;
  description: string;
  /** MaxHP／MaxSP 公式中的職業係數（見 GDD 第 4 章） */
  hpCoef: number;
  spCoef: number;
  /** 建立角色時放進背包的道具 */
  startItems: StartItem[];
}

export type ItemType = 'consumable' | 'equipment' | 'material';

export interface ItemDef {
  id: string;
  name: string;
  type: ItemType;
  /** 同一格最多可堆疊的數量 */
  maxStack: number;
  description: string;
}

export const CLASSES: readonly ClassDef[] = classesJson as ClassDef[];
export const ITEMS: readonly ItemDef[] = itemsJson as ItemDef[];

const classById = new Map(CLASSES.map((c) => [c.id, c]));
const itemById = new Map(ITEMS.map((i) => [i.id, i]));

export function getClassDef(id: string): ClassDef | undefined {
  return classById.get(id);
}

export function getItemDef(id: string): ItemDef | undefined {
  return itemById.get(id);
}
