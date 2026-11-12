// 任務介面（HTML）：畫面上的任務追蹤，以及 NPC 視窗裡的任務對話

import {
  getItemDef,
  getMonsterDef,
  getQuestDef,
  isQuestReady,
  MSG,
  objectiveCounts,
  questAcceptError,
  QUESTS,
  type NpcDef,
  type QuestDef,
  type QuestRequest,
  type QuestsMessage,
} from '@starmemory/shared';
import { el } from './dom';

export class QuestUi {
  private readonly tracker: HTMLDivElement;
  private send: ((type: string, message?: unknown) => void) | null = null;
  private quests: QuestsMessage = { active: [], done: [] };
  private level = 1;
  private countItem: (itemId: string) => number = () => 0;
  /** 內容有變動時通知外部（NPC 視窗開著的話要重畫） */
  private changed: () => void = () => undefined;

  constructor() {
    this.tracker = el('div');
    this.tracker.id = 'quests';
    document.body.appendChild(this.tracker);
    this.render();
  }

  bind(send: (type: string, message?: unknown) => void): void {
    this.send = send;
  }

  unbind(): void {
    this.send = null;
  }

  onChange(handler: () => void): void {
    this.changed = handler;
  }

  private request(request: QuestRequest): void {
    this.send?.(MSG.quest, request);
  }

  // ------------------------------------------------------------ 來自伺服器或其他介面

  onQuests(message: QuestsMessage): void {
    this.quests = message;
    this.refresh();
  }

  setLevel(level: number): void {
    if (level !== this.level) {
      this.level = level;
      this.refresh();
    }
  }

  /** 背包內容變了：收集類任務的數量要重算 */
  setItemCounter(countItem: (itemId: string) => number): void {
    this.countItem = countItem;
    this.refresh();
  }

  private refresh(): void {
    this.render();
    this.changed();
  }

  // ------------------------------------------------------------ 共用

  private progressOf(questId: string): number[] | undefined {
    return this.quests.active.find((q) => q.questId === questId)?.progress;
  }

  /** 把任務目標寫成文字，例如「擊倒 啵啵露 3/5」 */
  private objectiveLines(quest: QuestDef, progress: readonly number[]): string[] {
    const counts = objectiveCounts(quest, progress, this.countItem);
    return quest.objectives.map((objective, index) => {
      const name =
        objective.type === 'kill'
          ? `擊倒 ${getMonsterDef(objective.monsterId)?.name ?? objective.monsterId}`
          : `收集 ${getItemDef(objective.itemId)?.name ?? objective.itemId}`;
      return `${name} ${counts[index]}/${objective.count}`;
    });
  }

  private rewardText(quest: QuestDef): string {
    const parts = [`經驗 ${quest.rewards.exp}`];
    if (quest.rewards.coins > 0) {
      parts.push(`星幣 ${quest.rewards.coins}`);
    }
    for (const item of quest.rewards.items) {
      parts.push(`${getItemDef(item.itemId)?.name ?? item.itemId} ×${item.quantity}`);
    }
    return `獎勵：${parts.join('、')}`;
  }

  // ------------------------------------------------------------ 任務追蹤

  private render(): void {
    this.tracker.replaceChildren();
    if (this.quests.active.length === 0) {
      this.tracker.hidden = true;
      return;
    }
    this.tracker.hidden = false;
    this.tracker.appendChild(el('div', 'q-head', '任務'));
    for (const { questId, progress } of this.quests.active) {
      const quest = getQuestDef(questId);
      if (!quest) {
        continue;
      }
      const ready = isQuestReady(quest, progress, this.countItem);
      const box = el('div', ready ? 'q-item ready' : 'q-item');
      const title = el('div', 'q-title', quest.name);
      const abandon = el('button', 'q-abandon', '放棄');
      abandon.type = 'button';
      abandon.addEventListener('click', () => {
        if (window.confirm(`確定要放棄任務「${quest.name}」嗎？`)) {
          this.request({ action: 'abandon', questId });
        }
      });
      title.appendChild(abandon);
      box.appendChild(title);
      for (const line of this.objectiveLines(quest, progress)) {
        box.appendChild(el('div', 'q-line', line));
      }
      if (ready) {
        box.appendChild(el('div', 'q-line', '可以回報了'));
      }
      this.tracker.appendChild(box);
    }
  }

  // ------------------------------------------------------------ NPC 視窗裡的任務區塊

  /** 這位 NPC 相關的任務（可接的、進行中的、可回報的）；沒有時回傳 null */
  renderForNpc(npc: NpcDef): HTMLElement | null {
    const box = el('div', 'npc-quests');
    const active = new Set(this.quests.active.map((q) => q.questId));
    const done = new Set(this.quests.done);

    for (const quest of QUESTS) {
      const progress = this.progressOf(quest.id);

      // 進行中、由這位 NPC 回報
      if (progress && quest.turnIn === npc.id) {
        const ready = isQuestReady(quest, progress, this.countItem);
        const item = el('div', 'npc-quest');
        item.appendChild(el('div', 'q-title', `${ready ? '？' : '…'} ${quest.name}`));
        item.appendChild(el('div', 'npc-talk', (ready ? quest.dialogue.complete : quest.dialogue.progress).join('\n')));
        for (const line of this.objectiveLines(quest, progress)) {
          item.appendChild(el('div', 'q-line', line));
        }
        if (ready) {
          item.appendChild(el('div', 'q-line', this.rewardText(quest)));
          const button = el('button', 'primary', '回報任務');
          button.type = 'button';
          button.addEventListener('click', () => this.request({ action: 'complete', questId: quest.id, npcId: npc.id }));
          item.appendChild(button);
        }
        box.appendChild(item);
        continue;
      }

      // 還沒接、由這位 NPC 發布
      if (!progress && !done.has(quest.id) && quest.giver === npc.id) {
        const error = questAcceptError(quest, this.level, active, done);
        // 前置任務還沒完成的先不顯示，避免一次列出一長串
        if (quest.prerequisite && !done.has(quest.prerequisite)) {
          continue;
        }
        const item = el('div', 'npc-quest');
        item.appendChild(el('div', 'q-title', `！ ${quest.name}`));
        item.appendChild(el('div', 'npc-talk', quest.dialogue.offer.join('\n')));
        item.appendChild(el('div', 'q-line', quest.description));
        item.appendChild(el('div', 'q-line', this.rewardText(quest)));
        if (error) {
          item.appendChild(el('div', 'q-line q-error', error));
        } else {
          const button = el('button', 'primary', '接受任務');
          button.type = 'button';
          button.addEventListener('click', () => this.request({ action: 'accept', questId: quest.id, npcId: npc.id }));
          item.appendChild(button);
        }
        box.appendChild(item);
      }
    }
    return box.childElementCount > 0 ? box : null;
  }
}
