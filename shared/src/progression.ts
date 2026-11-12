// 經驗值、升級與素質配點（公式見 GDD 第 4 章）

import { MAX_LEVEL, STAT_KEYS, type Stats } from './character';

/** 每升 1 級獲得的素質點 */
export const STAT_POINTS_PER_LEVEL = 6;
/** 單項素質上限 */
export const STAT_MAX = 100;

/** 從 level 升到下一級所需的經驗值 */
export function expToNext(level: number): number {
  return Math.floor(40 * Math.pow(level, 2.4) + 60 * level);
}

/** 等級差經驗倍率：d = 玩家等級 − 魔物等級 */
export function expLevelModifier(playerLevel: number, monsterLevel: number): number {
  const d = playerLevel - monsterLevel;
  if (d <= -10) return 0.6;
  if (d <= -5) return 1.1;
  if (d <= 4) return 1;
  if (d <= 9) return 0.7;
  if (d <= 14) return 0.4;
  return 0.1;
}

/**
 * 加上經驗值並處理升級（可連升多級）。
 * @returns 新的等級、剩餘經驗與升了幾級；滿級後經驗固定為 0
 */
export function applyExp(level: number, exp: number, gain: number): { level: number; exp: number; levelsGained: number } {
  let newLevel = level;
  let newExp = exp + Math.max(0, Math.floor(gain));
  while (newLevel < MAX_LEVEL && newExp >= expToNext(newLevel)) {
    newExp -= expToNext(newLevel);
    newLevel++;
  }
  if (newLevel >= MAX_LEVEL) {
    newExp = 0;
  }
  return { level: newLevel, exp: newExp, levelsGained: newLevel - level };
}

/** 把素質從 value 提升到 value+1 需要的點數 */
export function statCost(value: number): number {
  return 1 + Math.floor(value / 10);
}

export function isStatKey(key: unknown): key is keyof Stats {
  return typeof key === 'string' && (STAT_KEYS as readonly string[]).includes(key);
}

/**
 * 嘗試把一項素質加 1。
 * @returns 成功時回傳花費的點數，點數不足或已達上限時回傳 null（不會變動資料）
 */
export function allocateStat(stats: Stats, statPoints: number, key: keyof Stats): number | null {
  const value = stats[key];
  const cost = statCost(value);
  if (value >= STAT_MAX || statPoints < cost) {
    return null;
  }
  stats[key] = value + 1;
  return cost;
}

/** 隊伍人數上限，以及每多 1 位隊員的經驗加成 */
export const PARTY_MAX_MEMBERS = 6;
export const PARTY_EXP_BONUS_PER_MEMBER = 0.1;

/**
 * 組隊時每位隊員分到的經驗（套用等級差倍率之前）：
 * 總量每多 1 人增加 10%，再由在場的隊員平分。
 */
export function partyExpShare(exp: number, memberCount: number): number {
  const n = Math.max(1, memberCount);
  return (exp * (1 + PARTY_EXP_BONUS_PER_MEMBER * (n - 1))) / n;
}
