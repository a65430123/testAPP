// 玩家交易：邀請 → 雙方各自放上道具與星幣 → 雙方確認 → 伺服器在一個資料庫交易內完成交換。
// 任何一方修改內容都會取消雙方的確認；執行前會以當下的背包重新驗證一次。

import { randomUUID } from 'node:crypto';
import type { Client } from 'colyseus';
import {
  addToContainer,
  cloneItems,
  INVENTORY_SIZE,
  MSG,
  takeFromSlot,
  TRADE_COIN_MIN_LEVEL,
  TRADE_MAX_ITEMS,
  TRADE_RANGE,
  TRADE_TAX,
  type InventoryItem,
  type ItemStack,
  type TradeEndMessage,
  type TradeInviteMessage,
  type TradeSide,
  type TradeStateMessage,
} from '@starmemory/shared';
import type { ItemLogEntry } from '../db/items';
import type { PlayerRuntime } from '../rooms/runtime';
import type { ItemController } from './ItemController';
import { log } from '../log';

/** 交易邀請的有效時間（毫秒） */
const INVITE_TTL_MS = 30_000;

export interface TradeHost {
  actingPlayer(client: Client): PlayerRuntime | null;
  getRuntime(sessionId: string): PlayerRuntime | undefined;
  isActive(runtime: PlayerRuntime): boolean;
  sendSystemTo(client: Client, text: string): void;
}

interface Offer {
  runtime: PlayerRuntime;
  /** 以唯一編號指定的道具與數量 */
  items: Array<{ uid: string; quantity: number }>;
  coins: number;
  confirmed: boolean;
}

interface Session {
  a: Offer;
  b: Offer;
  /** 雙方都確認、正在寫入資料庫 */
  executing: boolean;
}

function distance(a: PlayerRuntime, b: PlayerRuntime): number {
  return Math.hypot(a.move.x - b.move.x, a.move.y - b.move.y);
}

export class TradeController {
  /** 進行中的交易，以雙方的連線代號各登記一次 */
  private readonly sessions = new Map<string, Session>();
  /** 等待回應的邀請：被邀請者的連線代號 → 邀請者 */
  private readonly invites = new Map<string, { fromId: string; expireAt: number }>();

  constructor(
    private readonly host: TradeHost,
    private readonly items: ItemController,
  ) {}

  // ------------------------------------------------------------ 邀請

  handleRequest(client: Client, message: unknown): void {
    const from = this.host.actingPlayer(client);
    const targetId = (message as { targetId?: unknown } | null)?.targetId;
    const target = typeof targetId === 'string' ? this.host.getRuntime(targetId) : undefined;
    if (!from || !target || typeof targetId !== 'string' || target === from) {
      return;
    }
    if (target.dead || target.transferring) {
      return;
    }
    if (this.sessions.has(client.sessionId) || this.sessions.has(targetId)) {
      this.host.sendSystemTo(client, '你或對方正在交易中');
      return;
    }
    if (distance(from, target) > TRADE_RANGE) {
      this.host.sendSystemTo(client, '距離太遠，無法交易');
      return;
    }
    this.invites.set(targetId, { fromId: client.sessionId, expireAt: Date.now() + INVITE_TTL_MS });
    const invite: TradeInviteMessage = { fromId: client.sessionId, fromName: from.record.name };
    target.client.send(MSG.tradeRequest, invite);
    this.host.sendSystemTo(client, `已向 ${target.record.name} 提出交易`);
  }

  handleRespond(client: Client, message: unknown): void {
    const target = this.host.actingPlayer(client);
    const invite = this.invites.get(client.sessionId);
    this.invites.delete(client.sessionId);
    if (!target || !invite || Date.now() > invite.expireAt) {
      return;
    }
    const from = this.host.getRuntime(invite.fromId);
    if (!from || from.dead || from.transferring) {
      return;
    }
    if ((message as { accept?: unknown } | null)?.accept !== true) {
      this.host.sendSystemTo(from.client, `${target.record.name} 拒絕了交易`);
      return;
    }
    if (this.sessions.has(client.sessionId) || this.sessions.has(invite.fromId)) {
      this.host.sendSystemTo(client, '你或對方正在交易中');
      return;
    }
    if (distance(from, target) > TRADE_RANGE) {
      this.host.sendSystemTo(client, '距離太遠，無法交易');
      return;
    }
    const session: Session = {
      a: { runtime: from, items: [], coins: 0, confirmed: false },
      b: { runtime: target, items: [], coins: 0, confirmed: false },
      executing: false,
    };
    this.sessions.set(invite.fromId, session);
    this.sessions.set(client.sessionId, session);
    this.sendState(session);
  }

