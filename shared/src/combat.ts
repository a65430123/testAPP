// 戰鬥公式（GDD 第 4、5 章）。純函式，亂數由外部傳入，伺服器與測試都能使用。

import { computeMaxHp, computeMaxSp, type Stats } from './character';
import type { ClassDef, Element, MonsterDef, MonsterTier, Race, Size } from './data';
import { computeEquipTotals, UNARMED_ATK, type ItemStack } from './equipment';

/** 屬性相剋表：ELEMENT_TABLE[攻擊屬性][防守屬性] = 傷害倍率 */
export const ELEMENT_TABLE: Record<Element, Record<Element, number>> = {
  //         無            焰            潮          嵐           岩          輝             蝕
  neutral: { neutral: 1, flame: 1, tide: 1, storm: 1, rock: 1, radiant: 1, eclipse: 1 },
  flame: { neutral: 1, flame: 0.25, tide: 0.5, storm: 1.5, rock: 1, radiant: 1, eclipse: 1 },
  tide: { neutral: 1, flame: 1.5, tide: 0.25, storm: 1, rock: 0.5, radiant: 1, eclipse: 1 },
  storm: { neutral: 1, flame: 0.5, tide: 1, storm: 0.25, rock: 1.5, radiant: 1, eclipse: 1 },
  rock: { neutral: 1, flame: 1, tide: 1.5, storm: 0.5, rock: 0.25, radiant: 1, eclipse: 1 },
  radiant: { neutral: 1, flame: 1, tide: 1, storm: 1, rock: 1, radiant: 0.25, eclipse: 1.5 },
  eclipse: { neutral: 1, flame: 1, tide: 1, storm: 1, rock: 1, radiant: 1.5, eclipse: 0.25 },
};

/** 暴擊傷害倍率 */
export const CRIT_MULTIPLIER = 1.5;
/** 暴擊率上限（%） */
export const CRIT_RATE_MAX = 60;

/** 參與戰鬥的一方（玩家或魔物）所需的數值 */
export interface Combatant {
  level: number;
  /** 物攻與魔攻 */
  atk: number;
  matk: number;
  /** 百分比減傷用的防禦 */
  def: number;
  mdef: number;
  /** 固定減傷 */
  flatPhysReduce: number;
  flatMagicReduce: number;
  hit: number;
  eva: number;
  /** 暴擊率（%）與暴擊抵抗（%） */
  crit: number;
  critResist: number;
  /** 傷害浮動範圍，0.1 表示 ±10% */
  variance: number;
  /** 防守屬性、種族、體型 */
  element: Element;
  race: Race;
  size: Size;
  /** 對各體型的傷害修正（武器特性） */
  sizeModifier: Record<Size, number>;
}

const NO_SIZE_MODIFIER: Record<Size, number> = { small: 1, medium: 1, large: 1 };
const TIER_ACCURACY_BONUS: Record<MonsterTier, number> = { normal: 0, elite: 10, boss: 25 };

/** 玩家的戰鬥數值，另含 MaxHP／MaxSP、攻擊間隔與回復加成 */
export interface PlayerCombatStats extends Combatant {
  maxHp: number;
  maxSp: number;
  attackIntervalMs: number;
  /** HP 自然回復量加成（%） */
  hpRegenPct: number;
  /** 含裝備加成的六項素質 */
  totalStats: Stats;
}

/**
 * 由職業、等級、素質與身上的裝備計算玩家的戰鬥數值。
 * 裝備與卡片的素質加成會先加到素質上，再代入各項公式。
 */
