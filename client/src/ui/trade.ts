// 交易視窗（HTML）：邀請提示、雙方放上的內容、確認與取消

import { itemDisplayName, TRADE_TAX, type TradeSide, type TradeStateMessage } from '@starmemory/shared';
import { el, itemTooltip } from './dom';

export interface TradeHandlers {
  /** 送出自己放上交易的完整內容 */
  offer(items: Array<{ uid: string; quantity: number }>, coins: number): void;
  confirm(): void;
  cancel(): void;
}

export class TradeWindow {
  private readonly root: HTMLDivElement;
  private readonly prompt: HTMLDivElement;
  private handlers: TradeHandlers | null = null;
  private state: TradeStateMessage | null = null;

  constructor() {
    this.root = el('div');
    this.root.id = 'trade';
    this.root.hidden = true;
    this.prompt = el('div');
    this.prompt.id = 'trade-prompt';
    this.prompt.hidden = true;
    document.body.append(this.root, this.prompt);
  }

  setHandlers(handlers: TradeHandlers | null): void {
    this.handlers = handlers;
  }

  get isOpen(): boolean {
    return this.state !== null;
  }

  /** 自己目前放上的道具（唯一編號 → 數量） */
  get myItems(): Map<string, number> {
    return new Map((this.state?.mine.items ?? []).map((i) => [i.uid, i.quantity]));
  }

  /** 顯示一個是／否的小提示（詢問是否提出交易、是否接受邀請） */
  ask(text: string, yesLabel: string, onAnswer: (yes: boolean) => void): void {
    this.prompt.replaceChildren(el('span', undefined, text));
    const answer = (yes: boolean): void => {
      this.prompt.hidden = true;
      onAnswer(yes);
    };
    const yes = el('button', 'primary', yesLabel);
    yes.type = 'button';
    yes.addEventListener('click', () => answer(true));
    const no = el('button', undefined, '取消');
    no.type = 'button';
    no.addEventListener('click', () => answer(false));
    this.prompt.append(yes, no);
    this.prompt.hidden = false;
  }

  /** 伺服器傳來交易的最新內容 */
  update(state: TradeStateMessage): void {
    this.state = state;
    this.prompt.hidden = true;
    this.root.hidden = false;
    this.render();
  }

  /** 交易結束（完成或取消） */
  close(): void {
    this.state = null;
    this.root.hidden = true;
  }

  private render(): void {
    const state = this.state;
    if (!state) {
      return;
    }
    this.root.replaceChildren();
    this.root.appendChild(el('div', 'win-title', `與 ${state.theirs.name} 交易`));
    const columns = el('div', 'trade-columns');
    columns.append(this.renderSide('我放上的', state.mine, true), this.renderSide(`${state.theirs.name} 放上的`, state.theirs, false));
    this.root.appendChild(columns);
    this.root.appendChild(
      el('div', 'win-hint', `點背包的道具放上或收回。星幣交易收 ${TRADE_TAX * 100}% 稅。任何一方修改內容，雙方都要重新確認。`),
    );
    const buttons = el('div', 'trade-buttons');
    const confirm = el('button', 'primary', state.mine.confirmed ? '已確認，等待對方' : '確認交易');
    confirm.type = 'button';
    confirm.disabled = state.mine.confirmed;
    confirm.addEventListener('click', () => this.handlers?.confirm());
    const cancel = el('button', undefined, '取消交易');
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.handlers?.cancel());
    buttons.append(confirm, cancel);
    this.root.appendChild(buttons);
  }

  private renderSide(title: string, side: TradeSide, mine: boolean): HTMLDivElement {
    const box = el('div', 'trade-side');
    box.appendChild(el('div', side.confirmed ? 'trade-head confirmed' : 'trade-head', `${title}${side.confirmed ? '（已確認）' : ''}`));
    for (const item of side.items) {
      const row = el('div', 'inv-item');
      row.title = itemTooltip(item);
      row.append(el('span', undefined, itemDisplayName(item)), el('span', 'inv-qty', `×${item.quantity}`));
      box.appendChild(row);
    }
    if (side.items.length === 0) {
      box.appendChild(el('div', 'inv-empty', '（沒有道具）'));
    }
    if (mine) {
      // 自己的星幣可以修改：改完按「更新」送出
      const coinRow = el('div', 'trade-coins');
      const input = el('input');
      input.type = 'number';
      input.min = '0';
      input.value = String(side.coins);
      input.addEventListener('keydown', (event) => event.stopPropagation());
      const set = el('button', undefined, '更新星幣');
      set.type = 'button';
      set.addEventListener('click', () => {
        const coins = Math.max(0, Math.floor(Number(input.value) || 0));
        this.handlers?.offer(
          side.items.map((i) => ({ uid: i.uid, quantity: i.quantity })),
          coins,
        );
      });
      coinRow.append(el('span', undefined, '星幣'), input, set);
      box.appendChild(coinRow);
    } else {
      box.appendChild(el('div', 'trade-coins', `星幣 ${side.coins.toLocaleString()}`));
    }
    return box;
  }

  destroy(): void {
    this.root.remove();
    this.prompt.remove();
  }
}