  // ------------------------------------------------------------ 放上道具、確認、取消

  private sides(client: Client): { session: Session; mine: Offer; theirs: Offer } | null {
    const session = this.sessions.get(client.sessionId);
    if (!session || session.executing) {
      return null;
    }
    const mine = session.a.runtime.client.sessionId === client.sessionId ? session.a : session.b;
    return { session, mine, theirs: mine === session.a ? session.b : session.a };
  }

  handleOffer(client: Client, message: unknown): void {
    const found = this.sides(client);
    if (!found) {
      return;
    }
    const { session, mine } = found;
    const payload = message as { items?: unknown; coins?: unknown } | null;
    const rawItems = Array.isArray(payload?.items) ? payload.items : null;
    const coins = payload?.coins;
    const { record } = mine.runtime;
    if (!rawItems || rawItems.length > TRADE_MAX_ITEMS || typeof coins !== 'number' || !Number.isInteger(coins) || coins < 0) {
      return;
    }
    if (coins > record.coins) {
      this.host.sendSystemTo(client, '星幣不足');
      return;
    }
    if (coins > 0 && record.level < TRADE_COIN_MIN_LEVEL) {
      this.host.sendSystemTo(client, `等級 ${TRADE_COIN_MIN_LEVEL} 以上才能交易星幣`);
      return;
    }
    // 每個道具都必須在自己的背包裡、數量足夠，且同一個道具不能放兩次
    const items: Offer['items'] = [];
    const seen = new Set<string>();
    for (const raw of rawItems) {
      const uid = (raw as { uid?: unknown } | null)?.uid;
      const quantity = (raw as { quantity?: unknown } | null)?.quantity;
      const owned = typeof uid === 'string' ? record.inventory.find((i) => i.uid === uid) : undefined;
      if (
        typeof uid !== 'string' ||
        typeof quantity !== 'number' ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        !owned ||
        owned.quantity < quantity ||
        seen.has(uid)
      ) {
        return;
      }
      seen.add(uid);
      items.push({ uid, quantity });
    }
    mine.items = items;
    mine.coins = coins;
    // 內容一變動，雙方都要重新確認，避免在對方確認後偷換內容
    session.a.confirmed = false;
    session.b.confirmed = false;
    this.sendState(session);
  }

  handleConfirm(client: Client): void {
    const found = this.sides(client);
    if (!found) {
      return;
    }
    found.mine.confirmed = true;
    this.sendState(found.session);
    if (found.session.a.confirmed && found.session.b.confirmed) {
      this.execute(found.session);
    }
  }

  handleCancel(client: Client): void {
    const found = this.sides(client);
    if (found) {
      this.end(found.session, false, `${found.mine.runtime.record.name} 取消了交易`);
    }
  }

  /** 玩家離開、倒地或切換地圖時呼叫 */
  onPlayerGone(sessionId: string): void {
    this.invites.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (session && !session.executing) {
      this.end(session, false, '對方已離開，交易取消');
    }
  }

  private end(session: Session, completed: boolean, reason: string): void {
    for (const side of [session.a, session.b]) {
      const id = side.runtime.client.sessionId;
      if (this.sessions.get(id) === session) {
        this.sessions.delete(id);
      }
      if (this.host.isActive(side.runtime)) {
        const message: TradeEndMessage = { completed, reason };
        side.runtime.client.send(MSG.tradeEnd, message);
      }
    }
  }

  // ------------------------------------------------------------ 執行交換

  /** 把一方放上的道具從背包副本中取出；任何一項已不在或數量不足就回傳 null */
  private takeOffered(bag: InventoryItem[], offer: Offer): Array<ItemStack & { whole: boolean }> | null {
    const taken: Array<ItemStack & { whole: boolean }> = [];
    for (const entry of offer.items) {
      const owned = bag.find((i) => i.uid === entry.uid);
      if (!owned) {
        return null;
      }
      const whole = owned.quantity === entry.quantity;
      const stack = takeFromSlot(bag, owned.slot, entry.quantity);
      if (!stack) {
        return null;
      }
      taken.push({ ...stack, whole });
    }
    return taken;
  }

