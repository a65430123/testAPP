// 管理後台與安全事件的資料存取

import { pool } from './pool';

export type AccountRole = 'player' | 'gm' | 'admin';

export interface AccountStatus {
  id: number;
  username: string;
  role: AccountRole;
  /** 封鎖到什麼時候（毫秒）；沒有被封鎖時為 null */
  bannedUntil: number | null;
  banReason: string | null;
}

interface StatusRow {
  id: number;
  username: string;
  role: AccountRole;
  banned_until: Date | null;
  ban_reason: string | null;
}

function toStatus(row: StatusRow): AccountStatus {
  const until = row.banned_until?.getTime() ?? null;
  const active = until !== null && until > Date.now();
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    bannedUntil: active ? until : null,
    banReason: active ? row.ban_reason : null,
  };
}

/** 帳號的角色與封鎖狀態（已過期的封鎖視為沒有封鎖） */
export async function getAccountStatus(accountId: number): Promise<AccountStatus | undefined> {
  const result = await pool.query<StatusRow>(
    'SELECT id, username, role, banned_until, ban_reason FROM accounts WHERE id = $1',
    [accountId],
  );
  return result.rows[0] ? toStatus(result.rows[0]) : undefined;
}

/** 設定帳號角色；帳號不存在時回傳 false */
export async function setAccountRole(username: string, role: AccountRole): Promise<boolean> {
  const result = await pool.query('UPDATE accounts SET role = $2 WHERE lower(username) = lower($1)', [username, role]);
  return result.rowCount === 1;
}

export interface AccountSearchRow extends AccountStatus {
  createdAt: number;
  lastLoginAt: number | null;
  characters: Array<{ id: number; name: string; classId: string; level: number; mapId: string; coins: number }>;
}

/** 以帳號或角色名稱搜尋（部分符合，不分大小寫）；關鍵字是數字時也比對帳號編號 */
export async function searchAccounts(keyword: string, limit = 30): Promise<AccountSearchRow[]> {
  // 跳脫 LIKE 的萬用字元，避免關鍵字裡的 % 或 _ 被當成萬用字元
  const pattern = `%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const numeric = /^\d+$/.test(keyword) ? Number(keyword) : -1;
  const accounts = await pool.query<StatusRow & { created_at: Date; last_login_at: Date | null }>(
    `SELECT a.id, a.username, a.role, a.banned_until, a.ban_reason, a.created_at, a.last_login_at
       FROM accounts a
      WHERE a.username ILIKE $1 OR a.id = $2
         OR EXISTS (SELECT 1 FROM characters c WHERE c.account_id = a.id AND c.name ILIKE $1)
      ORDER BY a.last_login_at DESC NULLS LAST, a.id DESC
      LIMIT $3`,
    [pattern, numeric, limit],
  );
  if (accounts.rows.length === 0) {
    return [];
  }
  const characters = await pool.query<{
    id: number; account_id: number; name: string; class_id: string; level: number; map_id: string; coins: number;
  }>(
    'SELECT id, account_id, name, class_id, level, map_id, coins FROM characters WHERE account_id = ANY($1) ORDER BY id',
    [accounts.rows.map((a) => a.id)],
  );
  return accounts.rows.map((a) => ({
    ...toStatus(a),
    createdAt: a.created_at.getTime(),
    lastLoginAt: a.last_login_at?.getTime() ?? null,
    characters: characters.rows
      .filter((c) => c.account_id === a.id)
      .map((c) => ({ id: c.id, name: c.name, classId: c.class_id, level: c.level, mapId: c.map_id, coins: c.coins })),
  }));
}

/** 角色擁有者的帳號編號；角色不存在時回傳 undefined */
export async function getCharacterOwner(characterId: number): Promise<{ accountId: number; name: string } | undefined> {
  const result = await pool.query<{ account_id: number; name: string }>(
    'SELECT account_id, name FROM characters WHERE id = $1',
    [characterId],
  );
  const row = result.rows[0];
  return row ? { accountId: row.account_id, name: row.name } : undefined;
}

export interface ItemLogRow {
  createdAt: number;
  action: string;
  itemId: string | null;
  quantity: number;
  coins: number;
  otherCharacterId: number | null;
  detail: unknown;
}

/** 角色最近的道具異動紀錄 */
export async function recentItemLog(characterId: number, limit = 50): Promise<ItemLogRow[]> {
  const result = await pool.query<{
    created_at: Date; action: string; item_id: string | null; quantity: number; coins: number;
    other_character_id: number | null; detail: unknown;
  }>(
    `SELECT created_at, action, item_id, quantity, coins, other_character_id, detail
       FROM item_log WHERE character_id = $1 ORDER BY id DESC LIMIT $2`,
    [characterId, limit],
  );
  return result.rows.map((r) => ({
    createdAt: r.created_at.getTime(),
    action: r.action,
    itemId: r.item_id,
    quantity: r.quantity,
    coins: r.coins,
    otherCharacterId: r.other_character_id,
    detail: r.detail,
  }));
}

// ------------------------------------------------------------ 封鎖

/** 封鎖帳號到指定時間；帳號不存在時回傳 false */
export async function banAccount(accountId: number, until: number, reason: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE accounts SET banned_until = to_timestamp($2 / 1000.0), ban_reason = $3 WHERE id = $1',
    [accountId, until, reason],
  );
  return result.rowCount === 1;
}

export async function unbanAccount(accountId: number): Promise<boolean> {
  const result = await pool.query('UPDATE accounts SET banned_until = NULL, ban_reason = NULL WHERE id = $1', [
    accountId,
  ]);
  return result.rowCount === 1;
}

// ------------------------------------------------------------ GM 操作紀錄

export interface AdminLogEntry {
  adminAccountId: number;
  adminUsername: string;
  action: 'ban' | 'unban' | 'grant' | 'announce';
  targetAccountId?: number;
  targetCharacterId?: number;
  detail?: Record<string, unknown>;
}

export async function insertAdminLog(entry: AdminLogEntry): Promise<void> {
  await pool.query(
    `INSERT INTO admin_log (admin_account_id, admin_username, action, target_account_id, target_character_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.adminAccountId, entry.adminUsername, entry.action,
      entry.targetAccountId ?? null, entry.targetCharacterId ?? null,
      entry.detail ? JSON.stringify(entry.detail) : null,
    ],
  );
}