export function computePlayerCombatStats(
  cls: ClassDef,
  level: number,
  baseStats: Stats,
  equipment: readonly ItemStack[] = [],
): PlayerCombatStats {
  const gear = computeEquipTotals(equipment);
  const stats: Stats = {
    pow: baseStats.pow + gear.stats.pow,
    swf: baseStats.swf + gear.stats.swf,
    con: baseStats.con + gear.stats.con,
    mnd: baseStats.mnd + gear.stats.mnd,
    foc: baseStats.foc + gear.stats.foc,
    for: baseStats.for + gear.stats.for,
  };
  const half = (n: number): number => Math.floor(n / 2);
  const levelBonus = half(level);
  const weaponAtk = gear.weaponAtk ?? UNARMED_ATK;
  const weaponMatk = gear.weaponMatk ?? UNARMED_ATK;
  let atk: number;
  if (cls.attackType === 'ranged') {
    atk = weaponAtk + stats.foc * 2 + Math.floor(stats.foc / 10) ** 2 + half(stats.pow) + levelBonus;
  } else {
    atk = weaponAtk + stats.pow * 2 + Math.floor(stats.pow / 10) ** 2 + half(stats.foc) + levelBonus;
  }
  const matk = weaponMatk + stats.mnd * 2 + Math.floor(stats.mnd / 8) ** 2 + levelBonus;
  const speedBonus = Math.min(0.6, stats.swf * 0.004 + stats.foc * 0.001);
  return {
    level,
    atk: atk + gear.atk,
    matk: matk + gear.matk,
    def: gear.def,
    mdef: gear.mdef,
    flatPhysReduce: half(stats.con) + Math.floor(level / 4),
    flatMagicReduce: half(stats.mnd) + Math.floor(level / 4),
    hit: level + stats.foc * 2 + gear.hit,
    eva: level + stats.swf * 2 + gear.eva,
    crit: Math.min(CRIT_RATE_MAX, 1 + stats.for * 0.3 + gear.crit),
    critResist: stats.for * 0.1,
    variance: Math.max(0.02, 0.12 - stats.foc * 0.001),
    element: 'neutral',
    race: 'humanoid',
    size: 'medium',
    sizeModifier: cls.sizeModifier,
    maxHp: Math.floor((computeMaxHp(cls, level, stats) + gear.maxHp) * (1 + gear.maxHpPct)),
    maxSp: computeMaxSp(cls, level, stats) + gear.maxSp,
    attackIntervalMs: Math.round(cls.attackIntervalMs * (1 - speedBonus)),
    hpRegenPct: gear.hpRegenPct,
    totalStats: stats,
  };
}

/** 魔物的戰鬥數值：攻防取資料表，命中與迴避為 Lv×2 + 階級修正，暴擊率固定 5% */
export function monsterCombatant(def: MonsterDef): Combatant {
  const accuracy = def.level * 2 + TIER_ACCURACY_BONUS[def.tier];
  return {
    level: def.level,
    atk: def.atk,
    matk: def.atk,
    def: def.def,
    mdef: def.mdef,
    flatPhysReduce: 0,
    flatMagicReduce: 0,
    hit: accuracy,
    eva: accuracy,
    crit: 5,
    critResist: 0,
    variance: 0.1,
    element: def.element,
    race: def.race,
    size: def.size,
    sizeModifier: NO_SIZE_MODIFIER,
  };
}

export interface AttackOptions {
  kind: 'physical' | 'magical';
  /** 攻擊屬性 */
  element: Element;
  /** 技能倍率；普攻為 1 */
  power: number;
}

export interface AttackResult {
  miss: boolean;
  crit: boolean;
  damage: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 物理攻擊的命中率（%） */
export function hitRate(attacker: Combatant, defender: Combatant): number {
  return clamp(85 + (attacker.hit - defender.eva) * 0.5, 5, 95);
}

/**
 * 計算一次攻擊的結果（GDD 5.1 的流程）。
 * @param rng 回傳 [0, 1) 的亂數函式
 */
export function rollAttack(
  attacker: Combatant,
  defender: Combatant,
  options: AttackOptions,
  rng: () => number,
): AttackResult {
  const physical = options.kind === 'physical';

  // 1–2. 先判暴擊再判命中：暴擊必定命中；魔法必中且不暴擊
  let crit = false;
  if (physical) {
    const critRate = clamp(attacker.crit - defender.critResist, 0, CRIT_RATE_MAX);
    crit = rng() * 100 < critRate;
    if (!crit && rng() * 100 >= hitRate(attacker, defender)) {
      return { miss: true, crit: false, damage: 0 };
    }
  }

  // 3. 基礎傷害
  const variance = 1 - attacker.variance + rng() * attacker.variance * 2;
  let damage = (physical ? attacker.atk : attacker.matk) * options.power * variance;

  // 4. 加成乘區：目前只有武器的體型修正（種族、首領加成等之後隨卡片效果擴充）
  if (physical) {
    damage *= attacker.sizeModifier[defender.size];
  }

  // 5. 屬性相剋
  damage *= ELEMENT_TABLE[options.element][defender.element];

  // 6. 防禦：百分比減傷後再扣固定減傷
  if (physical) {
    damage = (damage * 100) / (100 + defender.def) - defender.flatPhysReduce;
  } else {
    damage = (damage * 100) / (100 + defender.mdef) - defender.flatMagicReduce;
  }

  // 7. 暴擊倍率
  if (crit) {
    damage *= CRIT_MULTIPLIER;
  }

  // 9. 至少造成 1 點傷害
  return { miss: false, crit, damage: Math.max(1, Math.floor(damage)) };
}
