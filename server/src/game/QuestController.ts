// 任務：接任務、累計擊殺、回報領獎、放棄。任務內容全部來自 shared/data/quests.json。

import { randomUUID } from 'node:crypto';
import type { Client } from 'colyseus';
import {
  addToContainer,
  cloneItems,
  getItemDef,
  getQuestDef,
  INVENTORY_SIZE,
  isQuestReady,
  MSG,
  questAcceptError,
  takeByItemId,
  type QuestsMessage,
} from '@starmemory/shared';
import type { ItemLogEntry } from '../db/items';
import { withCharacterLock } from '../db/locks';
import { pool } from '../db/pool';
import type { PlayerRuntime } from '../rooms/runtime';
import type { ItemController } from './ItemController';

export interface QuestHost {
  actingPlayer(client: Client): PlayerRuntime | null;
  sendSystemTo(client: Client, text: string): void;
  /** 玩家是否就在指定的 NPC 旁邊 */
  isNearNpc(runtime: PlayerRuntime, npcId: string): boolean;
  grantExp(runtime: PlayerRuntime, amount: number): void;
}

export class QuestController {
  constructor(
    private readonly host: QuestHost,
    private readonly items: ItemController,
  ) {}

  /** 把任務狀態傳給本人 */
  send(runtime: PlayerRuntime): void {
    const { record } = runtime;
    const message: QuestsMessage = {
      active: [...record.activeQuests].map(([questId, progress]) => ({ questId, progress })),
      done: [...record.doneQuests],
    };
    runtime.client.send(MSG.quests, message);
  }

  handle(client: Client, message: unknown): void {
    const runtime = this.host.actingPlayer(client);
    const payload = message as { action?: unknown; questId?: unknown; npcId?: unknown } | null;
    const quest = typeof payload?.questId === 'string' ? getQuestDef(payload.questId) : undefined;
    if (!runtime || !quest) {
      return;
    }
    const { record } = runtime;
    const say = (text: string): void => this.host.sendSystemTo(client, text);
    const npcId = typeof payload?.npcId === 'string' ? payload.npcId : '';

    // 任務操作排進道具佇列：回報任務會動到背包與星幣，必須與其他道具操作依序執行
    switch (payload?.action) {
      case 'accept':
        this.items.run(runtime, async () => {
          if (quest.giver !== npcId || !this.host.isNearNpc(runtime, npcId)) {
            say('請到發布任務的 NPC 旁邊');
            return;
          }
          const error = questAcceptError(quest, record.level, new Set(record.activeQuests.keys()), record.doneQuests);
          if (error) {
            say(error);
            return;
          }
          const progress = quest.objectives.map(() => 0);
          await withCharacterLock([record.id], () =>
            pool.query(
              `INSERT INTO character_quests (character_id, quest_id, status, progress) VALUES ($1, $2, 'active', $3)`,
              [record.id, quest.id, progress],
            ),
          );
          record.activeQuests.set(quest.id, progress);
          say(`接受任務：${quest.name}`);
          this.send(runtime);
        });
        return;

      case 'abandon':
        this.items.run(runtime, async () => {
          if (!record.activeQuests.has(quest.id)) {
            return;
          }
          await withCharacterLock([record.id], () =>
            pool.query(`DELETE FROM character_quests WHERE character_id = $1 AND quest_id = $2 AND status = 'active'`, [
              record.id,
              quest.id,
            ]),
          );
          record.activeQuests.delete(quest.id);
          record.dirtyQuests.delete(quest.id);
          say(`放棄任務：${quest.name}`);
          this.send(runtime);
        });
        return;

      case 'complete':
        this.items.run(runtime, async () => {
          const progress = record.activeQuests.get(quest.id);
          if (!progress) {
            return;
          }
          if (quest.turnIn !== npcId || !this.host.isNearNpc(runtime, npcId)) {
            say('請到回報任務的 NPC 旁邊');
            return;
          }
          const count = (itemId: string): number =>
            record.inventory.filter((i) => i.itemId === itemId).reduce((n, i) => n + i.quantity, 0);
          if (!isQuestReady(quest, progress, count)) {
            say('任務目標還沒完成');
            return;
          }

          // 在背包的副本上：交出收集的道具、放入獎勵道具
          const bag = cloneItems(record.inventory);
          const logs: ItemLogEntry[] = [];
          for (const objective of quest.objectives) {
            if (objective.type === 'collect') {
              if (!takeByItemId(bag, objective.itemId, objective.count)) {
                say('任務道具不足');
                return;
              }
              logs.push({ action: 'quest_turn_in', characterId: record.id, itemId: objective.itemId, quantity: -objective.count, detail: { questId: quest.id } });
            }
          }
          for (const reward of quest.rewards.items) {
            if (!addToContainer(bag, INVENTORY_SIZE, reward, randomUUID)) {
              say('背包空間不足，無法領取獎勵');
              return;
            }
            logs.push({ action: 'quest_reward', characterId: record.id, itemId: reward.itemId, quantity: reward.quantity, detail: { questId: quest.id } });
          }
          if (quest.rewards.coins > 0) {
            logs.push({ action: 'quest_reward', characterId: record.id, coins: quest.rewards.coins, detail: { questId: quest.id } });
          }

          // 「標成已完成」與「發放獎勵」在同一個資料庫交易內：
          // 任務已經不是進行中（例如重複送出回報）時整筆失敗，不會重複領獎
          await this.items.commit([{ runtime, bag, coinsDelta: quest.rewards.coins }], logs, async (db) => {
            const updated = await db.query(
              `UPDATE character_quests SET status = 'done', completed_at = now(), progress = $3
                WHERE character_id = $1 AND quest_id = $2 AND status = 'active'`,
              [record.id, quest.id, progress],
            );
            if (updated.rowCount !== 1) {
              throw new Error(`任務 ${quest.id} 不是進行中，無法回報`);
            }
          });
          record.activeQuests.delete(quest.id);
          record.dirtyQuests.delete(quest.id);
          record.doneQuests.add(quest.id);
          this.host.grantExp(runtime, quest.rewards.exp);

          const rewards = [
            `經驗 ${quest.rewards.exp}`,
            ...(quest.rewards.coins > 0 ? [`星幣 ${quest.rewards.coins}`] : []),
            ...quest.rewards.items.map((r) => `${getItemDef(r.itemId)?.name ?? r.itemId} ×${r.quantity}`),
          ];
          say(`完成任務：${quest.name}（${rewards.join('、')}）`);
          this.send(runtime);
        });
        return;
    }
  }

  /** 玩家參與擊倒了一隻魔物：累計相關任務的擊殺數 */
  onKill(runtime: PlayerRuntime, monsterId: string): void {
    const { record } = runtime;
    let changed = false;
    for (const [questId, progress] of record.activeQuests) {
      const quest = getQuestDef(questId);
      quest?.objectives.forEach((objective, index) => {
        if (objective.type !== 'kill' || objective.monsterId !== monsterId) {
          return;
        }
        const current = progress[index] ?? 0;
        if (current >= objective.count) {
          return;
        }
        progress[index] = current + 1;
        record.dirtyQuests.add(questId);
        runtime.dirty = true;
        changed = true;
        if (current + 1 === objective.count) {
          this.host.sendSystemTo(runtime.client, `任務「${quest.name}」的目標已達成，回去找 NPC 回報吧`);
        }
      });
    }
    if (changed) {
      this.send(runtime);
    }
  }
}
