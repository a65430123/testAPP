// 角色資料存取：建立、列表、載入、存檔

import {
  addItemToInventory,
  computeMaxHp,
  computeMaxSp,
  MAX_CHARACTERS_PER_ACCOUNT,
  NEW_CHARACTER,
  newStats,
  type CharacterSummary,
  type ClassDef,
  type InventoryItem,
  type Stats,
} from '@starmemory/shared';
import { isUniqueViolation, pool, withTransaction } from './pool';

/** 遊戲中使用的完整角色資料（對應 characters 一列 + character_items 多列） */
export interface CharacterRecord {
  id: number;
  accountId: number;
  name: string;
  classId: string;
  level: number;
  exp: number;
  statPoints: number;
  stats: Stats;
  hp: number;
  sp: number;
  coins: number;
  mapId: string;
  x: number;
  y: number;
  inventory: InventoryItem[];
}

/** 角色名稱已被使用 */
export class CharacterNameTakenError extends Error {}
/** 帳號的角色數已達上限 */
export class CharacterLimitError extends Error {}

interface CharacterDbRow {
  id: number;
  account_id: number;
  name: string;
  class_id: string;
  level: number;
  exp: number;
  stat_points: number;
  stat_pow: number;
  stat_swf: number;
  stat_con: number;
  stat_mnd: number;
  stat_foc: number;
  stat_for: number;
  hp: number;
  sp: number;
  coins: number;
  map_id: string;
  x: number;
  y: number;
}

export async function listCharacters(accountId: number): Promise<CharacterSummary[]> {
  const result = await pool.query<{ id: number; name: string; class_id: string; level: number; map_id: string }>(
    'SELECT id, name, class_id, level, map_id FROM characters WHERE account_id = $1 ORDER BY id',
    [accountId],
  );
  return result.rows.map((r) => ({ id: r.id, name: r.name, classId: r.class_id, level: r.level, mapId: r.map_id }));
}

