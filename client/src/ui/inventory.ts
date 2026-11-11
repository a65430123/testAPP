// 背包視窗（HTML，蓋在遊戲畫布右上角）

import { getItemDef, INVENTORY_SIZE, type InventoryMessage } from '@starmemory/shared';

export class InventoryPanel {
  private readonly root: HTMLDivElement;
  private readonly toggle: HTMLButtonElement;
  private readonly body: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly coins: HTMLDivElement;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'inventory';
    this.root.innerHTML = `
      <button type="button" class="inv-toggle">背包</button>
      <div class="inv-body" hidden>
        <div class="inv-coins"></div>
        <div class="inv-grid"></div>
      </div>`;
    document.body.appendChild(this.root);
    this.toggle = this.root.querySelector('.inv-toggle') as HTMLButtonElement;
    this.body = this.root.querySelector('.inv-body') as HTMLDivElement;
    this.grid = this.root.querySelector('.inv-grid') as HTMLDivElement;
    this.coins = this.root.querySelector('.inv-coins') as HTMLDivElement;
    this.toggle.addEventListener('click', () => {
      this.body.hidden = !this.body.hidden;
    });
    this.update({ items: [], coins: 0 });
  }

  /** 以伺服器傳來的內容重畫背包 */
  update(message: InventoryMessage): void {
    this.coins.textContent = `星幣 ${message.coins.toLocaleString()}　${message.items.length}/${INVENTORY_SIZE} 格`;
    this.grid.replaceChildren();
    for (const item of message.items) {
      const def = getItemDef(item.itemId);
      const cell = document.createElement('div');
      cell.className = 'inv-item';
      cell.title = def?.description ?? '';
      const name = document.createElement('span');
      name.textContent = def?.name ?? item.itemId;
      const quantity = document.createElement('span');
      quantity.className = 'inv-qty';
      quantity.textContent = `×${item.quantity}`;
      cell.append(name, quantity);
      this.grid.appendChild(cell);
    }
    if (message.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'inv-empty';
      empty.textContent = '背包是空的';
      this.grid.appendChild(empty);
    }
  }

  destroy(): void {
    this.root.remove();
  }
}
