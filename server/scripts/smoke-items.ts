// 道具煙霧測試：裝備、商店、精煉、卡片鑲嵌、倉庫、玩家交易，以及各種防複製情境。
// 用法：伺服器需以 ENABLE_GM_COMMANDS=true 啟動，再執行 npm run smoke（接在前兩個測試之後執行）。
// 環境變數：
//   SERVER_URL    伺服器位址（預設 http://localhost:2567）
//   DATABASE_URL  設定後會直接查資料庫，驗證異動紀錄與「紀錄加總 = 實際持有」

import { Client, type Room } from '@colyseus/sdk';
import pg from 'pg';
import {
  DEFAULT_SERVER_PORT,
  MSG,
  ROOM_MAP,
  type AuthResponse,
  type CardInsertRequest,
  type ChatSendMessage,
  type CreateCharacterResponse,
  type EquipRequest,
  type InventoryItem,
  type InventoryMessage,
  type JoinMapOptions,
  type MoveRequest,
  type RefineRequest,
  type SelfMessage,
  type ShopBuyRequest,
  type ShopSellRequest,
  type StorageMessage,
  type StorageMoveRequest,
  type StorageOpenRequest,
  type SystemMessage,
  type TradeEndMessage,
  type TradeInviteMessage,
  type TradeOfferRequest,
  type TradeRequest,
  type TradeRespondRequest,
  type TradeStateMessage,
  type UnequipRequest,
} from '@starmemory/shared';

