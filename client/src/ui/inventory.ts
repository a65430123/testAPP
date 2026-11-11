// 背包與裝備欄（HTML，蓋在遊戲畫布右上角）
// 點背包裡的道具會依目前的「模式」做不同的事：平常是使用／裝備／鑲卡，
// 開著商店時是賣出，開著倉庫時是存入，精煉時是選擇要精煉的裝備，交易時是放上交易。

import {
  EQUIP_SLOT_NAME,
  EQUIP_SLOTS,
  getItemDef,
  INVENTORY_SIZE,
  itemDisplayName,
  type InventoryItem,
  type InventoryMessage,
} from '@starmemory/shared';
import { el, itemTooltip } from './dom';

export type InventoryMode = 'normal' | 'shop' | 'storage' | 'refine' | 'trade';

export type InventoryAction =
  | { type: 'use' | 'equip' | 'sell' | 'deposit' | 'refine' | 'trade'; item: InventoryItem }
  | { type: 'unequip'; equipSlot: number }
  | { type: 'card'; card: InventoryItem; target: InventoryItem };

const MODE_HINT: Record<InventoryMode, string> = {
  normal: '點消耗品使用、點裝備穿上、點卡片後再點裝備鑲嵌',
  shop: '商店開啟中：點道具整疊賣出',
  storage: '倉庫開啟中：點道具整疊存入',
  refine: '精煉中：點要精煉的裝備',
  trade: '交易中：點道具放上或收回',
};

export class InventoryPanel {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly coins: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly equipBox: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private actionHandler: ((action: InventoryAction) => void) | null = null;
  private mode: InventoryMode = 'normal';
  private data: InventoryMessage = { items: [], equipment: [], coins: 0 };
  /** 已選好、等著點目標裝備的卡片 */
  private pendingCard: InventoryItem | null = null;
  /** 交易中已放上的道具編號（用來標示） */
  private offered = new Set<string>();

  constructor() {
    this.root = el('div');
    this.root.id = 'inventory';
    const toggle = el('button', 'inv-toggle', '背包');
    toggle.type = 'button';
    this.body = el('div', 'inv-body');
    this.body.hidden = true;
    this.coins = el('div', 'inv-coins');
    this.hint = el('div', 'inv-hint');
    this.equipBox = el('div', 'inv-equip');
    this.grid = el('div', 'inv-grid');
    this.body.append(this.coins, this.hint, el('div', 'inv-title', '裝備'), this.equipBox, el('div', 'inv-title', '背包'), this.grid);
    this.root.append(toggle, this.body);
    document.body.appendChild(this.root);
    toggle.addEventListener('click', () => {
      this.body.hidden = !this.body.hidden;
    });
    this.render();
  }

  /** 設定點擊道具時要呼叫的函式 */
  onAction(handler: ((action: InventoryAction) => void) | null): void {
    this.actionHandler = handler;
  }

  /** 目前的背包內容（最後一次由伺服器同步的） */
  get current(): InventoryMessage {
    return this.data;
  }

  setMode(mode: InventoryMode): void {
    this.mode = mode;
    this.pendingCard = null;
    if (mode !== 'normal') {
      this.body.hidden = false; // 開商店、倉庫、交易時自動打開背包
    }
    this.render();
  }

  /** 交易中：標示哪些道具已放上交易 */
  setOffered(uids: Iterable<string>): void {
    this.offered = new Set(uids);
    this.render();
  }

  /** 以伺服器傳來的內容重畫 */
  update(message: InventoryMessage): void {
    this.data = message;
    if (this.pendingCard && !message.items.some((i) => i.uid === this.pendingCard?.uid)) {
      this.pendingCard = null;
    }
    this.render();
  }

  private render(): void {
    const { items, equipment, coins } = this.data;
    this.coins.textContent = `星幣 ${coins.toLocaleString()}　${items.length}/${INVENTORY_SIZE} 格`;
    this.hint.textContent = this.pendingCard
      ? `請點選要鑲嵌「${getItemDef(this.pendingCard.itemId)?.name ?? ''}」的裝備（點其他地方取消）`
      : MODE_HINT[this.mode];

    // 裝備欄：9 個欄位，點已裝備的道具卸下
    this.equipBox.replaceChildren();
    EQUIP_SLOTS.forEach((slotName, index) => {
      const item = equipment.find((e) => e.slot === index);
      const row = el('div', item ? 'inv-slot filled' : 'inv-slot');
      row.append(el('span', 'inv-slot-name', EQUIP_SLOT_NAME[slotName]), el('span', undefined, item ? itemDisplayName(item) : '—'));
      if (item) {
        row.title = `${itemTooltip(item)}\n（點擊卸下）`;
        row.addEventListener('click', () => this.actionHandler?.({ type: 'unequip', equipSlot: index }));
      }
      this.equipBox.appendChild(row);
    });

    // 背包
    this.grid.replaceChildren();
    for (const item of items) {
      const def = getItemDef(item.itemId);
      const cell = el('div', 'inv-item');
      cell.title = itemTooltip(item);
      cell.append(el('span', undefined, itemDisplayName(item)), el('span', 'inv-qty', `×${item.quantity}`));
      if (this.offered.has(item.uid)) {
        cell.classList.add('offered');
      }
      if (this.pendingCard?.uid === item.uid) {
        cell.classList.add('selected');
      }
      if (this.isClickable(item)) {
        cell.classList.add('usable');
        cell.addEventListener('click', () => this.onItemClick(item));
      }
      if (def?.type === 'equipment') {
        cell.classList.add('equipment');
      }
      this.grid.appendChild(cell);
    }
    if (items.length === 0) {
      this.grid.appendChild(el('div', 'inv-empty', '背包是空的'));
    }
  }

  private isClickable(item: InventoryItem): boolean {
    const def = getItemDef(item.itemId);
    if (!def) {
      return false;
    }
    if (this.pendingCard) {
      return def.type === 'equipment' || item.uid === this.pendingCard.uid;
    }
    switch (this.mode) {
      case 'normal':
        return (def.type === 'consumable' && def.effect !== undefined) || def.type === 'equipment' || def.type === 'card';
      case 'refine':
        return def.type === 'equipment';
      default:
        return true;
    }
  }

  private onItemClick(item: InventoryItem): void {
    const def = getItemDef(item.itemId);
    if (!def) {
      return;
    }
    // 已選好卡片：這次點擊是選目標裝備
    if (this.pendingCard) {
      const card = this.pendingCard;
      this.pendingCard = null;
      if (def.type === 'equipment') {
        this.actionHandler?.({ type: 'card', card, target: item });
      }
      this.render();
      return;
    }
    switch (this.mode) {
      case 'shop':
        this.actionHandler?.({ type: 'sell', item });
        return;
      case 'storage':
        this.actionHandler?.({ type: 'deposit', item });
        return;
      case 'refine':
        this.actionHandler?.({ type: 'refine', item });
        return;
      case 'trade':
        this.actionHandler?.({ type: 'trade', item });
        return;
      case 'normal':
        if (def.type === 'consumable') {
          this.actionHandler?.({ type: 'use', item });
        } else if (def.type === 'equipment') {
          this.actionHandler?.({ type: 'equip', item });
        } else if (def.type === 'card') {
          this.pendingCard = item;
          this.render();
        }
        return;
    }
  }

  destroy(): void {
    this.root.remove();
  }
}
