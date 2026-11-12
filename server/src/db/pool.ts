// PostgreSQL 連線池

import pg from 'pg';
import { config } from '../config';
import { log } from '../log';

// BIGINT（型別代碼 20）預設會以字串回傳；本專案的經驗值與星幣都在安全整數範圍內，直接轉成數字
pg.types.setTypeParser(20, (value) => Number(value));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// 閒置連線發生錯誤（例如資料庫重啟）時只記錄，避免整個行程當掉
pool.on('error', (err) => {
  log.error('[db] 閒置連線發生錯誤：', err.message);
});

/** 在一個交易中執行多個查詢：全部成功才提交，任何一步失敗就全部復原 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** PostgreSQL 的唯一鍵衝突錯誤（例如帳號或角色名稱重複） */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