/** 建立新角色：寫入初始素質、滿 HP／SP、起始位置與職業的起始道具 */
export async function createCharacter(
  accountId: number,
  name: string,
  cls: ClassDef,
  start: { mapId: string; x: number; y: number },
): Promise<CharacterSummary> {
  const stats = newStats();
  const level = NEW_CHARACTER.level;
  const inventory: InventoryItem[] = [];
  for (const item of cls.startItems) {
    addItemToInventory(inventory, item.itemId, item.quantity);
  }

  try {
    return await withTransaction(async (client) => {
      // 鎖住帳號那一列，避免同時送出多個建立要求而超過角色數上限
      await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
      const count = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM characters WHERE account_id = $1',
        [accountId],
      );
      if (count.rows[0]!.n >= MAX_CHARACTERS_PER_ACCOUNT) {
        throw new CharacterLimitError();
      }
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO characters
           (account_id, name, class_id, level, stat_points,
            stat_pow, stat_swf, stat_con, stat_mnd, stat_foc, stat_for,
            hp, sp, coins, map_id, x, y)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING id`,
        [
          accountId, name, cls.id, level, NEW_CHARACTER.statPoints,
          stats.pow, stats.swf, stats.con, stats.mnd, stats.foc, stats.for,
          computeMaxHp(cls, level, stats), computeMaxSp(cls, level, stats),
          NEW_CHARACTER.coins, start.mapId, start.x, start.y,
        ],
      );
      const id = inserted.rows[0]!.id;
      await insertInventory(client, id, inventory);
      return { id, name, classId: cls.id, level, mapId: start.mapId };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CharacterNameTakenError();
    }
    throw err;
  }
}

/** 載入完整角色資料（含背包）；角色不存在時回傳 undefined */
export async function loadCharacter(characterId: number): Promise<CharacterRecord | undefined> {
  // 若同一角色還有存檔正在寫入，等它完成再讀，確保讀到最新資料
  await pendingSaves.get(characterId);

  const result = await pool.query<CharacterDbRow>(
    `SELECT id, account_id, name, class_id, level, exp, stat_points,
            stat_pow, stat_swf, stat_con, stat_mnd, stat_foc, stat_for,
            hp, sp, coins, map_id, x, y
       FROM characters WHERE id = $1`,
    [characterId],
  );
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  const items = await pool.query<{ slot: number; item_id: string; quantity: number }>(
    'SELECT slot, item_id, quantity FROM character_items WHERE character_id = $1 ORDER BY slot',
    [characterId],
  );
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    classId: row.class_id,
    level: row.level,
    exp: row.exp,
    statPoints: row.stat_points,
    stats: {
      pow: row.stat_pow,
      swf: row.stat_swf,
      con: row.stat_con,
      mnd: row.stat_mnd,
      foc: row.stat_foc,
      for: row.stat_for,
    },
    hp: row.hp,
    sp: row.sp,
    coins: row.coins,
    mapId: row.map_id,
    x: row.x,
    y: row.y,
    inventory: items.rows.map((r) => ({ slot: r.slot, itemId: r.item_id, quantity: r.quantity })),
  };
}

/** 每個角色目前排隊中的存檔；同一角色的存檔一律依序執行，不會互相交錯 */
const pendingSaves = new Map<number, Promise<void>>();

/**
 * 存檔：把角色目前的狀態寫回資料庫。
 * 呼叫當下就會複製一份資料，之後記憶體中的角色繼續變動也不影響這次寫入的內容。
 * @param withInventory 是否連背包一起寫入（背包沒變動時可省略以減少寫入量）
 */
export function saveCharacter(record: CharacterRecord, withInventory: boolean): Promise<void> {
  const snapshot: CharacterRecord = {
    ...record,
    stats: { ...record.stats },
    inventory: withInventory ? record.inventory.map((item) => ({ ...item })) : [],
  };
  const previous = pendingSaves.get(record.id) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined) // 前一次失敗不影響這一次
    .then(() => writeCharacter(snapshot, withInventory));
  pendingSaves.set(record.id, current);
  // 佇列清空後移除，避免 Map 無限成長
  const cleanup = (): void => {
    if (pendingSaves.get(record.id) === current) {
      pendingSaves.delete(record.id);
    }
  };
  current.then(cleanup, cleanup);
  return current;
}

async function writeCharacter(c: CharacterRecord, withInventory: boolean): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE characters SET
         level = $2, exp = $3, stat_points = $4,
         stat_pow = $5, stat_swf = $6, stat_con = $7, stat_mnd = $8, stat_foc = $9, stat_for = $10,
         hp = $11, sp = $12, coins = $13, map_id = $14, x = $15, y = $16, saved_at = now()
       WHERE id = $1`,
      [
        c.id, c.level, c.exp, c.statPoints,
        c.stats.pow, c.stats.swf, c.stats.con, c.stats.mnd, c.stats.foc, c.stats.for,
        c.hp, c.sp, c.coins, c.mapId, c.x, c.y,
      ],
    );
    if (withInventory) {
      // 背包最多 40 格，整批刪除再寫入最單純，也不會留下殘餘資料
      await client.query('DELETE FROM character_items WHERE character_id = $1', [c.id]);
      await insertInventory(client, c.id, c.inventory);
    }
  });
}

async function insertInventory(
  client: { query: (text: string, values: unknown[]) => Promise<unknown> },
  characterId: number,
  inventory: InventoryItem[],
): Promise<void> {
  if (inventory.length === 0) {
    return;
  }
  // 用 unnest 一次寫入多列
  await client.query(
    `INSERT INTO character_items (character_id, slot, item_id, quantity)
     SELECT $1, * FROM unnest($2::int[], $3::text[], $4::int[])`,
    [
      characterId,
      inventory.map((i) => i.slot),
      inventory.map((i) => i.itemId),
      inventory.map((i) => i.quantity),
    ],
  );
}
