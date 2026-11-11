// 資料表（JSON）的型別與查詢。新增職業、道具、魔物、技能只需要改 shared/data 底下的 JSON。

import classesJson from '../data/classes.json';
import itemsJson from '../data/items.json';
import monstersJson from '../data/monsters.json';
import npcsJson from '../data/npcs.json';
import skillsJson from '../data/skills.json';
import type { CardDef, EquipDef } from './equipment';

// ------------------------------------------------------------ 共用列舉

/** 七種屬性（GDD 5.2）：無、焰、潮、嵐、岩、輝、蝕 */
export type Element = 'neutral' | 'flame' | 'tide' | 'storm' | 'rock' | 'radiant' | 'eclipse';

export const ELEMENT_NAME: Record<Element, string> = {
  neutral: '無',
  flame: '焰',
  tide: '潮',
  storm: '嵐',
  rock: '岩',
  radiant: '輝',
  eclipse: '蝕',
};

/** 魔物種族（GDD 5.3） */
export type Race =
  | 'beast'
  | 'plant'
  | 'insect'
  | 'aquatic'
  | 'undead'
  | 'spirit'
  | 'construct'
  | 'humanoid'
  | 'dragon'
  | 'fiend';

export type Size = 'small' | 'medium' | 'large';
export type MonsterTier = 'normal' | 'elite' | 'boss';

/** 攻擊方式：近戰與遠程用物攻（主素質不同），魔法用魔攻 */
export type AttackType = 'melee' | 'ranged' | 'magic';

// ------------------------------------------------------------ 職業

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
  /** 普攻的攻擊方式與射程（格） */
  attackType: AttackType;
  attackRange: number;
  /** 基礎攻擊間隔（毫秒） */
  attackIntervalMs: number;
  /** 武器對各體型的傷害修正 */
  sizeModifier: Record<Size, number>;
  /** 可使用的技能代號 */
  skills: string[];
  /** 建立角色時放進背包的道具 */
  startItems: StartItem[];
}

// ------------------------------------------------------------ 道具

export type ItemType = 'consumable' | 'equipment' | 'material' | 'card';

export interface ItemDef {
  id: string;
  name: string;
  type: ItemType;
  /** 同一格最多可堆疊的數量 */
  maxStack: number;
  description: string;
  /** 賣給 NPC 的價格 */
  sellPrice: number;
  /** 向 NPC 購買的價格（只有商店有賣的道具才有） */
  buyPrice?: number;
  /** 使用後的效果（只有消耗品有） */
  effect?: { hp?: number; sp?: number };
  /** 裝備設定（只有裝備有） */
  equip?: EquipDef;
  /** 卡片設定（只有卡片有） */
  card?: CardDef;
}

// ------------------------------------------------------------ NPC

export type NpcType = 'shop' | 'refine' | 'storage';

export interface NpcDef {
  id: string;
  name: string;
  type: NpcType;
  /** 商店販售的道具代號（只有 shop 有） */
  sells?: string[];
}

// ------------------------------------------------------------ 魔物

export interface MonsterDrop {
  itemId: string;
  /** 掉落機率（百分比，0–100），每項獨立判定 */
  rate: number;
}

export interface MonsterDef {
  id: string;
  name: string;
  level: number;
  tier: MonsterTier;
  hp: number;
  atk: number;
  def: number;
  mdef: number;
  element: Element;
  race: Race;
  size: Size;
  exp: number;
  /** 掉落星幣的範圍 [最小, 最大] */
  coins: [number, number];
  /** true：玩家靠近就主動攻擊；false：被打才還手 */
  aggressive: boolean;
  /** 追擊時的移動速度（格／秒）；閒晃時為一半 */
  moveSpeed: number;
  attackRange: number;
  attackIntervalMs: number;
  /** 主動魔物發現玩家的距離（格） */
  aggroRange: number;
  /** 離重生點超過這個距離（格）就放棄追擊並返回 */
  leashRange: number;
  /** 死亡後多久重生（秒） */
  respawnSec: number;
  /** 用戶端圖集中的格子編號 */
  sprite: number;
  drops: MonsterDrop[];
}

// ------------------------------------------------------------ 技能

