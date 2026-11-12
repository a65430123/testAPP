// 道具相關介面的總管：背包、NPC 視窗、交易視窗之間的互動，以及把操作轉成訊息送給伺服器。
// 世界場景只需要把伺服器的訊息轉交進來，並在點到 NPC 或玩家時呼叫對應的方法。

import {
  getNpcDef,
  MSG,
  type CardInsertRequest,
  type EquipRequest,
  type InventoryMessage,
  type RefineRequest,
  type ShopBuyRequest,
  type ShopSellRequest,
  type StorageMessage,
  type StorageMoveRequest,
  type StorageOpenRequest,
  type TradeEndMessage,
  type TradeInviteMessage,
  type TradeOfferRequest,
  type TradeRequest,
  type TradeRespondRequest,
  type TradeStateMessage,
  type UnequipRequest,
  type UseItemRequest,
} from '@starmemory/shared';
import { InventoryPanel, type InventoryAction, type InventoryMode } from './inventory';
import { NpcWindow } from './npc';
import { TradeWindow } from './trade';

/** 把訊息送給伺服器的函式（由世界場景在進入房間後提供） */
export type SendFn = (type: string, message?: unknown) => void;

export class ItemUi {
  readonly inventory = new InventoryPanel();
  readonly npc = new NpcWindow();
  readonly trade = new TradeWindow();
  private send: SendFn | null = null;
  private notify: (text: string) => void = () => undefined;
  /** 自己目前放上交易的星幣（改動道具時要一併送出，才不會被清掉） */
  private tradeCoins = 0;

  constructor() {
    this.inventory.onAction((action) => this.onInventoryAction(action));
    this.npc.setHandlers({
      buy: (npcId, itemId, quantity) => this.send?.(MSG.shopBuy, { npcId, itemId, quantity } satisfies ShopBuyRequest),
      refine: (npcId, slot) => this.send?.(MSG.refine, { npcId, slot } satisfies RefineRequest),
      withdraw: (npcId, slot, quantity) =>
        this.send?.(MSG.storageWithdraw, { npcId, slot, quantity } satisfies StorageMoveRequest),
      closed: () => this.refreshMode(),
    });
    this.trade.setHandlers({
      offer: (items, coins) => this.send?.(MSG.tradeOffer, { items, coins } satisfies TradeOfferRequest),
      confirm: () => this.send?.(MSG.tradeConfirm),
      cancel: () => this.send?.(MSG.tradeCancel),
    });
  }

  /** 進入房間後呼叫：之後的操作都送到這個房間 */
  bind(send: SendFn, notify: (text: string) => void): void {
    this.send = send;
    this.notify = notify;
  }

  /** 離開房間（切換地圖、斷線）時呼叫：關閉視窗並停止送訊息 */
  unbind(): void {
    this.send = null;
    this.trade.close();
    this.npc.close();
    this.refreshMode();
  }

  // ------------------------------------------------------------ 來自伺服器

  onInventory(message: InventoryMessage): void {
    this.inventory.update(message);
    // 精煉視窗顯示的是某一件裝備：背包更新後換成最新的資料（等級可能變了）
    const uid = this.npc.refineTargetUid;
    if (uid) {
      this.npc.setRefineTarget(message.items.find((i) => i.uid === uid) ?? null);
    }
  }

  onStorage(message: StorageMessage): void {
    this.npc.setStorage(message.items);
  }

  onTradeInvite(message: TradeInviteMessage): void {
    this.trade.ask(`${message.fromName} 想和你交易`, '接受', (accept) => {
      this.send?.(MSG.tradeRespond, { accept } satisfies TradeRespondRequest);
    });
  }

  onTradeState(message: TradeStateMessage): void {
    this.trade.update(message);
    this.tradeCoins = message.mine.coins;
    this.inventory.setOffered(message.mine.items.map((i) => i.uid));
    this.refreshMode();
  }

  onTradeEnd(message: TradeEndMessage): void {
    this.trade.close();
    this.tradeCoins = 0;
    this.inventory.setOffered([]);
    this.refreshMode();
    this.notify(message.reason);
  }

  // ------------------------------------------------------------ 來自世界場景

  /** 玩家走到 NPC 旁邊並點了他 */
  openNpc(npcId: string): void {
    const def = getNpcDef(npcId);
    if (!def || !this.send) {
      return;
    }
    this.npc.open(def);
    if (def.type === 'storage') {
      this.send(MSG.storageOpen, { npcId } satisfies StorageOpenRequest);
    }
    this.refreshMode();
  }

  /** 玩家點了另一位玩家：詢問是否提出交易 */
  askTrade(targetId: string, name: string): void {
    if (this.trade.isOpen) {
      return;
    }
    this.trade.ask(`要和 ${name} 交易嗎？`, '提出交易', (yes) => {
      if (yes) {
        this.send?.(MSG.tradeRequest, { targetId } satisfies TradeRequest);
      }
    });
  }

  // ------------------------------------------------------------ 背包點擊

  /** 交易優先於 NPC：交易中點背包一律是放上交易 */
  private refreshMode(): void {
    let mode: InventoryMode = 'normal';
    if (this.trade.isOpen) {
      mode = 'trade';
    } else if (this.npc.current && this.npc.current.type !== 'talk') {
      mode = this.npc.current.type;
    }
    this.inventory.setMode(mode);
  }

  private onInventoryAction(action: InventoryAction): void {
    const send = this.send;
    if (!send) {
      return;
    }
    const npcId = this.npc.current?.id ?? '';
    switch (action.type) {
      case 'use':
        send(MSG.useItem, { slot: action.item.slot } satisfies UseItemRequest);
        return;
      case 'equip':
        send(MSG.equip, { slot: action.item.slot } satisfies EquipRequest);
        return;
      case 'unequip':
        send(MSG.unequip, { equipSlot: action.equipSlot } satisfies UnequipRequest);
        return;
      case 'card':
        send(MSG.cardInsert, { cardSlot: action.card.slot, targetSlot: action.target.slot } satisfies CardInsertRequest);
        return;
      case 'sell':
        send(MSG.shopSell, { npcId, slot: action.item.slot, quantity: action.item.quantity } satisfies ShopSellRequest);
        return;
      case 'deposit':
        send(MSG.storageDeposit, { npcId, slot: action.item.slot, quantity: action.item.quantity } satisfies StorageMoveRequest);
        return;
      case 'refine':
        this.npc.setRefineTarget(action.item);
        return;
      case 'trade': {
        // 點一下放上整疊，再點一下收回
        const items = this.trade.myItems;
        if (items.has(action.item.uid)) {
          items.delete(action.item.uid);
        } else {
          items.set(action.item.uid, action.item.quantity);
        }
        const coins = this.tradeCoins;
        send(MSG.tradeOffer, {
          items: [...items].map(([uid, quantity]) => ({ uid, quantity })),
          coins,
        } satisfies TradeOfferRequest);
        return;
      }
    }
  }

}
