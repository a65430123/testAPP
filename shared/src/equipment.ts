// 裝備欄、裝備加成、精煉與卡片的共用規則（GDD 第 8、9 章）

import { STAT_KEYS, type Stats } from './character';
import { getItemDef, type ClassDef, type ItemDef } from './data';

/** 裝備種類（一件裝備屬於哪一類） */
export type EquipType = 'weapon' | 'offhand' | 'head' | 'body' | 'hands' | 'feet' | 'cloak' | 'accessory';

/** 裝備欄位（身上的 9 個格子）；陣列索引就是資料庫中的 slot */
export const EQUIP_SLOTS = [
  'weapon',
  'offhand',
  'head',
  'body',
  'hands',
  'feet',
  'cloak',
  'accessory1',
  'accessory2',
] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];

export const EQUIP_SLOT_NAME: Record<EquipSlot, string> = {
  weapon: '武器',
  offhand: '副手',
  head: '頭部',
  body: '身體',
  hands: '手部',
  feet: '腳部',
  cloak: '披風',
  accessory1: '飾品 1',
  accessory2: '飾品 2',
};

export const EQUIP_TYPE_NAME: Record<EquipType, string> = {
  weapon: '武器',
  offhand: '副手',
  head: '頭部防具',
  body: '身體防具',
  hands: '手部防具',
  feet: '腳部防具',
  cloak: '披風',
  accessory: '飾品',
};

/** 可加在角色身上的數值加成（裝備本體與卡片共用） */
export interface Bonus {
  atk?: number;
  matk?: number;
  def?: number;
  mdef?: number;
  maxHp?: number;
  maxSp?: number;
  hit?: number;
  eva?: number;
  /** 暴擊率（%） */
  crit?: number;
  /** HP 自然回復量加成（%） */
  hpRegenPct?: number;
  stats?: Partial<Stats>;
}

/** 裝備類道具的設定（items.json 的 equip 欄位） */
export interface EquipDef extends Bonus {
  type: EquipType;
  reqLevel: number;
  /** 限定職業；省略表示所有職業都能裝備 */
  classes?: string[];
}

/** 卡片類道具的設定（items.json 的 card 欄位） */
export interface CardDef {
  /** 可鑲嵌的裝備種類 */
  type: EquipType;
  bonus: Bonus;
}

/** 道具實體：背包、裝備欄、倉庫裡的每一格（每一疊）都是一個實體 */
export interface ItemStack {
  /** 唯一編號（由伺服器產生），同一個編號在整個資料庫只會存在一筆 */
  uid: string;
  itemId: string;
  quantity: number;
  /** 精煉等級 0–10（只有裝備有意義） */
  refine: number;
  /** 卡槽數，以及已鑲嵌的卡片（道具代號） */
  cardSlots: number;
  cards: string[];
}

/** 放在某個容器（背包、裝備欄、倉庫）中的道具：多一個格子位置 */
export interface InventoryItem extends ItemStack {
  slot: number;
}

/** 沒有裝備武器時的武器攻擊力 */
export const UNARMED_ATK = 3;

// ------------------------------------------------------------ 精煉

export const REFINE_MAX = 10;

export interface RefineStep {
  /** 成功率（%） */
  rate: number;
  /** 星幣費用 = feePerLevel × 裝備需求等級 */
  feePerLevel: number;
  /** 失敗時是否降 1 級 */
  downgrade: boolean;
}

/** REFINE_TABLE[n] 是從 +n 精煉到 +(n+1) 的規則（GDD 8.5） */
export const REFINE_TABLE: readonly RefineStep[] = [
  { rate: 100, feePerLevel: 50, downgrade: false },
  { rate: 100, feePerLevel: 50, downgrade: false },
  { rate: 100, feePerLevel: 50, downgrade: false },
  { rate: 100, feePerLevel: 50, downgrade: false },
  { rate: 80, feePerLevel: 100, downgrade: false },
  { rate: 65, feePerLevel: 150, downgrade: false },
  { rate: 50, feePerLevel: 250, downgrade: true },
  { rate: 35, feePerLevel: 400, downgrade: true },
  { rate: 25, feePerLevel: 600, downgrade: true },
  { rate: 15, feePerLevel: 1000, downgrade: true },
];

/** 精煉材料：武器用星鋼砂，其餘用星絨砂 */
export function refineMaterial(type: EquipType): string {
  return type === 'weapon' ? 'sand_starsteel' : 'sand_starvelvet';
}

export function refineFee(equip: EquipDef, currentRefine: number): number {
  return (REFINE_TABLE[currentRefine]?.feePerLevel ?? 0) * Math.max(1, equip.reqLevel);
}

/** 武器的攻擊力倍率：+1～+6 每級 4%，+7 以上每級 6% */
export function weaponRefineMultiplier(refine: number): number {
  return 1 + Math.min(refine, 6) * 0.04 + Math.max(0, refine - 6) * 0.06;
}

/** 防具的防禦倍率：每級 3% */
export function armorRefineMultiplier(refine: number): number {
  return 1 + refine * 0.03;
}