const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${DEFAULT_SERVER_PORT}`;
const DATABASE_URL = process.env.DATABASE_URL;
const GROCER = 'c01_grocer';
const SMITH = 'c01_smith';
const STORAGE = 'c01_storage';

interface StateView {
  players: { get(key: string): { x: number; y: number; maxHp: number } | undefined };
}

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '通過' : '失敗'}  ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) {
    failed++;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return true;
    }
    await sleep(20);
  }
  return condition();
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} 回應 ${res.status}：${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** 一位測試玩家：包住房間連線，並記錄伺服器傳來的各種訊息 */
class Player {
  room!: Room<any, StateView>;
  self!: SelfMessage;
  inv!: InventoryMessage;
  storage: InventoryItem[] | undefined;
  invite: TradeInviteMessage | undefined;
  trade: TradeStateMessage | undefined;
  tradeEnd: TradeEndMessage | undefined;
  readonly system: string[] = [];
  private lastChatAt = 0;
  private lastActionAt = 0;

  constructor(
    readonly token: string,
    readonly characterId: number,
    readonly name: string,
  ) {}

  async join(mapId = 'C01'): Promise<void> {
    const options: JoinMapOptions = { token: this.token, characterId: this.characterId, mapId };
    const room = await new Client(SERVER_URL).joinOrCreate<StateView>(ROOM_MAP, options);
    this.room = room;
    let gotSelf = false;
    let gotInv = false;
    room.onMessage(MSG.self, (m: SelfMessage) => {
      this.self = m;
      gotSelf = true;
    });
    room.onMessage(MSG.inventory, (m: InventoryMessage) => {
      this.inv = m;
      gotInv = true;
    });
    room.onMessage(MSG.storage, (m: StorageMessage) => (this.storage = m.items));
    room.onMessage(MSG.tradeRequest, (m: TradeInviteMessage) => (this.invite = m));
    room.onMessage(MSG.tradeState, (m: TradeStateMessage) => (this.trade = m));
    room.onMessage(MSG.tradeEnd, (m: TradeEndMessage) => (this.tradeEnd = m));
    room.onMessage(MSG.system, (m: SystemMessage) => this.system.push(m.text));
    room.onMessage('*', () => undefined);
    await waitFor(() => room.state?.players?.get(room.sessionId) !== undefined, 3000);
    room.send(MSG.inventory);
    await waitFor(() => gotSelf && gotInv, 3000);
  }

  get id(): string {
    return this.room.sessionId;
  }

  /** 送出一個動作訊息（遵守伺服器的動作間隔），並等伺服器處理完 */
  async act(type: string, message?: unknown, settleMs = 250): Promise<void> {
    const wait = this.lastActionAt + 130 - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
    this.lastActionAt = Date.now();
    this.room.send(type, message);
    await sleep(settleMs);
  }

  async gm(command: string): Promise<void> {
    const wait = this.lastChatAt + 900 - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
    this.lastChatAt = Date.now();
    this.room.send(MSG.chat, { channel: 'map', text: `/gm ${command}` } satisfies ChatSendMessage);
    await sleep(300);
  }

  async walkTo(x: number, y: number): Promise<void> {
    await sleep(120);
    this.room.send(MSG.move, { x, y } satisfies MoveRequest);
    await waitFor(() => {
      const me = this.room.state.players.get(this.id)!;
      return Math.abs(me.x - (x + 0.5)) < 0.01 && Math.abs(me.y - (y + 0.5)) < 0.01;
    }, 10000);
  }

  /** 背包中某種道具的總數 */
  count(itemId: string): number {
    return this.inv.items.filter((i) => i.itemId === itemId).reduce((n, i) => n + i.quantity, 0);
  }

  find(itemId: string, predicate: (item: InventoryItem) => boolean = () => true): InventoryItem | undefined {
    return this.inv.items.find((i) => i.itemId === itemId && predicate(i));
  }

  said(text: string): boolean {
    return this.system.some((t) => t.includes(text));
  }
}

async function createPlayer(tag: string, classId: string, suffix: number): Promise<Player> {
  const { token } = await post<AuthResponse>('/api/register', { username: `items_${tag}_${suffix}`, password: 'correct-horse-battery' });
  const name = `${tag === 'a' ? '物甲' : '物乙'}${suffix}`;
  const { character } = await post<CreateCharacterResponse>('/api/characters', { name, classId }, token);
  return new Player(token, character.id, name);
}

async function main(): Promise<void> {
  const suffix = Math.floor(Math.random() * 900000 + 100000);
  const db = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL }) : null;
  const a = await createPlayer('a', 'bladeguard', suffix);
  const b = await createPlayer('b', 'starcaller', suffix);
  await a.join();
  await b.join();

  await a.gm('coins 10000');
  if (!a.said('星幣 +10000')) {
    console.log('略過  道具測試（伺服器未開啟 ENABLE_GM_COMMANDS）');
    process.exit(0);
  }

  // ---------------------------------------------------------- 1. 裝備欄
  const sword = a.inv.equipment.find((i) => i.itemId === 'novice_sword');
  check('新角色的起始武器已穿在身上', sword?.slot === 0 && a.inv.items.every((i) => i.itemId !== 'novice_sword'));
  const armedAtk = a.self.atk;
  await a.act(MSG.unequip, { equipSlot: 0 } satisfies UnequipRequest);
  const inBag = a.find('novice_sword');
  check('卸下武器後回到背包（同一個道具編號），攻擊力下降', inBag?.uid === sword?.uid && a.inv.equipment.length === 0 && a.self.atk === armedAtk - 9, `物攻 ${armedAtk} → ${a.self.atk}`);
  await a.act(MSG.equip, { slot: inBag!.slot } satisfies EquipRequest);
  check('重新裝備後攻擊力恢復', a.inv.equipment[0]?.uid === sword?.uid && a.self.atk === armedAtk);
  await a.gm('item novice_staff');
  await a.act(MSG.equip, { slot: a.find('novice_staff')!.slot } satisfies EquipRequest);
  check('不能裝備其他職業的武器', a.find('novice_staff') !== undefined && a.inv.equipment[0]?.itemId === 'novice_sword');

  // ---------------------------------------------------------- 2. NPC 商店
  let coins = a.inv.coins;
  await a.act(MSG.shopBuy, { npcId: GROCER, itemId: 'potion_hp_s', quantity: 1 } satisfies ShopBuyRequest);
  check('離 NPC 太遠時不能購買', a.inv.coins === coins && a.count('potion_hp_s') === 10 && a.said('太遠'));
  await a.walkTo(15, 13);
  await b.walkTo(14, 13);
  await a.act(MSG.shopBuy, { npcId: GROCER, itemId: 'potion_hp_s', quantity: 5 } satisfies ShopBuyRequest);
  check('向商店購買：扣星幣、道具進背包', a.inv.coins === coins - 200 && a.count('potion_hp_s') === 15);
  coins = a.inv.coins;
  await a.act(MSG.shopBuy, { npcId: GROCER, itemId: 'wooden_dagger', quantity: 1 } satisfies ShopBuyRequest);
  await a.act(MSG.shopBuy, { npcId: GROCER, itemId: 'potion_hp_s', quantity: -5 } satisfies ShopBuyRequest);
  await a.act(MSG.shopBuy, { npcId: GROCER, itemId: 'potion_hp_s', quantity: 1.5 } satisfies ShopBuyRequest);
  await a.act(MSG.shopBuy, { npcId: SMITH, itemId: 'potion_hp_s', quantity: 1 } satisfies ShopBuyRequest);
  check('商店沒賣的道具、不合法的數量、不是商店的 NPC 都買不到', a.inv.coins === coins && a.count('potion_hp_s') === 15 && a.count('wooden_dagger') === 0);
  await a.act(MSG.shopSell, { npcId: GROCER, slot: a.find('potion_hp_s')!.slot, quantity: 2 } satisfies ShopSellRequest);
  check('賣給商店：道具減少、獲得星幣', a.inv.coins === coins + 24 && a.count('potion_hp_s') === 13);
  coins = a.inv.coins;
  await a.act(MSG.shopSell, { npcId: GROCER, slot: a.find('potion_hp_s')!.slot, quantity: 999 } satisfies ShopSellRequest);
  check('不能賣出超過持有的數量', a.inv.coins === coins && a.count('potion_hp_s') === 13);
  await b.act(MSG.shopBuy, { npcId: GROCER, itemId: 'novice_tunic', quantity: 1 } satisfies ShopBuyRequest);
  check('星幣不足時買不到', b.inv.coins === 100 && b.count('novice_tunic') === 0 && b.said('星幣不足'));

  // 連點：錢只夠買一件時連送兩次購買，只會成交一次
  await a.gm(`coins ${400 - a.inv.coins}`);
  a.room.send(MSG.shopBuy, { npcId: GROCER, itemId: 'novice_tunic', quantity: 1 } satisfies ShopBuyRequest);
  a.room.send(MSG.shopBuy, { npcId: GROCER, itemId: 'novice_tunic', quantity: 1 } satisfies ShopBuyRequest);
  await sleep(600);
  check('連點購買不會超買或把星幣扣成負數', a.count('novice_tunic') === 1 && a.inv.coins === 100, `星幣 ${a.inv.coins}`);
  await a.gm('coins 20000');

  // ---------------------------------------------------------- 3. 精煉
  await a.gm('item sand_starvelvet 10');
  coins = a.inv.coins;
  const tunic = a.find('novice_tunic')!;
  for (let i = 0; i < 4; i++) {
    await a.act(MSG.refine, { npcId: SMITH, slot: tunic.slot } satisfies RefineRequest);
  }
  const refined = a.inv.items.find((i) => i.uid === tunic.uid);
  check('+1～+4 必定成功：等級上升，每次消耗 1 個材料與費用', refined?.refine === 4 && a.count('sand_starvelvet') === 6 && a.inv.coins === coins - 200, `+${refined?.refine}，星幣 ${coins} → ${a.inv.coins}`);
  coins = a.inv.coins;
  await a.act(MSG.refine, { npcId: SMITH, slot: tunic.slot } satisfies RefineRequest);
  const risky = a.inv.items.find((i) => i.uid === tunic.uid)!;
  check('+5 有機率失敗：不論成敗都消耗材料與費用', (risky.refine === 4 || risky.refine === 5) && a.count('sand_starvelvet') === 5 && a.inv.coins === coins - 100, `結果 +${risky.refine}`);
  coins = a.inv.coins;
  await a.act(MSG.refine, { npcId: SMITH, slot: a.find('novice_staff')!.slot } satisfies RefineRequest);
  await a.act(MSG.refine, { npcId: SMITH, slot: a.find('potion_hp_s')!.slot } satisfies RefineRequest);
  check('缺少材料或不是裝備時不能精煉、也不扣錢', a.inv.coins === coins && a.find('novice_staff')?.refine === 0 && a.said('缺少材料'));
  const hpBefore = a.self.maxHp;
  await a.act(MSG.equip, { slot: risky.slot } satisfies EquipRequest);
  check('穿上精煉過的防具：防禦與 MaxHP 提升', a.self.def >= 4 && a.self.maxHp > hpBefore + 20, `防禦 ${a.self.def}，MaxHP ${hpBefore} → ${a.self.maxHp}`);

  // ---------------------------------------------------------- 4. 卡片鑲嵌
  await a.gm('item novice_tunic 1 1');
  await a.gm('item card_bobolu 2');
  await a.gm('item card_fluffytail 1');
  const slotted = a.find('novice_tunic', (i) => i.cardSlots === 1)!;
  await a.act(MSG.cardInsert, { cardSlot: a.find('card_fluffytail')!.slot, targetSlot: slotted.slot } satisfies CardInsertRequest);
  check('卡片種類與裝備不符時不能鑲嵌', a.count('card_fluffytail') === 1 && a.inv.items.find((i) => i.uid === slotted.uid)?.cards.length === 0);
  await a.act(MSG.cardInsert, { cardSlot: a.find('card_bobolu')!.slot, targetSlot: slotted.slot } satisfies CardInsertRequest);
  const carded = a.inv.items.find((i) => i.uid === slotted.uid)!;
  check('鑲嵌成功：卡片消耗、裝備記錄卡片', carded.cards.join() === 'card_bobolu' && a.count('card_bobolu') === 1);
  await a.act(MSG.cardInsert, { cardSlot: a.find('card_bobolu')!.slot, targetSlot: slotted.slot } satisfies CardInsertRequest);
  check('沒有空卡槽時不能再鑲嵌', a.count('card_bobolu') === 1 && a.inv.items.find((i) => i.uid === slotted.uid)?.cards.length === 1);
  const hpRefined = a.self.maxHp;
  await a.act(MSG.equip, { slot: carded.slot } satisfies EquipRequest);
  const swappedBack = a.inv.items.find((i) => i.uid === tunic.uid);
  check('換上鑲卡的防具：卡片效果生效，原本的防具換回背包', a.self.maxHp >= 136 + 20 + 60 && a.self.maxHp !== hpRefined && swappedBack !== undefined, `MaxHP ${a.self.maxHp}`);

  // ---------------------------------------------------------- 5. 倉庫
  await a.act(MSG.storageOpen, { npcId: STORAGE } satisfies StorageOpenRequest);
  check('開啟倉庫（一開始是空的）', a.storage?.length === 0);
  await a.act(MSG.storageDeposit, { npcId: STORAGE, slot: a.find('potion_hp_s')!.slot, quantity: 3 } satisfies StorageMoveRequest);
  await a.act(MSG.storageDeposit, { npcId: STORAGE, slot: swappedBack!.slot, quantity: 1 } satisfies StorageMoveRequest);
  const stored = a.storage?.find((i) => i.uid === tunic.uid);
  check('存入倉庫：背包減少、倉庫增加，裝備的編號與精煉等級不變', a.count('potion_hp_s') === 10 && a.storage?.find((i) => i.itemId === 'potion_hp_s')?.quantity === 3 && stored?.refine === risky.refine && a.inv.items.every((i) => i.uid !== tunic.uid));
  await a.act(MSG.storageDeposit, { npcId: STORAGE, slot: a.find('potion_hp_s')!.slot, quantity: 999 } satisfies StorageMoveRequest);
  check('不能存入超過持有的數量', a.count('potion_hp_s') === 10);
  await a.room.leave();
  await a.join();
  await a.act(MSG.storageOpen, { npcId: STORAGE } satisfies StorageOpenRequest);
  check('重新登入後倉庫內容仍在', a.storage?.some((i) => i.uid === tunic.uid) === true && a.storage.length === 2);
  await a.act(MSG.storageWithdraw, { npcId: STORAGE, slot: a.storage!.find((i) => i.uid === tunic.uid)!.slot, quantity: 1 } satisfies StorageMoveRequest);
  check('從倉庫取出：回到背包，編號不變', a.inv.items.some((i) => i.uid === tunic.uid) && a.storage?.length === 1);

  // ---------------------------------------------------------- 6. 玩家交易
  await b.gm('item mat_sticky_dew 20');
  const openTrade = async (): Promise<void> => {
    a.trade = b.trade = undefined;
    a.tradeEnd = b.tradeEnd = undefined;
    b.invite = undefined;
    await a.act(MSG.tradeRequest, { targetId: b.id } satisfies TradeRequest);
    await waitFor(() => b.invite !== undefined, 2000);
    await b.act(MSG.tradeRespond, { accept: true } satisfies TradeRespondRequest);
    await waitFor(() => a.trade !== undefined && b.trade !== undefined, 2000);
  };
  await openTrade();
  check('提出交易、對方接受後雙方進入交易', b.invite?.fromName === a.name && a.trade?.theirs.name === b.name);

  const tradeTunic = a.inv.items.find((i) => i.uid === tunic.uid)!;
  const potionStack = a.find('potion_hp_s')!;
  const offerA: TradeOfferRequest = { items: [{ uid: tradeTunic.uid, quantity: 1 }, { uid: potionStack.uid, quantity: 4 }], coins: 1000 };
  await a.act(MSG.tradeOffer, offerA);
  check('等級不足時不能交易星幣', a.said('才能交易星幣') && a.trade?.mine.items.length === 0);
  await a.gm('level 15');
  await a.act(MSG.tradeOffer, { items: [{ uid: potionStack.uid, quantity: 999 }], coins: 0 } satisfies TradeOfferRequest);
  await a.act(MSG.tradeOffer, { items: [{ uid: b.find('mat_sticky_dew')!.uid, quantity: 1 }], coins: 0 } satisfies TradeOfferRequest);
  await a.act(MSG.tradeOffer, { items: [], coins: a.inv.coins + 1 } satisfies TradeOfferRequest);
  check('不能放上超過持有的數量、別人的道具或超過持有的星幣', a.trade?.mine.items.length === 0 && a.trade.mine.coins === 0);
  await a.act(MSG.tradeOffer, offerA);
  check('對方看得到放上交易的內容（含精煉等級）', b.trade?.theirs.items.find((i) => i.uid === tunic.uid)?.refine === risky.refine && b.trade.theirs.coins === 1000);
  await a.act(MSG.tradeConfirm);
  check('一方確認後對方看得到', b.trade?.theirs.confirmed === true && b.tradeEnd === undefined);
  const dew = b.find('mat_sticky_dew')!;
  await b.act(MSG.tradeOffer, { items: [{ uid: dew.uid, quantity: 20 }], coins: 0 } satisfies TradeOfferRequest);
  check('任何一方修改內容會取消雙方的確認', a.trade?.mine.confirmed === false && a.trade.theirs.items.length === 1);

  const coinsA = a.inv.coins;
  const coinsB = b.inv.coins;
  await a.act(MSG.tradeConfirm);
  await b.act(MSG.tradeConfirm);
  await waitFor(() => a.tradeEnd !== undefined && b.tradeEnd !== undefined, 3000);
  await sleep(200);
  const got = b.inv.items.find((i) => i.uid === tunic.uid);
  check('雙方確認後交易完成', a.tradeEnd?.completed === true && b.tradeEnd?.completed === true);
  check('道具換手：裝備連同編號、精煉等級一起轉移', got?.refine === risky.refine && a.inv.items.every((i) => i.uid !== tunic.uid) && b.count('potion_hp_s') === 6 + 4 && a.count('potion_hp_s') === 6 && a.count('mat_sticky_dew') === 20 && b.count('mat_sticky_dew') === 0);
  check('星幣轉移並扣 5% 交易稅', a.inv.coins === coinsA - 1000 && b.inv.coins === coinsB + 950, `甲 ${coinsA} → ${a.inv.coins}，乙 ${coinsB} → ${b.inv.coins}`);

  // 防複製：放上交易後把道具賣給 NPC，再雙方確認
  await openTrade();
  const bait = a.find('potion_hp_s')!;
  await a.act(MSG.tradeOffer, { items: [{ uid: bait.uid, quantity: 6 }], coins: 0 } satisfies TradeOfferRequest);
  await a.act(MSG.shopSell, { npcId: GROCER, slot: bait.slot, quantity: 6 } satisfies ShopSellRequest);
  const bPotions = b.count('potion_hp_s');
  await a.act(MSG.tradeConfirm);
  await b.act(MSG.tradeConfirm);
  await waitFor(() => a.tradeEnd !== undefined, 3000);
  await sleep(200);
  check('放上交易後又賣掉的道具無法交易（不會憑空多出來）', a.tradeEnd?.completed === false && b.count('potion_hp_s') === bPotions && a.count('potion_hp_s') === 0);

  // 取消
  await openTrade();
  await b.act(MSG.tradeCancel);
  await waitFor(() => a.tradeEnd !== undefined, 2000);
  check('任何一方都可以取消交易', a.tradeEnd?.completed === false && b.tradeEnd?.completed === false);

  // ---------------------------------------------------------- 7. 異動紀錄與資料庫層的防複製
  await a.room.leave();
  await b.room.leave();
  await sleep(500);
  if (db) {
    const idA = a.characterId;
    const idB = b.characterId;
    const actions = (await db.query<{ action: string }>('SELECT DISTINCT action FROM item_log WHERE character_id = $1', [idA])).rows.map((r) => r.action);
    const expected = ['create', 'gm', 'shop_buy', 'shop_sell', 'refine', 'card_insert', 'storage_in', 'storage_out', 'trade_out', 'trade_in'];
    check('每一種道具操作都留下異動紀錄', expected.every((e) => actions.includes(e)), actions.sort().join('、'));

    const trail = (await db.query<{ action: string; character_id: number; tx: string }>('SELECT action, character_id, tx FROM item_log WHERE item_uid = $1 ORDER BY id', [tunic.uid])).rows;
    const out = trail.find((r) => r.action === 'trade_out');
    const into = trail.find((r) => r.action === 'trade_in');
    check('可用道具編號追蹤同一件裝備的完整歷程', trail.map((r) => r.action).join('→') === 'shop_buy→refine→refine→refine→refine→refine→storage_in→storage_out→trade_out→trade_in', trail.map((r) => r.action).join('→'));
    check('交易雙方的紀錄屬於同一筆交易', out?.character_id === idA && into?.character_id === idB && out.tx === into.tx);

    const owners = (await db.query<{ character_id: number }>('SELECT character_id FROM items WHERE uid = $1', [tunic.uid])).rows;
    check('交易後這件裝備在資料庫中只有一筆，且屬於收到的人', owners.length === 1 && owners[0]?.character_id === idB);

    // 紀錄加總應該等於實際持有（倉庫屬於帳號，所以背包 + 倉庫一起算）
    const sums = async (id: number): Promise<{ coinsLog: number; coins: number }> => {
      const log = (await db.query<{ s: number }>('SELECT COALESCE(SUM(coins), 0)::int AS s FROM item_log WHERE character_id = $1', [id])).rows[0]!.s;
      const real = (await db.query<{ coins: number }>('SELECT coins::int AS coins FROM characters WHERE id = $1', [id])).rows[0]!.coins;
      return { coinsLog: log, coins: real };
    };
    const sa = await sums(idA);
    const sb = await sums(idB);
    check('星幣：異動紀錄加總 = 資料庫中的餘額', sa.coinsLog === sa.coins && sb.coinsLog === sb.coins, `甲 ${sa.coins}，乙 ${sb.coins}`);
    const itemSum = (await db.query<{ item_id: string; logged: number; held: number }>(
      `SELECT l.item_id, l.logged, COALESCE(h.held, 0)::int AS held FROM
         (SELECT item_id, SUM(quantity)::int AS logged FROM item_log
           WHERE character_id = $1 AND item_id IS NOT NULL AND action NOT IN ('storage_in', 'storage_out') GROUP BY item_id) l
       LEFT JOIN
         (SELECT item_id, SUM(quantity)::int AS held FROM items
           WHERE character_id = $1 OR account_id = (SELECT account_id FROM characters WHERE id = $1) GROUP BY item_id) h
       USING (item_id)`,
      [idA],
    )).rows;
    const mismatched = itemSum.filter((r) => r.logged !== r.held);
    check('道具：每種道具的異動紀錄加總 = 背包、裝備與倉庫的實際數量', mismatched.length === 0, mismatched.length > 0 ? JSON.stringify(mismatched) : `${itemSum.length} 種道具`);

    const dupe = await db
      .query(`INSERT INTO items (uid, character_id, location, slot, item_id, quantity) VALUES ($1, $2, 'bag', 39, 'novice_tunic', 1)`, [tunic.uid, idA])
      .then(() => true, () => false);
    check('資料庫拒絕寫入重複的道具編號', !dupe);
  } else {
    console.log('略過  異動紀錄與資料庫檢查（未設定 DATABASE_URL）');
  }

  await db?.end();
  console.log(failed === 0 ? '\n全部通過' : `\n有 ${failed} 項失敗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
