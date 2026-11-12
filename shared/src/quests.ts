// 任務的資料型別與共用判斷（資料在 shared/data/quests.json）

import questsJson from '../data/quests.json';
import { getItemDef, getMonsterDef, getNpcDef } from './data';

export type QuestObjective =
  | { type: 'kill'; monsterId: string; count: number }
  | { type: 'collect'; itemId: string; count: number };

export interface QuestDef {
  id: string;
  name: string;
  description: string;
  /** 發布任務與回報任務的 NPC（對應 npcs.json 的 id） */
  giver: string;
  turnIn: string;
  requiredLevel: number;
  /** 必須先完成的任務 */
  prerequisite?: string;
  objectives: QuestObjective[];
  rewards: {
    exp: number;
    coins: number;
    items: Array<{ itemId: string; quantity: number }>;
  };
  /** NPC 在各階段說的話 */
  dialogue: {
    /** 還沒接：介紹任務 */
    offer: string[];
    /** 進行中 */
    progress: string[];
    /** 回報時 */
    complete: string[];
  };
}

export const QUESTS: readonly QuestDef[] = questsJson as QuestDef[];

const questById = new Map(QUESTS.map((q) => [q.id, q]));

export function getQuestDef(id: string): QuestDef | undefined {
  return questById.get(id);
}

/** 同時進行中的任務數量上限 */
export const MAX_ACTIVE_QUESTS = 10;

/** 進行中任務的進度：progress[i] 對應 objectives[i]（擊殺類才會累計，收集類以背包數量為準） */
export interface QuestProgress {
  questId: string;
  progress: number[];
}

/**
 * 檢查能不能接這個任務。
 * @returns 可以時回傳 null，否則回傳原因
 */
export function questAcceptError(
  quest: QuestDef,
  level: number,
  active: ReadonlySet<string>,
  done: ReadonlySet<string>,
): string | null {
  if (done.has(quest.id)) {
    return '這個任務已經完成了';
  }
  if (active.has(quest.id)) {
    return '已經接了這個任務';
  }
  if (level < quest.requiredLevel) {
    return `需要等級 ${quest.requiredLevel}`;
  }
  if (quest.prerequisite && !done.has(quest.prerequisite)) {
    return `需要先完成「${getQuestDef(quest.prerequisite)?.name ?? quest.prerequisite}」`;
  }
  if (active.size >= MAX_ACTIVE_QUESTS) {
    return '進行中的任務太多了';
  }
  return null;
}

/**
 * 任務的每個目標目前的數量（不超過需求數量）。
 * @param countItem 回傳背包中某種道具的數量
 */
export function objectiveCounts(quest: QuestDef, progress: readonly number[], countItem: (itemId: string) => number): number[] {
  return quest.objectives.map((objective, index) =>
    Math.min(objective.count, objective.type === 'kill' ? (progress[index] ?? 0) : countItem(objective.itemId)),
  );
}

/** 所有目標是否都已達成 */
export function isQuestReady(quest: QuestDef, progress: readonly number[], countItem: (itemId: string) => number): boolean {
  return objectiveCounts(quest, progress, countItem).every((count, index) => count >= quest.objectives[index]!.count);
}

/**
 * 檢查任務資料的參照是否完整（NPC、魔物、道具、前置任務都必須存在）。
 * @returns 錯誤訊息清單；空陣列表示沒有問題
 */
export function validateQuests(): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const quest of QUESTS) {
    if (ids.has(quest.id)) {
      errors.push(`任務代號重複：${quest.id}`);
    }
    ids.add(quest.id);
    for (const npcId of [quest.giver, quest.turnIn]) {
      if (!getNpcDef(npcId)) {
        errors.push(`任務 ${quest.id} 的 NPC ${npcId} 不存在`);
      }
    }
    if (quest.prerequisite && !questById.has(quest.prerequisite)) {
      errors.push(`任務 ${quest.id} 的前置任務 ${quest.prerequisite} 不存在`);
    }
    if (quest.objectives.length === 0) {
      errors.push(`任務 ${quest.id} 沒有任何目標`);
    }
    for (const objective of quest.objectives) {
      if (objective.type === 'kill' && !getMonsterDef(objective.monsterId)) {
        errors.push(`任務 ${quest.id} 的擊殺目標 ${objective.monsterId} 不存在`);
      }
      if (objective.type === 'collect' && !getItemDef(objective.itemId)) {
        errors.push(`任務 ${quest.id} 的收集目標 ${objective.itemId} 不存在`);
      }
      if (!(objective.count >= 1)) {
        errors.push(`任務 ${quest.id} 的目標數量需大於 0`);
      }
    }
    for (const reward of quest.rewards.items) {
      if (!getItemDef(reward.itemId)) {
        errors.push(`任務 ${quest.id} 的獎勵道具 ${reward.itemId} 不存在`);
      }
    }
    for (const key of ['offer', 'progress', 'complete'] as const) {
      if (!quest.dialogue?.[key]?.length) {
        errors.push(`任務 ${quest.id} 缺少 ${key} 對話`);
      }
    }
  }
  return errors;
}
