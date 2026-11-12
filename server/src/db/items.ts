// 道具的資料庫存取：所有道具與星幣的異動都經由 commitItemChange，
// 在同一個資料庫交易內「寫入道具最新狀態 + 寫入異動紀錄」，全部成功才生效。

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { InventoryItem } from '@starmemory/shared';
import { withCharacterLock } from './locks';
import { pool, withTransaction } from './pool';

export type ItemLocation = 'bag' | 'equip' | 'storage';

/** 道具異動紀錄的一列 */
export interface ItemLogEntry {
  action:
    | 'create'
    | 'pickup'
    | 'use'
    | 'gm'
    | 'shop_buy'
    | 'shop_sell'
    | 'refine'
    | 'card_insert'
    | 'storage_in'
    | 'storage_out'
    | 'trade_out'
    | 'trade_in'
    | 'guild_create'
    | 'quest_turn_in'
    | 'quest_reward';
  characterId: number;
  otherCharacterId?: number;
  itemUid?: string;
  itemId?: string;
  /** 這個角色的道具數量變化（正數取得、負數失去） */
  quantity?: number;
  /** 這個角色的星幣變化 */
  coins?: number;
  detail?: Record<string, unknown>;
}

/** 一位擁有者在這次操作後的狀態：有給的容器會整個以新內容取代 */
export interface OwnerChange {
  characterId: number;
  accountId: number;
  /** 星幣增減（相對值，資料庫以「目前值 + 增減」更新，餘額不足會被資料庫拒絕） */
  coinsDelta?: number;
  bag?: InventoryItem[];
  equip?: InventoryItem[];
  storage?: InventoryItem[];
}

interface ItemRow {
  uid: string;
  slot: number;
  item_id: string;
  quantity: number;
  refine: number;
  card_slots: number;
  cards: string[];
}

function toItem(row: ItemRow): InventoryItem {
  return {
    uid: row.uid,
    slot: row.slot,
    itemId: row.item_id,
    quantity: row.quantity,
    refine: row.refine,
    cardSlots: row.card_slots,
    cards: row.cards,
  };
}

const ITEM_COLUMNS = 'uid, slot, item_id, quantity, refine, card_slots, cards';

/** 讀取角色的背包與身上的裝備 */
export async function loadCharacterItems(
  characterId: number,
): Promise<{ bag: InventoryItem[]; equip: InventoryItem[] }> {
  const result = await pool.query<ItemRow & { location: ItemLocation }>(
    `SELECT location, ${ITEM_COLUMNS} FROM items WHERE character_id = $1 ORDER BY slot`,
    [characterId],
  );
  return {
    bag: result.rows.filter((r) => r.location === 'bag').map(toItem),
    equip: result.rows.filter((r) => r.location === 'equip').map(toItem),
  };
}

/** 讀取帳號的倉庫 */
export async function loadStorage(accountId: number): Promise<InventoryItem[]> {
  const result = await pool.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items WHERE account_id = $1 ORDER BY slot`,
    [accountId],
  );
  return result.rows.map(toItem);
}

async function insertItems(
  client: pg.PoolClient,
  owner: { characterId: number | null; accountId: number | null },
  location: ItemLocation,
  items: InventoryItem[],
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  // 用 unnest 一次寫入多列；cards 是陣列的陣列，改以 JSON 傳入再展開
  await client.query(
    `INSERT INTO items (uid, character_id, account_id, location, slot, item_id, quantity, refine, card_slots, cards)
     SELECT (e->>'uid')::uuid, $1, $2, $3, (e->>'slot')::int, e->>'itemId', (e->>'quantity')::int,
            (e->>'refine')::int, (e->>'cardSlots')::int,
            ARRAY(SELECT jsonb_array_elements_text(e->'cards'))
       FROM jsonb_array_elements($4::jsonb) AS e`,
    [owner.characterId, owner.accountId, location, JSON.stringify(items)],
  );
}

async function insertLogs(client: pg.PoolClient, tx: string, logs: ItemLogEntry[]): Promise<void> {
  if (logs.length === 0) {
    return;
  }
  await client.query(
    `INSERT INTO item_log (tx, action, character_id, other_character_id, item_uid, item_id, quantity, coins, detail)
     SELECT $1, e->>'action', (e->>'characterId')::int, (e->>'otherCharacterId')::int, (e->>'itemUid')::uuid,
            e->>'itemId', COALESCE((e->>'quantity')::int, 0), COALESCE((e->>'coins')::bigint, 0), e->'detail'
       FROM jsonb_array_elements($2::jsonb) AS e`,
    [tx, JSON.stringify(logs)],
  );
}

/** 在既有的交易中寫入道具與紀錄（建立角色時與角色那一列一起寫入） */
export async function writeItemChange(
  client: pg.PoolClient,
  changes: OwnerChange[],
  logs: ItemLogEntry[],
): Promise<void> {
  // 先刪除所有受影響的容器，再寫入新內容：
  // 道具在容器之間搬移（例如交易）時，同一個 uid 才不會在搬移途中撞到主鍵
  for (const change of changes) {
    if (change.bag) {
      await client.query(`DELETE FROM items WHERE character_id = $1 AND location = 'bag'`, [change.characterId]);
    }
    if (change.equip) {
      await client.query(`DELETE FROM items WHERE character_id = $1 AND location = 'equip'`, [change.characterId]);
    }
    if (change.storage) {
      await client.query(`DELETE FROM items WHERE account_id = $1`, [change.accountId]);
    }
  }
  for (const change of changes) {
    if (change.bag) {
      await insertItems(client, { characterId: change.characterId, accountId: null }, 'bag', change.bag);
    }
    if (change.equip) {
      await insertItems(client, { characterId: change.characterId, accountId: null }, 'equip', change.equip);
    }
    if (change.storage) {
      await insertItems(client, { characterId: null, accountId: change.accountId }, 'storage', change.storage);
    }
    if (change.coinsDelta) {
      // 相對更新；characters.coins 有 CHECK (coins >= 0)，餘額不足時整個交易失敗
      await client.query('UPDATE characters SET coins = coins + $2 WHERE id = $1', [
        change.characterId,
        change.coinsDelta,
      ]);
    }
  }
  await insertLogs(client, randomUUID(), logs);
}

/**
 * 提交一次道具異動：等相關角色前面的寫入都完成後，在一個交易內寫入道具、星幣與紀錄。
 * 失敗時資料庫完全不變並丟出例外，呼叫端不應更新記憶體中的資料。
 * @param extra 要在同一個交易內一起執行的其他寫入
 */
export function commitItemChange(
  changes: OwnerChange[],
  logs: ItemLogEntry[],
  extra?: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  return withCharacterLock(
    changes.map((c) => c.characterId),
    () =>
      withTransaction(async (client) => {
        await writeItemChange(client, changes, logs);
        // 需要與道具異動「同生共死」的其他寫入（例如把任務標成已完成、建立公會）
        await extra?.(client);
      }),
  );
}
