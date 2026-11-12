// 公會、好友、首領重生計時的資料存取

import type pg from 'pg';
import { isUniqueViolation, pool } from './pool';

export interface MemberRow {
  characterId: number;
  name: string;
  level: number;
}

export interface GuildRow {
  id: number;
  name: string;
  leaderId: number;
}

/** 公會名稱已被使用 */
export class GuildNameTakenError extends Error {}

// ------------------------------------------------------------ 公會

/** 在既有的交易中建立公會並把會長加入成員（與扣除建立費用同一個交易） */
export async function insertGuild(client: pg.PoolClient, name: string, leaderId: number): Promise<number> {
  try {
    const result = await client.query<{ id: number }>(
      'INSERT INTO guilds (name, leader_id) VALUES ($1, $2) RETURNING id',
      [name, leaderId],
    );
    const id = result.rows[0]!.id;
    await client.query('INSERT INTO guild_members (character_id, guild_id) VALUES ($1, $2)', [leaderId, id]);
    return id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new GuildNameTakenError();
    }
    throw err;
  }
}

export async function getGuild(guildId: number): Promise<GuildRow | undefined> {
  const result = await pool.query<{ id: number; name: string; leader_id: number }>(
    'SELECT id, name, leader_id FROM guilds WHERE id = $1',
    [guildId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, name: row.name, leaderId: row.leader_id } : undefined;
}

/** 角色所屬的公會；沒有公會時回傳 undefined */
export async function getGuildOfCharacter(characterId: number): Promise<GuildRow | undefined> {
  const result = await pool.query<{ id: number; name: string; leader_id: number }>(
    `SELECT g.id, g.name, g.leader_id FROM guild_members m JOIN guilds g ON g.id = m.guild_id
      WHERE m.character_id = $1`,
    [characterId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, name: row.name, leaderId: row.leader_id } : undefined;
}

export async function listGuildMembers(guildId: number): Promise<MemberRow[]> {
  const result = await pool.query<{ id: number; name: string; level: number }>(
    `SELECT c.id, c.name, c.level FROM guild_members m JOIN characters c ON c.id = m.character_id
      WHERE m.guild_id = $1 ORDER BY m.joined_at, c.id`,
    [guildId],
  );
  return result.rows.map((r) => ({ characterId: r.id, name: r.name, level: r.level }));
}

/**
 * 加入公會。人數已滿或角色已有公會時回傳 false。
 * 在交易中鎖住公會那一列再計數，避免同時加入而超過上限。
 */
export async function addGuildMember(guildId: number, characterId: number, maxMembers: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const guild = await client.query('SELECT id FROM guilds WHERE id = $1 FOR UPDATE', [guildId]);
    const count = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM guild_members WHERE guild_id = $1',
      [guildId],
    );
    if (guild.rowCount === 0 || count.rows[0]!.n >= maxMembers) {
      await client.query('ROLLBACK');
      return false;
    }
    const inserted = await client.query(
      'INSERT INTO guild_members (character_id, guild_id) VALUES ($1, $2) ON CONFLICT (character_id) DO NOTHING',
      [characterId, guildId],
    );
    await client.query('COMMIT');
    return inserted.rowCount === 1;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 移除成員（離開或被踢）；回傳是否真的移除了一列 */
export async function removeGuildMember(guildId: number, characterId: number): Promise<boolean> {
  const result = await pool.query('DELETE FROM guild_members WHERE guild_id = $1 AND character_id = $2', [
    guildId,
    characterId,
  ]);
  return result.rowCount === 1;
}

/** 解散公會（成員資料會一併刪除） */
export async function deleteGuild(guildId: number): Promise<void> {
  await pool.query('DELETE FROM guilds WHERE id = $1', [guildId]);
}

// ------------------------------------------------------------ 好友

export async function listFriends(characterId: number): Promise<MemberRow[]> {
  const result = await pool.query<{ id: number; name: string; level: number }>(
    `SELECT c.id, c.name, c.level FROM friends f JOIN characters c ON c.id = f.friend_id
      WHERE f.character_id = $1 ORDER BY c.name`,
    [characterId],
  );
  return result.rows.map((r) => ({ characterId: r.id, name: r.name, level: r.level }));
}

/** 互加好友（雙向各一列，已經是好友時不會重複新增） */
export async function addFriendPair(a: number, b: number): Promise<void> {
  await pool.query(
    `INSERT INTO friends (character_id, friend_id) VALUES ($1, $2), ($2, $1)
     ON CONFLICT (character_id, friend_id) DO NOTHING`,
    [a, b],
  );
}

export async function removeFriendPair(a: number, b: number): Promise<void> {
  await pool.query(
    'DELETE FROM friends WHERE (character_id = $1 AND friend_id = $2) OR (character_id = $2 AND friend_id = $1)',
    [a, b],
  );
}

// ------------------------------------------------------------ 首領重生計時

/** 讀取某張地圖尚未到期的首領重生時間：重生區名稱 → 重生時間（毫秒） */
export async function loadBossTimers(mapId: string): Promise<Map<string, number>> {
  const result = await pool.query<{ spawn_name: string; respawn_at: Date }>(
    'SELECT spawn_name, respawn_at FROM boss_timers WHERE map_id = $1',
    [mapId],
  );
  return new Map(result.rows.map((r) => [r.spawn_name, r.respawn_at.getTime()]));
}

export async function setBossTimer(mapId: string, spawnName: string, respawnAt: number): Promise<void> {
  await pool.query(
    `INSERT INTO boss_timers (map_id, spawn_name, respawn_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))
     ON CONFLICT (map_id, spawn_name) DO UPDATE SET respawn_at = EXCLUDED.respawn_at`,
    [mapId, spawnName, respawnAt],
  );
}

export async function clearBossTimer(mapId: string, spawnName: string): Promise<void> {
  await pool.query('DELETE FROM boss_timers WHERE map_id = $1 AND spawn_name = $2', [mapId, spawnName]);
}