export interface AdminLogRow {
  createdAt: number;
  adminUsername: string;
  action: string;
  targetAccountId: number | null;
  targetCharacterId: number | null;
  detail: unknown;
}

export async function listAdminLog(limit = 100): Promise<AdminLogRow[]> {
  const result = await pool.query<{
    created_at: Date; admin_username: string; action: string;
    target_account_id: number | null; target_character_id: number | null; detail: unknown;
  }>(
    `SELECT created_at, admin_username, action, target_account_id, target_character_id, detail
       FROM admin_log ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map((r) => ({
    createdAt: r.created_at.getTime(),
    adminUsername: r.admin_username,
    action: r.action,
    targetAccountId: r.target_account_id,
    targetCharacterId: r.target_character_id,
    detail: r.detail,
  }));
}

// ------------------------------------------------------------ 安全事件

export type EventLevel = 'info' | 'warn' | 'alert';

export interface SecurityEvent {
  level: EventLevel;
  kind: string;
  accountId?: number;
  characterId?: number;
  message: string;
  detail?: Record<string, unknown>;
}

export async function insertSecurityEvent(event: SecurityEvent): Promise<void> {
  await pool.query(
    `INSERT INTO security_events (level, kind, account_id, character_id, message, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      event.level, event.kind, event.accountId ?? null, event.characterId ?? null, event.message,
      event.detail ? JSON.stringify(event.detail) : null,
    ],
  );
}

export interface SecurityEventRow {
  id: number;
  createdAt: number;
  level: EventLevel;
  kind: string;
  accountId: number | null;
  characterId: number | null;
  message: string;
  detail: unknown;
}

export async function listSecurityEvents(limit = 100): Promise<SecurityEventRow[]> {
  const result = await pool.query<{
    id: number; created_at: Date; level: EventLevel; kind: string;
    account_id: number | null; character_id: number | null; message: string; detail: unknown;
  }>(
    `SELECT id::int, created_at, level, kind, account_id, character_id, message, detail
       FROM security_events ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at.getTime(),
    level: r.level,
    kind: r.kind,
    accountId: r.account_id,
    characterId: r.character_id,
    message: r.message,
    detail: r.detail,
  }));
}
