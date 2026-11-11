// NPC 視窗（HTML）：依 NPC 種類顯示商店、精煉或倉庫

import {
  getItemDef,
  itemDisplayName,
  REFINE_MAX,
  REFINE_TABLE,
  refineFee,
  refineMaterial,
  STORAGE_SIZE,
  type InventoryItem,
  type NpcDef,
} from '@starmemory/shared';
import { el, itemTooltip } from './dom';

export interface NpcHandlers {
  buy(npcId: string, itemId: string, quantity: number): void;
  refine(npcId: string, slot: number): void;
  withdraw(npcId: string, slot: number, quantity: number): void;
  closed(): void;
}

export class NpcWindow {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private handlers: NpcHandlers | null = null;
  private npc: NpcDef | null = null;
  private storage: InventoryItem[] = [];
  private refineTarget: InventoryItem | null = null;

  constructor() {
    this.root = el('div');
    this.root.id = 'npc';
    this.root.hidden = true;
    const header = el('div', 'win-header');
    this.title = el('div', 'win-title');
    const close = el('button', 'win-close', '×');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    header.append(this.title, close);
    this.content = el('div', 'win-content');
    this.root.append(header, this.content);
    document.body.appendChild(this.root);
  }

  setHandlers(handlers: NpcHandlers | null): void {
    this.handlers = handlers;
  }

  /** 目前開著的 NPC；沒開時為 null */
  get current(): NpcDef | null {
    return this.npc;
  }

  open(npc: NpcDef): void {
    this.npc = npc;
    this.refineTarget = null;
    this.storage = [];
    this.root.hidden = false;
    this.render();
  }

  close(): void {
    if (!this.npc) {
      return;
    }
    this.npc = null;
    this.root.hidden = true;
    this.handlers?.closed();
  }

  /** 伺服器傳來倉庫內容 */
  setStorage(items: InventoryItem[]): void {
    this.storage = items;
    this.render();
  }

  /** 選擇（或更新）要精煉的裝備；傳 null 清除 */
  setRefineTarget(item: InventoryItem | null): void {
    this.refineTarget = item;
    this.render();
  }

  get refineTargetUid(): string | null {
    return this.refineTarget?.uid ?? null;
  }

  private render(): void {
    const npc = this.npc;
    if (!npc) {
      return;
    }
    this.title.textContent = npc.name;
    this.content.replaceChildren();
    if (npc.type === 'shop') {
      this.renderShop(npc);
    } else if (npc.type === 'refine') {
      this.renderRefine(npc);
    } else {
      this.renderStorage(npc);
    }
  }

  private renderShop(npc: NpcDef): void {
    this.content.appendChild(el('div', 'win-hint', '點背包中的道具可以整疊賣出'));
    for (const itemId of npc.sells ?? []) {
      const def = getItemDef(itemId);
      if (!def || def.buyPrice === undefined) {
        continue;
      }
      const row = el('div', 'shop-row');
      const name = el('span', 'shop-name', def.name);
      name.title = itemTooltip({ uid: '', itemId, quantity: 1, refine: 0, cardSlots: 0, cards: [] });
      row.append(name, el('span', 'shop-price', `${def.buyPrice} 星幣`));
      for (const quantity of def.maxStack > 1 ? [1, 10] : [1]) {
        const button = el('button', undefined, `買 ${quantity}`);
        button.type = 'button';
        button.addEventListener('click', () => this.handlers?.buy(npc.id, itemId, quantity));
        row.appendChild(button);
      }
      this.content.appendChild(row);
    }
  }

  private renderRefine(npc: NpcDef): void {
    const target = this.refineTarget;
    const equip = target ? getItemDef(target.itemId)?.equip : undefined;
    if (!target || !equip) {
      this.content.appendChild(el('div', 'win-hint', '請點選背包中要精煉的裝備（穿在身上的要先卸下）'));
      return;
    }
    this.content.appendChild(el('div', 'refine-name', itemDisplayName(target)));
    const step = REFINE_TABLE[target.refine];
    if (target.refine >= REFINE_MAX || !step) {
      this.content.appendChild(el('div', 'win-hint', '已經精煉到最高等級'));
      return;
    }
    const material = getItemDef(refineMaterial(equip.type))?.name ?? '';
    const info = el(
      'div',
      'refine-info',
      `+${target.refine} → +${target.refine + 1}\n成功率 ${step.rate}%\n費用 ${refineFee(equip, target.refine)} 星幣、${material} ×1\n` +
        (step.downgrade ? '失敗會降 1 級' : '失敗不會降級'),
    );
    const button = el('button', 'primary', '精煉');
    button.type = 'button';
    button.addEventListener('click', () => this.handlers?.refine(npc.id, target.slot));
    this.content.append(info, button);
  }

  private renderStorage(npc: NpcDef): void {
    this.content.appendChild(
      el('div', 'win-hint', `倉庫 ${this.storage.length}/${STORAGE_SIZE} 格（同帳號的角色共用）。點倉庫的道具取出，點背包的道具存入`),
    );
    const grid = el('div', 'inv-grid');
    for (const item of this.storage) {
      const cell = el('div', 'inv-item usable');
      cell.title = itemTooltip(item);
      cell.append(el('span', undefined, itemDisplayName(item)), el('span', 'inv-qty', `×${item.quantity}`));
      cell.addEventListener('click', () => this.handlers?.withdraw(npc.id, item.slot, item.quantity));
      grid.appendChild(cell);
    }
    if (this.storage.length === 0) {
      grid.appendChild(el('div', 'inv-empty', '倉庫是空的'));
    }
    this.content.appendChild(grid);
  }

  destroy(): void {
    this.root.remove();
  }
}