/** 防具每級精煉增加的 MaxHP 比例 */
export const ARMOR_REFINE_HP_PCT = 0.005;

// ------------------------------------------------------------ 卡槽

/** 裝備掉落時隨機決定卡槽數（GDD 8.2）：武器 0–3 槽，其餘 0–1 槽 */
export function rollCardSlots(type: EquipType, rng: () => number): number {
  const r = rng();
  if (type === 'weapon') {
    return r < 0.6 ? 0 : r < 0.88 ? 1 : r < 0.98 ? 2 : 3;
  }
  return r < 0.7 ? 0 : 1;
}

/** 某種裝備最多可以有幾個卡槽 */
export function maxCardSlots(type: EquipType): number {
  return type === 'weapon' ? 3 : 1;
}

// ------------------------------------------------------------ 穿戴規則

/** 某種裝備可以放進哪些裝備欄位 */
export function slotsForType(type: EquipType): EquipSlot[] {
  return type === 'accessory' ? ['accessory1', 'accessory2'] : [type];
}

/**
 * 檢查角色能不能裝備這件道具。
 * @returns 可以時回傳 null，否則回傳原因
 */
export function equipError(def: ItemDef | undefined, cls: ClassDef, level: number): string | null {
  const equip = def?.equip;
  if (!def || !equip) {
    return '這不是裝備';
  }
  if (level < equip.reqLevel) {
    return `需要等級 ${equip.reqLevel}`;
  }
  if (equip.classes && !equip.classes.includes(cls.id)) {
    return `${cls.name}無法使用${def.name}`;
  }
  return null;
}

// ------------------------------------------------------------ 加成彙總

/** 身上所有裝備與卡片加總後的結果 */
export interface EquipTotals {
  /** 武器的物攻／魔攻（已含精煉）；沒有武器時為 null */
  weaponAtk: number | null;
  weaponMatk: number | null;
  atk: number;
  matk: number;
  def: number;
  mdef: number;
  maxHp: number;
  maxSp: number;
  hit: number;
  eva: number;
  crit: number;
  hpRegenPct: number;
  /** 防具精煉帶來的 MaxHP 比例加成 */
  maxHpPct: number;
  stats: Stats;
}

function addBonus(totals: EquipTotals, bonus: Bonus, defMultiplier = 1): void {
  totals.atk += bonus.atk ?? 0;
  totals.matk += bonus.matk ?? 0;
  totals.def += Math.floor((bonus.def ?? 0) * defMultiplier);
  totals.mdef += Math.floor((bonus.mdef ?? 0) * defMultiplier);
  totals.maxHp += bonus.maxHp ?? 0;
  totals.maxSp += bonus.maxSp ?? 0;
  totals.hit += bonus.hit ?? 0;
  totals.eva += bonus.eva ?? 0;
  totals.crit += bonus.crit ?? 0;
  totals.hpRegenPct += bonus.hpRegenPct ?? 0;
  for (const key of STAT_KEYS) {
    totals.stats[key] += bonus.stats?.[key] ?? 0;
  }
}

/** 彙總身上裝備（含精煉與卡片）的加成 */
export function computeEquipTotals(equipment: readonly ItemStack[]): EquipTotals {
  const totals: EquipTotals = {
    weaponAtk: null,
    weaponMatk: null,
    atk: 0,
    matk: 0,
    def: 0,
    mdef: 0,
    maxHp: 0,
    maxSp: 0,
    hit: 0,
    eva: 0,
    crit: 0,
    hpRegenPct: 0,
    maxHpPct: 0,
    stats: { pow: 0, swf: 0, con: 0, mnd: 0, foc: 0, for: 0 },
  };
  for (const item of equipment) {
    const equip = getItemDef(item.itemId)?.equip;
    if (!equip) {
      continue;
    }
    if (equip.type === 'weapon') {
      // 武器的攻擊力不算在一般加成裡，而是當成公式中的「武器攻擊力」
      const multiplier = weaponRefineMultiplier(item.refine);
      totals.weaponAtk = Math.floor((equip.atk ?? 0) * multiplier);
      totals.weaponMatk = Math.floor((equip.matk ?? 0) * multiplier);
      addBonus(totals, { ...equip, atk: 0, matk: 0 });
    } else {
      addBonus(totals, equip, armorRefineMultiplier(item.refine));
      totals.maxHpPct += item.refine * ARMOR_REFINE_HP_PCT;
    }
    for (const cardId of item.cards) {
      const card = getItemDef(cardId)?.card;
      if (card) {
        addBonus(totals, card.bonus);
      }
    }
  }
  return totals;
}

/** 道具的顯示名稱：精煉等級與卡槽，例如「+4 見習長劍 [1/2]」 */
export function itemDisplayName(item: ItemStack): string {
  const def = getItemDef(item.itemId);
  const name = def?.name ?? item.itemId;
  const refine = item.refine > 0 ? `+${item.refine} ` : '';
  const slots = item.cardSlots > 0 ? ` [${item.cards.length}/${item.cardSlots}]` : '';
  return `${refine}${name}${slots}`;
}
