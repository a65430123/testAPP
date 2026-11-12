// 角色資料存取：建立、列表、載入、存檔

import { randomUUID } from 'node:crypto';
import {
  addToContainer,
  computePlayerCombatStats,
  EQUIP_SLOTS,
  getItemDef,
  INVENTORY_SIZE,
  MAX_CHARACTERS_PER_ACCOUNT,
  NEW_CHARACTER,
  newStats,
  slotsForType,
  type CharacterSummary,
  type ClassDef,
  type InventoryItem,
  type Stats,
} from '@starmemory/shared';
import { loadCharacterItems, writeItemChange, type ItemLogEntry } from './items';
import { waitForCharacterWrites, withCharacterLock } from './locks';
import { isUniqueViolation, pool, withTransaction } from './pool';

/** 遊戲中使用的完整角色資料（對應 characters 一列 + items 中屬於這個角色的列） */
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
  /** 目前的星幣（記憶體中的最新值） */
  coins: number;
  /**
   * 打怪得到、還沒寫進資料庫的星幣。存檔時以「資料庫目前值 + 這個數字」更新，
   * 這樣不論存檔與道具交易的先後順序，資料庫的星幣都不會被舊值蓋掉。
   */
  unsavedCoins: number;
  mapId: string;
  x: number;
  y: number;
  /** 背包 */
  inventory: InventoryItem[];
  /** 身上的裝備；slot 是 EQUIP_SLOTS 的索引 */
  equipment: InventoryItem[];
  /** 所屬公會；沒有公會時為 null */
  guild: { id: number; name: string } | null;
  /** 進行中任務的進度（任務代號 → 各目標的累計數量） */
  activeQuests: Map<string, number[]>;
  /** 已完成的任務 */
  doneQuests: Set<string>;
  /** 進度自上次存檔後有變動的任務 */
  dirtyQuests: Set<string>;
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

/** 建立新角色：寫入初始素質、滿 HP／SP、起始位置；起始道具中的裝備直接穿在身上，其餘放進背包 */
export async function createCharacter(
  accountId: number,
  name: string,
  cls: ClassDef,
  start: { mapId: string; x: number; y: number },
): Promise<CharacterSummary> {
  const stats = newStats();
  const level = NEW_CHARACTER.level;
  const bag: InventoryItem[] = [];
  const equip: InventoryItem[] = [];
  for (const item of cls.startItems) {
    const type = getItemDef(item.itemId)?.equip?.type;
    const slotName = type ? slotsForType(type).find((s) => !equip.some((e) => e.slot === EQUIP_SLOTS.indexOf(s))) : undefined;
    if (slotName && item.quantity === 1) {
      equip.push({
        uid: randomUUID(),
        slot: EQUIP_SLOTS.indexOf(slotName),
        itemId: item.itemId,
        quantity: 1,
        refine: 0,
        cardSlots: 0,
        cards: [],
      });
    } else {
      addToContainer(bag, INVENTORY_SIZE, item, randomUUID);
    }
  }
  const combat = computePlayerCombatStats(cls, level, stats, equip);

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
          combat.maxHp, combat.maxSp, NEW_CHARACTER.coins, start.mapId, start.x, start.y,
        ],
      );
      const id = inserted.rows[0]!.id;
      // 起始道具與星幣也留下紀錄，之後才能對得出每個道具的來源
      const logs: ItemLogEntry[] = [...bag, ...equip].map((item) => ({
        action: 'create',
        characterId: id,
        itemUid: item.uid,
        itemId: item.itemId,
        quantity: item.quantity,
      }));
      logs.push({ action: 'create', characterId: id, coins: NEW_CHARACTER.coins });
      await writeItemChange(client, [{ characterId: id, accountId, bag, equip }], logs);
      return { id, name, classId: cls.id, level, mapId: start.mapId };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CharacterNameTakenError();
    }
    throw err;
  }
}

/** 載入完整角色資料（含背包與裝備）；角色不存在時回傳 undefined */
export async function loadCharacter(characterId: number): Promise<CharacterRecord | undefined> {
  // 若同一角色還有寫入正在排隊，等它完成再讀，確保讀到最新資料
  await waitForCharacterWrites(characterId);

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
  const items = await loadCharacterItems(characterId);
  const quests = await pool.query<{ quest_id: string; status: string; progress: number[] }>(
    'SELECT quest_id, status, progress FROM character_quests WHERE character_id = $1',
    [characterId],
  );
  const guild = await pool.query<{ id: number; name: string }>(
    `SELECT g.id, g.name FROM guild_members m JOIN guilds g ON g.id = m.guild_id WHERE m.character_id = $1`,
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
    unsavedCoins: 0,
    mapId: row.map_id,
    x: row.x,
    y: row.y,
    inventory: items.bag,
    equipment: items.equip,
    guild: guild.rows[0] ?? null,
    activeQuests: new Map(quests.rows.filter((q) => q.status === 'active').map((q) => [q.quest_id, q.progress])),
    doneQuests: new Set(quests.rows.filter((q) => q.status === 'done').map((q) => q.quest_id)),
    dirtyQuests: new Set(),
  };
}

/**
 * 存檔：把角色的位置、等級、素質、HP／SP、任務的擊殺進度寫回資料庫，並把打怪得到的星幣加上去。
 * 背包、裝備、倉庫不在這裡寫入——它們在每次異動時就已經即時寫入（見 db/items.ts）。
 * 呼叫當下就會複製一份資料，之後記憶體中的角色繼續變動也不影響這次寫入的內容。
 */
export function saveCharacter(record: CharacterRecord): Promise<void> {
  const snapshot = { ...record, stats: { ...record.stats } };
  const coinsDelta = record.unsavedCoins;
  record.unsavedCoins = 0;
  // 任務的擊殺進度也在這裡一併寫入
  const questProgress = [...record.dirtyQuests]
    .filter((id) => record.activeQuests.has(id))
    .map((id) => ({ id, progress: [...record.activeQuests.get(id)!] }));
  record.dirtyQuests.clear();
  return withCharacterLock([record.id], async () => {
    for (const quest of questProgress) {
      await pool.query(
        `UPDATE character_quests SET progress = $3 WHERE character_id = $1 AND quest_id = $2 AND status = 'active'`,
        [snapshot.id, quest.id, quest.progress],
      );
    }
    await pool
      .query(
        `UPDATE characters SET
           level = $2, exp = $3, stat_points = $4,
           stat_pow = $5, stat_swf = $6, stat_con = $7, stat_mnd = $8, stat_foc = $9, stat_for = $10,
           hp = $11, sp = $12, coins = coins + $13, map_id = $14, x = $15, y = $16, saved_at = now()
         WHERE id = $1`,
        [
          snapshot.id, snapshot.level, snapshot.exp, snapshot.statPoints,
          snapshot.stats.pow, snapshot.stats.swf, snapshot.stats.con,
          snapshot.stats.mnd, snapshot.stats.foc, snapshot.stats.for,
          snapshot.hp, snapshot.sp, coinsDelta, snapshot.mapId, snapshot.x, snapshot.y,
        ],
      );
  }).catch((err: unknown) => {
    // 寫入失敗：把還沒存到的星幣與任務進度標回去，下次存檔再試
    record.unsavedCoins += coinsDelta;
    for (const quest of questProgress) {
      record.dirtyQuests.add(quest.id);
    }
    throw err;
  });
}
