// 帳號資料存取

import { isUniqueViolation, pool } from './pool';

export interface AccountRow {
  id: number;
  username: string;
  passwordHash: string;
}

/** 帳號名稱已被使用 */
export class UsernameTakenError extends Error {}

export async function createAccount(username: string, passwordHash: string): Promise<AccountRow> {
  try {
    const result = await pool.query<{ id: number }>(
      'INSERT INTO accounts (username, password_hash, last_login_at) VALUES ($1, $2, now()) RETURNING id',
      [username, passwordHash],
    );
    return { id: result.rows[0]!.id, username, passwordHash };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new UsernameTakenError();
    }
    throw err;
  }
}

/** 以帳號名稱查詢（不分大小寫） */
export async function findAccountByUsername(username: string): Promise<AccountRow | undefined> {
  const result = await pool.query<{ id: number; username: string; password_hash: string }>(
    'SELECT id, username, password_hash FROM accounts WHERE lower(username) = lower($1)',
    [username],
  );
  const row = result.rows[0];
  return row ? { id: row.id, username: row.username, passwordHash: row.password_hash } : undefined;
}

export async function touchLastLogin(accountId: number): Promise<void> {
  await pool.query('UPDATE accounts SET last_login_at = now() WHERE id = $1', [accountId]);
}
