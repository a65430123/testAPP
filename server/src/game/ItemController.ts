// 道具操作：使用、裝備、商店、精煉、卡片鑲嵌、倉庫。
// 每個操作都是「在背包的副本上試算 → 連同紀錄寫入資料庫 → 成功後才更新記憶體」，
// 中途任何一步失敗，玩家的道具與星幣都維持原狀。

import { randomUUID } from 'node:crypto';
import type { Client } from 'colyseus';
import type { PoolClient } from 'pg';
import {
  addToContainer,
  cloneItems,
  EQUIP_SLOTS,
  equipError,
  getItemDef,
  getNpcDef,
  INVENTORY_SIZE,
  itemDisplayName,
  moveBetween,
  MSG,
  NPC_RANGE,
  REFINE_MAX,
  REFINE_TABLE,
  refineFee,
  refineMaterial,
  SHOP_MAX_QUANTITY,
  slotsForType,
  STORAGE_SIZE,
  takeByItemId,
  takeFromSlot,
  type InventoryItem,
  type ItemDef,
  type NewItem,
  type NpcDef,
  type NpcType,
  type StorageMessage,
} from '@starmemory/shared';
import { commitItemChange, loadStorage, type ItemLogEntry, type OwnerChange } from '../db/items';
import type { GameMap } from '../maps';
import type { PlayerRuntime } from '../rooms/runtime';

/** 房間提供給道具控制器的介面 */
export interface ItemHost {
  readonly map: GameMap;
  /** 取得可以行動的玩家（存在、沒倒地、沒在傳送，且沒有送太快） */
  actingPlayer(client: Client): PlayerRuntime | null;
  /** 玩家是否還在這個房間（操作排隊期間可能已離線或切換地圖） */
  isActive(runtime: PlayerRuntime): boolean;
  sendSystemTo(client: Client, text: string): void;
  sendInventory(runtime: PlayerRuntime): void;
  /** 裝備改變後重新計算戰鬥數值 */
  refreshCombat(runtime: PlayerRuntime): void;
  /** 消耗品現在用了有沒有效果（例如滿血時喝藥水沒有意義） */
  consumableUseful(runtime: PlayerRuntime, def: ItemDef): boolean;
  /** 套用消耗品的效果 */
  applyConsumable(runtime: PlayerRuntime, def: ItemDef): void;
}