export interface SkillDef {
  id: string;
  name: string;
  /** damage：對敵人造成傷害；heal：回復自己 HP */
  type: 'damage' | 'heal';
  kind: 'physical' | 'magical';
  /** 技能屬性；'weapon' 表示沿用武器屬性（目前為無屬性） */
  element: Element | 'weapon';
  /** 倍率，1.8 即 180% */
  power: number;
  /** 連續攻擊次數 */
  hits: number;
  /** 施放距離（格）；0 表示對自己施放 */
  range: number;
  /** 範圍半徑（格）；0 表示單體 */
  radius: number;
  spCost: number;
  cooldownMs: number;
  requiredLevel: number;
  description: string;
}

// ------------------------------------------------------------ 資料與查詢

export const CLASSES: readonly ClassDef[] = classesJson as ClassDef[];
export const ITEMS: readonly ItemDef[] = itemsJson as ItemDef[];
export const MONSTERS: readonly MonsterDef[] = monstersJson as MonsterDef[];
export const SKILLS: readonly SkillDef[] = skillsJson as SkillDef[];
export const NPCS: readonly NpcDef[] = npcsJson as NpcDef[];

const classById = new Map(CLASSES.map((c) => [c.id, c]));
const itemById = new Map(ITEMS.map((i) => [i.id, i]));
const monsterById = new Map(MONSTERS.map((m) => [m.id, m]));
const skillById = new Map(SKILLS.map((s) => [s.id, s]));
const npcById = new Map(NPCS.map((n) => [n.id, n]));

export function getClassDef(id: string): ClassDef | undefined {
  return classById.get(id);
}

export function getItemDef(id: string): ItemDef | undefined {
  return itemById.get(id);
}

export function getMonsterDef(id: string): MonsterDef | undefined {
  return monsterById.get(id);
}

export function getSkillDef(id: string): SkillDef | undefined {
  return skillById.get(id);
}

export function getNpcDef(id: string): NpcDef | undefined {
  return npcById.get(id);
}

/**
 * 檢查資料表之間的參照是否完整（魔物掉落的道具、職業的技能與起始道具、NPC 販售的道具都必須存在）。
 * 伺服器啟動時呼叫，資料填錯會直接報錯而不是在遊戲中才出問題。
 * @returns 錯誤訊息清單；空陣列表示沒有問題
 */
export function validateGameData(): string[] {
  const errors: string[] = [];
  for (const cls of CLASSES) {
    for (const skillId of cls.skills) {
      if (!skillById.has(skillId)) {
        errors.push(`職業 ${cls.id} 的技能 ${skillId} 不存在`);
      }
    }
    for (const item of cls.startItems) {
      if (!itemById.has(item.itemId)) {
        errors.push(`職業 ${cls.id} 的起始道具 ${item.itemId} 不存在`);
      }
    }
  }
  for (const monster of MONSTERS) {
    for (const drop of monster.drops) {
      if (!itemById.has(drop.itemId)) {
        errors.push(`魔物 ${monster.id} 的掉落物 ${drop.itemId} 不存在`);
      }
      if (!(drop.rate > 0 && drop.rate <= 100)) {
        errors.push(`魔物 ${monster.id} 的掉落物 ${drop.itemId} 機率需介於 0–100`);
      }
    }
    if (monster.coins[0] > monster.coins[1] || monster.hp <= 0) {
      errors.push(`魔物 ${monster.id} 的星幣範圍或 HP 不合法`);
    }
  }
  for (const npc of NPCS) {
    for (const itemId of npc.sells ?? []) {
      if (itemById.get(itemId)?.buyPrice === undefined) {
        errors.push(`NPC ${npc.id} 販售的道具 ${itemId} 不存在或沒有設定 buyPrice`);
      }
    }
  }
  for (const item of ITEMS) {
    if (item.buyPrice !== undefined && item.sellPrice > item.buyPrice) {
      errors.push(`道具 ${item.id} 的賣價高於買價（可以無限套利）`);
    }
    if ((item.type === 'equipment') !== (item.equip !== undefined) || (item.type === 'card') !== (item.card !== undefined)) {
      errors.push(`道具 ${item.id} 的類型與 equip／card 設定不一致`);
    }
  }
  return errors;
}
