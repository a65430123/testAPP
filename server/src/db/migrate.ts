// Migration 執行器：依檔名順序執行 server/migrations/*.sql，已套用的記錄在 schema_migrations 資料表。
// 可單獨執行：npm run migrate

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool } from './pool';

const MIGRATION_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
/** 多個行程同時啟動時，用這把諮詢鎖確保同一時間只有一個在執行 migration */
const ADVISORY_LOCK_KEY = 727_001;

/**
 * 執行所有尚未套用的 migration。每個檔案在自己的交易中執行，失敗會整個復原。
 * @returns 這次新套用的檔名
 */
export async function runMigrations(): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = readdirSync(MIGRATION_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (done.has(file)) {
        continue;
      }
      const sql = readFileSync(MIGRATION_DIR + file, 'utf-8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} 執行失敗：${err instanceof Error ? err.message : String(err)}`);
      }
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}

// 直接執行這個檔案時（npm run migrate）：跑完就結束
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMigrations()
    .then((applied) => {
      console.log(applied.length > 0 ? `已套用：${applied.join('、')}` : '沒有需要套用的 migration');
      return pool.end();
    })
    .catch(async (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
