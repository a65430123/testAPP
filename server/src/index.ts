// 伺服器進入點：HTTP API + Colyseus 地圖房間

import { Server } from 'colyseus';
import { MONSTERS, ROOM_MAP, SKILLS, validateGameData } from '@starmemory/shared';
import { config } from './config';
import { runMigrations } from './db/migrate';
import { pool } from './db/pool';
import { registerRoutes } from './http';
import { allMaps } from './maps';
import { MapRoom } from './rooms/MapRoom';

// 資料表（職業、道具、魔物、技能）互相參照有誤就不啟動
const dataErrors = validateGameData();
if (dataErrors.length > 0) {
  console.error(`[server] 資料表有誤：\n  ${dataErrors.join('\n  ')}`);
  process.exit(1);
}

// 先確認資料庫可用並套用 migration，失敗就不啟動
try {
  if (config.autoMigrate) {
    const applied = await runMigrations();
    if (applied.length > 0) {
      console.log(`[server] 已套用 migration：${applied.join('、')}`);
    }
  } else {
    await pool.query('SELECT 1');
  }
} catch (err) {
  console.error(`[server] 無法連線或初始化資料庫：${err instanceof Error ? err.message : String(err)}`);
  console.error('[server] 請確認 PostgreSQL 已啟動，且 DATABASE_URL 設定正確');
  process.exit(1);
}

const gameServer = new Server({
  greet: false,
  express: (app) => registerRoutes(app),
});

// 每張地圖一個房間：以 mapId 區分，同一張地圖的玩家會進到同一個房間（滿了才開新的分流）
gameServer.define(ROOM_MAP, MapRoom).filterBy(['mapId']);

// 關機（Ctrl+C、SIGTERM）時 Colyseus 會先讓所有玩家離線——各房間在此時完成離線存檔——之後才關閉資料庫連線
gameServer.onShutdown(async () => {
  await pool.end();
  console.log('[server] 已完成存檔並關閉');
});

await gameServer.listen(config.port);
console.log(`[server] 已啟動，連接埠 ${config.port}`);
console.log(`[server] 已載入資料表：魔物 ${MONSTERS.length} 種、技能 ${SKILLS.length} 個`);
console.log(`[server] 已載入地圖：${allMaps().map((m) => `${m.id} ${m.displayName}`).join('、')}`);
if (config.gmCommands) {
  console.warn('[server] GM 指令已開啟（ENABLE_GM_COMMANDS），請勿用於正式環境');
}