/** 一位玩家在這次操作後的新狀態（沒給的部分不變） */
export interface RuntimeChange {
  runtime: PlayerRuntime;
  bag?: InventoryItem[];
  equip?: InventoryItem[];
  storage?: InventoryItem[];
  coinsDelta?: number;
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export class ItemController {
  constructor(private readonly host: ItemHost) {}

  // ------------------------------------------------------------ 共用機制

  /**
   * 把操作排進玩家的道具佇列；操作內丟出的例外視為「操作失敗」並通知玩家。
   * 任務與公會等會動到道具或星幣的操作也排在同一個佇列裡。
   */
  run(runtime: PlayerRuntime, op: () => Promise<void>): void {
    runtime.itemQueue = runtime.itemQueue.then(async () => {
      if (!this.host.isActive(runtime)) {
        return;
      }
      try {
        await op();
      } catch (err) {
        console.error(`[items] 角色 ${runtime.record.name} 的道具操作失敗：`, err);
        this.host.sendSystemTo(runtime.client, '操作失敗，請稍後再試');
      }
    });
  }

  /**
   * 把一次異動寫入資料庫（道具、星幣、紀錄在同一個交易內），成功後才更新記憶體並通知用戶端。
   * 也供交易、任務、公會使用。
   * @param extra 要在同一個資料庫交易內一起執行的其他寫入
   */
  async commit(
    changes: RuntimeChange[],
    logs: ItemLogEntry[],
    extra?: (client: PoolClient) => Promise<void>,
  ): Promise<void> {
    // 有星幣異動時，順便把打怪得到、還沒寫進資料庫的星幣一起寫入，
    // 這樣資料庫的餘額與記憶體一致，不會因為「資料庫裡錢還不夠」而失敗
    const flushed = changes.map((c) => (c.coinsDelta ? c.runtime.record.unsavedCoins : 0));
    changes.forEach((c, i) => {
      c.runtime.record.unsavedCoins -= flushed[i]!;
    });
    const ownerChanges: OwnerChange[] = changes.map((c, i) => ({
      characterId: c.runtime.record.id,
      accountId: c.runtime.record.accountId,
      coinsDelta: (c.coinsDelta ?? 0) + flushed[i]!,
      ...(c.bag ? { bag: c.bag } : {}),
      ...(c.equip ? { equip: c.equip } : {}),
      ...(c.storage ? { storage: c.storage } : {}),
    }));
    try {
      await commitItemChange(ownerChanges, logs, extra);
    } catch (err) {
      changes.forEach((c, i) => {
        c.runtime.record.unsavedCoins += flushed[i]!;
      });
      throw err;
    }

    for (const c of changes) {
      const { record } = c.runtime;
      if (c.bag) {
        record.inventory = c.bag;
      }
      if (c.equip) {
        record.equipment = c.equip;
      }
      if (c.storage) {
        c.runtime.storage = c.storage;
      }
      record.coins += c.coinsDelta ?? 0;
      if (c.equip) {
        this.host.refreshCombat(c.runtime);
      }
      this.host.sendInventory(c.runtime);
      if (c.storage) {
        this.sendStorage(c.runtime);
      }
    }
  }

  private sendStorage(runtime: PlayerRuntime): void {
    const message: StorageMessage = { items: runtime.storage ?? [] };
    runtime.client.send(MSG.storage, message);
  }

  /** 確認玩家就在指定種類的 NPC 旁邊；不符合時回傳 null */
  private npcNearby(runtime: PlayerRuntime, npcId: unknown, type: NpcType): NpcDef | null {
    const def = typeof npcId === 'string' ? getNpcDef(npcId) : undefined;
    const placement = this.host.map.npcs.find((n) => n.npcId === npcId);
    if (!def || def.type !== type || !placement) {
      return null;
    }
    const distance = Math.hypot(runtime.move.x - placement.x, runtime.move.y - placement.y);
    // 多給半格寬限，補償用戶端畫面與伺服器位置的些微落差
    if (distance > NPC_RANGE + 0.5) {
      this.host.sendSystemTo(runtime.client, `離${def.name}太遠了`);
      return null;
    }
    return def;
  }

  // ------------------------------------------------------------ 取得道具（撿取、GM）

  /**
   * 把道具放進玩家背包並留下紀錄。
   * @returns 是否成功（背包放不下或寫入失敗時為 false）
   */
  grant(runtime: PlayerRuntime, item: NewItem, action: 'pickup' | 'gm'): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      this.run(runtime, async () => {
        const bag = cloneItems(runtime.record.inventory);
        const before = new Set(bag.map((i) => i.uid));
        if (!addToContainer(bag, INVENTORY_SIZE, item, randomUUID)) {
          this.host.sendSystemTo(runtime.client, '背包已滿');
          return;
        }
        // 新產生的道具實體（不可堆疊的道具）逐一記錄編號；堆疊進既有格子的只記數量
        const created = bag.filter((i) => !before.has(i.uid));
        const logs: ItemLogEntry[] =
          created.length > 0 && getItemDef(item.itemId)?.maxStack === 1
            ? created.map((i) => ({
                action,
                characterId: runtime.record.id,
                itemUid: i.uid,
                itemId: i.itemId,
                quantity: i.quantity,
              }))
            : [{ action, characterId: runtime.record.id, itemId: item.itemId, quantity: item.quantity }];
        await this.commit([{ runtime, bag }], logs);
        done = true;
      });
      // 不論成功、失敗或被略過（玩家已離線），佇列跑到這裡時回報結果
      void runtime.itemQueue.then(() => resolve(done));
    });
  }

  /** GM 指令：直接增減星幣（留下紀錄） */
  gmCoins(runtime: PlayerRuntime, amount: number): void {
    this.run(runtime, async () => {
      await this.commit(
        [{ runtime, coinsDelta: amount }],
        [{ action: 'gm', characterId: runtime.record.id, coins: amount }],
      );
      this.host.sendSystemTo(runtime.client, `星幣 ${amount >= 0 ? '+' : ''}${amount}`);
    });
  }

  // ------------------------------------------------------------ 使用消耗品

  handleUseItem(client: Client, message: unknown): void {
    const runtime = this.host.actingPlayer(client);
    const slot = (message as { slot?: unknown } | null)?.slot;
    if (!runtime || !isInt(slot)) {
      return;
    }
    this.run(runtime, async () => {
      const { record } = runtime;
      const item = record.inventory.find((i) => i.slot === slot);
      const def = item ? getItemDef(item.itemId) : undefined;
      if (!item || !def || def.type !== 'consumable' || !def.effect) {
        return;
      }
      if (!this.host.consumableUseful(runtime, def)) {
        this.host.sendSystemTo(client, '現在不需要使用');
        return;
      }
      const bag = cloneItems(record.inventory);
      if (!takeFromSlot(bag, slot, 1)) {
        return;
      }
      await this.commit(
        [{ runtime, bag }],
        [{ action: 'use', characterId: record.id, itemId: def.id, quantity: -1 }],
      );
      this.host.applyConsumable(runtime, def);
    });
  }

  // ------------------------------------------------------------ 裝備與卸下

  handleEquip(client: Client, message: unknown): void {
    const runtime = this.host.actingPlayer(client);
    const slot = (message as { slot?: unknown } | null)?.slot;
    if (!runtime || !isInt(slot)) {
      return;
    }
    this.run(runtime, async () => {
      const { record } = runtime;
      const item = record.inventory.find((i) => i.slot === slot);
      const def = item ? getItemDef(item.itemId) : undefined;
      const error = item ? equipError(def, runtime.cls, record.level) : '找不到道具';
      if (!item || !def?.equip || error) {
        this.host.sendSystemTo(client, error ?? '無法裝備');
        return;
      }
      // 優先放進空的欄位（飾品有兩格），都滿了就替換第一格
      const candidates = slotsForType(def.equip.type).map((s) => EQUIP_SLOTS.indexOf(s));
      const equipSlot = candidates.find((s) => !record.equipment.some((e) => e.slot === s)) ?? candidates[0]!;

      const bag = cloneItems(record.inventory);
      const equip = cloneItems(record.equipment);
      const taken = takeFromSlot(bag, slot, 1);
      if (!taken) {
        return;
      }
      // 原本穿著的裝備換回背包，放在剛空出來的那一格
      const previousIndex = equip.findIndex((e) => e.slot === equipSlot);
      if (previousIndex >= 0) {
        const [previous] = equip.splice(previousIndex, 1);
        bag.push({ ...previous!, slot });
        bag.sort((a, b) => a.slot - b.slot);
      }
      equip.push({ ...taken, slot: equipSlot });
      equip.sort((a, b) => a.slot - b.slot);
      // 裝備與卸下只是同一位玩家身上的位置變動，不產生也不消滅道具，所以不寫異動紀錄
      await this.commit([{ runtime, bag, equip }], []);
    });
  }

  handleUnequip(client: Client, message: unknown): void {
    const runtime = this.host.actingPlayer(client);
    const equipSlot = (message as { equipSlot?: unknown } | null)?.equipSlot;
    if (!runtime || !isInt(equipSlot)) {
      return;
    }
    this.run(runtime, async () => {
      const { record } = runtime;
      const bag = cloneItems(record.inventory);
      const equip = cloneItems(record.equipment);
      const taken = takeFromSlot(equip, equipSlot, 1);
      if (!taken) {
        return;
      }
      if (!addToContainer(bag, INVENTORY_SIZE, taken, randomUUID, taken.uid)) {
        this.host.sendSystemTo(client, '背包已滿，無法卸下');
        return;
      }
      await this.commit([{ runtime, bag, equip }], []);
    });
  }

  // ------------------------------------------------------------ NPC 商店

  handleShopBuy(client: Client, message: unknown): void {
    const runtime = this.host.actingPlayer(client);
    const payload = message as { npcId?: unknown; itemId?: unknown; quantity?: unknown } | null;
    const quantity = payload?.quantity;
    if (!runtime || !isInt(quantity) || quantity < 1 || quantity > SHOP_MAX_QUANTITY) {
      return;
    }
    this.run(runtime, async () => {
      const npc = this.npcNearby(runtime, payload?.npcId, 'shop');
      const def = typeof payload?.itemId === 'string' ? getItemDef(payload.itemId) : undefined;
      // 只能買這位 NPC 有賣的東西，價格以伺服器的資料表為準
      if (!npc || !def || def.buyPrice === undefined || !npc.sells?.includes(def.id)) {
        return;
      }
      const { record } = runtime;
      const price = def.buyPrice * quantity;
      if (record.coins < price) {
        this.host.sendSystemTo(client, '星幣不足');
        return;
      }
      const bag = cloneItems(record.inventory);
      const before = new Set(bag.map((i) => i.uid));
      if (!addToContainer(bag, INVENTORY_SIZE, { itemId: def.id, quantity }, randomUUID)) {
        this.host.sendSystemTo(client, '背包已滿');
        return;
      }
      const created = def.maxStack === 1 ? bag.filter((i) => !before.has(i.uid)) : [];
      const logs: ItemLogEntry[] =
        created.length > 0
          ? created.map((i, index) => ({
              action: 'shop_buy' as const,
              characterId: record.id,
              itemUid: i.uid,
              itemId: def.id,
              quantity: 1,
              coins: index === 0 ? -price : 0,
              detail: { npcId: npc.id },
            }))
          : [{ action: 'shop_buy', characterId: record.id, itemId: def.id, quantity, coins: -price, detail: { npcId: npc.id } }];
      await this.commit([{ runtime, bag, coinsDelta: -price }], logs);
      this.host.sendSystemTo(client, `購買 ${def.name} ×${quantity}，花費 ${price} 星幣`);
    });
  }

  handleShopSell(client: Client, message: unknown): void {
    const runtime = this.host.actingPlayer(client);
    const payload = message as { npcId?: unknown; slot?: unknown; quantity?: unknown } | null;
    const slot = payload?.slot;
    const quantity = payload?.quantity;
    if (!runtime || !isInt(slot) || !isInt(quantity) || quantity < 1) {
      return;
    }
    this.run(runtime, async () => {
      if (!this.npcNearby(runtime, payload?.npcId, 'shop')) {
        return;
      }
      const { record } = runtime;
      const bag = cloneItems(record.inventory);
      const taken = takeFromSlot(bag, slot, quantity);
      const def = taken ? getItemDef(taken.itemId) : undefined;
      if (!taken || !def) {
        return;
      }
      const income = def.sellPrice * quantity;
      await this.commit(
        [{ runtime, bag, coinsDelta: income }],
        [
          {
            action: 'shop_sell',
            characterId: record.id,
            itemUid: taken.uid,
            itemId: taken.itemId,
            quantity: -quantity,
            coins: income,
            detail: { npcId: payload?.npcId, refine: taken.refine, cards: taken.cards },
          },
        ],
      );
      this.host.sendSystemTo(client, `賣出 ${itemDisplayName(taken)} ×${quantity}，獲得 ${income} 星幣`);
    });
  }

  // ------------------------------------------------------------ 精煉

  handleRefine(client: Client, message: unknown): void {
    const runtime = this.host.actingPlayer(client);
    const payload = message as { npcId?: unknown; slot?: unknown } | null;
    const slot = payload?.slot;
    if (!runtime || !isInt(slot)) {
      return;
    }
    this.run(runtime, async () => {
      if (!this.npcNearby(runtime, payload?.npcId, 'refine')) {
        return;
      }
      const { record } = runtime;
      const bag = cloneItems(record.inventory);
      const target = bag.find((i) => i.slot === slot);
      const def = target ? getItemDef(target.itemId) : undefined;
      if (!target || !def?.equip) {
        this.host.sendSystemTo(client, '只能精煉背包中的裝備');
        return;
      }
      const step = REFINE_TABLE[target.refine];
      if (target.refine >= REFINE_MAX || !step) {
        this.host.sendSystemTo(client, '已經精煉到最高等級');
        return;
      }
      const fee = refineFee(def.equip, target.refine);
      const materialId = refineMaterial(def.equip.type);
      if (record.coins < fee) {
        this.host.sendSystemTo(client, `星幣不足（需要 ${fee}）`);
        return;
      }
      if (!takeByItemId(bag, materialId, 1)) {
        this.host.sendSystemTo(client, `缺少材料：${getItemDef(materialId)?.name ?? materialId}`);
        return;
      }

      // 成功與否由伺服器擲骰；不論成敗，材料與費用都會消耗
      const from = target.refine;
      const success = Math.random() * 100 < step.rate;
      target.refine = success ? from + 1 : step.downgrade ? Math.max(0, from - 1) : from;
      await this.commit(
        [{ runtime, bag, coinsDelta: -fee }],
        [
          {
            action: 'refine',
            characterId: record.id,
            itemUid: target.uid,
            itemId: target.itemId,
            coins: -fee,
            detail: { from, to: target.refine, success },
          },
          { action: 'refine', characterId: record.id, itemId: materialId, quantity: -1 },
        ],
      );
      const name = def.name;
      this.host.sendSystemTo(
        client,
        success
          ? `精煉成功！${name} +${from} → +${target.refine}`
          : target.refine < from
            ? `精煉失敗，${name} 降為 +${target.refine}`
            : `精煉失敗，${name} 維持 +${from}`,
      );
    });
  }

  // ------------------------------------------------------------ 卡片鑲嵌

  handleCardInsert(client: Client, message: unknown): void {
    const runtime = this.host.actingPlayer(client);
    const payload = message as { cardSlot?: unknown; targetSlot?: unknown } | null;
    const cardSlot = payload?.cardSlot;
    const targetSlot = payload?.targetSlot;
    if (!runtime || !isInt(cardSlot) || !isInt(targetSlot)) {
      return;
    }
    this.run(runtime, async () => {
      const { record } = runtime;
      const bag = cloneItems(record.inventory);
      const target = bag.find((i) => i.slot === targetSlot);
      const cardItem = bag.find((i) => i.slot === cardSlot);
      const card = cardItem ? getItemDef(cardItem.itemId) : undefined;
      const equip = target ? getItemDef(target.itemId)?.equip : undefined;
      if (!target || !cardItem || !card?.card || !equip) {
        this.host.sendSystemTo(client, '請選擇背包中的卡片與裝備');
        return;
      }
      if (card.card.type !== equip.type) {
        this.host.sendSystemTo(client, `${card.name}不能鑲嵌在這種裝備上`);
        return;
      }
      if (target.cards.length >= target.cardSlots) {
        this.host.sendSystemTo(client, '這件裝備沒有空的卡槽');
        return;
      }
      if (!takeFromSlot(bag, cardSlot, 1)) {
        return;
      }
      target.cards.push(card.id);
      await this.commit(
        [{ runtime, bag }],
        [
          {
            action: 'card_insert',
            characterId: record.id,
            itemUid: target.uid,
            itemId: card.id,
            quantity: -1,
            detail: { target: target.itemId, cards: target.cards },
          },
        ],
      );
      this.host.sendSystemTo(client, `已將 ${card.name} 鑲嵌到 ${getItemDef(target.itemId)?.name ?? target.itemId}`);
    });
  }

  // ------------------------------------------------------------ 倉庫

  handleStorageOpen(client: Client, message: unknown): void {
    const runtime = this.host.actingPlayer(client);
    if (!runtime) {
      return;
    }
    this.run(runtime, async () => {
      if (!this.npcNearby(runtime, (message as { npcId?: unknown } | null)?.npcId, 'storage')) {
        return;
      }
      await this.ensureStorage(runtime);
      this.sendStorage(runtime);
    });
  }

  private async ensureStorage(runtime: PlayerRuntime): Promise<InventoryItem[]> {
    runtime.storage ??= await loadStorage(runtime.record.accountId);
    return runtime.storage;
  }

  handleStorageDeposit(client: Client, message: unknown): void {
    this.moveStorage(client, message, 'in');
  }

  handleStorageWithdraw(client: Client, message: unknown): void {
    this.moveStorage(client, message, 'out');
  }

  private moveStorage(client: Client, message: unknown, direction: 'in' | 'out'): void {
    const runtime = this.host.actingPlayer(client);
    const payload = message as { npcId?: unknown; slot?: unknown; quantity?: unknown } | null;
    const slot = payload?.slot;
    const quantity = payload?.quantity;
    if (!runtime || !isInt(slot) || !isInt(quantity) || quantity < 1) {
      return;
    }
    this.run(runtime, async () => {
      if (!this.npcNearby(runtime, payload?.npcId, 'storage')) {
        return;
      }
      const bag = cloneItems(runtime.record.inventory);
      const storage = cloneItems(await this.ensureStorage(runtime));
      const moved =
        direction === 'in'
          ? moveBetween(bag, storage, STORAGE_SIZE, slot, quantity, randomUUID)
          : moveBetween(storage, bag, INVENTORY_SIZE, slot, quantity, randomUUID);
      if (!moved) {
        this.host.sendSystemTo(client, direction === 'in' ? '倉庫已滿或道具不存在' : '背包已滿或道具不存在');
        return;
      }
      await this.commit(
        [{ runtime, bag, storage }],
        [
          {
            action: direction === 'in' ? 'storage_in' : 'storage_out',
            characterId: runtime.record.id,
            itemUid: moved.uid,
            itemId: moved.itemId,
            // 以背包的角度記錄：存入為負、取出為正
            quantity: direction === 'in' ? -quantity : quantity,
          },
        ],
      );
    });
  }
}
