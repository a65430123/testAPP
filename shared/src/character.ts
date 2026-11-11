// 角色的素質與衍生能力值（公式見 GDD 第 4 章）

import type { ClassDef } from './data';

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