  private execute(session: Session): void {
    session.executing = true;
    const { a, b } = session;

    const op = async (): Promise<void> => {
      // 排隊期間狀況可能已改變：以當下的資料重新驗證
      if (!this.host.isActive(a.runtime) || !this.host.isActive(b.runtime) || a.runtime.dead || b.runtime.dead) {
        this.end(session, false, '交易取消');
        return;
      }
      if (distance(a.runtime, b.runtime) > TRADE_RANGE) {
        this.end(session, false, '距離太遠，交易取消');
        return;
      }
      if (a.coins > a.runtime.record.coins || b.coins > b.runtime.record.coins) {
        this.end(session, false, '星幣不足，交易取消');
        return;
      }
      const bagA = cloneItems(a.runtime.record.inventory);
      const bagB = cloneItems(b.runtime.record.inventory);
      const fromA = this.takeOffered(bagA, a);
      const fromB = this.takeOffered(bagB, b);
      if (!fromA || !fromB) {
        this.end(session, false, '道具已不在背包中，交易取消');
        return;
      }
      // 整疊交出的道具沿用原本的編號，讓紀錄可以一路追蹤同一個道具
      const receive = (bag: InventoryItem[], stacks: Array<ItemStack & { whole: boolean }>): boolean =>
        stacks.every((s) => addToContainer(bag, INVENTORY_SIZE, s, randomUUID, s.whole ? s.uid : undefined));
      if (!receive(bagA, fromB) || !receive(bagB, fromA)) {
        this.end(session, false, '背包空間不足，交易取消');
        return;
      }

      // 星幣交易收 5% 稅（由收款方實拿的金額中扣除）
      const taxA = Math.floor(a.coins * TRADE_TAX);
      const taxB = Math.floor(b.coins * TRADE_TAX);
      const deltaA = -a.coins + (b.coins - taxB);
      const deltaB = -b.coins + (a.coins - taxA);

      const idA = a.runtime.record.id;
      const idB = b.runtime.record.id;
      const logs: ItemLogEntry[] = [];
      const logItems = (stacks: ItemStack[], giver: number, receiver: number): void => {
        for (const s of stacks) {
          logs.push({ action: 'trade_out', characterId: giver, otherCharacterId: receiver, itemUid: s.uid, itemId: s.itemId, quantity: -s.quantity });
          logs.push({ action: 'trade_in', characterId: receiver, otherCharacterId: giver, itemUid: s.uid, itemId: s.itemId, quantity: s.quantity });
        }
      };
      logItems(fromA, idA, idB);
      logItems(fromB, idB, idA);
      if (a.coins > 0) {
        logs.push({ action: 'trade_out', characterId: idA, otherCharacterId: idB, coins: -a.coins });
        logs.push({ action: 'trade_in', characterId: idB, otherCharacterId: idA, coins: a.coins - taxA, detail: { tax: taxA } });
      }
      if (b.coins > 0) {
        logs.push({ action: 'trade_out', characterId: idB, otherCharacterId: idA, coins: -b.coins });
        logs.push({ action: 'trade_in', characterId: idA, otherCharacterId: idB, coins: b.coins - taxB, detail: { tax: taxB } });
      }

      try {
        // 雙方的背包、星幣與紀錄在同一個資料庫交易內寫入：不是全部成功，就是完全沒發生
        await this.items.commit(
          [
            { runtime: a.runtime, bag: bagA, coinsDelta: deltaA },
            { runtime: b.runtime, bag: bagB, coinsDelta: deltaB },
          ],
          logs,
        );
      } catch (err) {
        log.error('[trade] 交易寫入失敗：', err);
        this.end(session, false, '交易失敗，雙方的道具都沒有變動');
        return;
      }
      this.end(session, true, '交易完成');
    };

    // 同時佔用雙方的道具佇列，交易期間兩人都不能進行其他道具操作
    const joint = Promise.all([a.runtime.itemQueue, b.runtime.itemQueue])
      .then(op)
      .catch((err: unknown) => {
        log.error('[trade] 交易發生未預期的錯誤：', err);
        this.end(session, false, '交易失敗');
      });
    a.runtime.itemQueue = joint;
    b.runtime.itemQueue = joint;
  }

  // ------------------------------------------------------------ 同步交易視窗

  private describe(offer: Offer): TradeSide {
    const items: ItemStack[] = [];
    for (const entry of offer.items) {
      const owned = offer.runtime.record.inventory.find((i) => i.uid === entry.uid);
      if (owned) {
        items.push({
          uid: owned.uid,
          itemId: owned.itemId,
          quantity: entry.quantity,
          refine: owned.refine,
          cardSlots: owned.cardSlots,
          cards: [...owned.cards],
        });
      }
    }
    return { name: offer.runtime.record.name, items, coins: offer.coins, confirmed: offer.confirmed };
  }

  private sendState(session: Session): void {
    const a = this.describe(session.a);
    const b = this.describe(session.b);
    const toA: TradeStateMessage = { mine: a, theirs: b };
    const toB: TradeStateMessage = { mine: b, theirs: a };
    session.a.runtime.client.send(MSG.tradeState, toA);
    session.b.runtime.client.send(MSG.tradeState, toB);
  }
}
