// 伺服器進入點：HTTP API + Colyseus 地圖房間

import { matchMaker, Server } from 'colyseus';
import { MONSTERS, QUESTS, ROOM_MAP, SKILLS, validateGameData, validateQuests } from '@starmemory/shared';
import { config } from './config';
import { runMigrations } from './db/migrate';
import { pool } from './db/pool';
import { registerRoutes } from './http';
import { allMaps } from './maps';
import { MapRoom } from './rooms/MapRoom';
import { log } from './log';
import { reportEvent } from './security';

// 資料表（職業、道具、魔物、技能、NPC、任務）互相參照有誤就不啟動
const dataErrors = [...validateGameData(), ...validateQuests()];
if (dataErrors.length > 0) {
  log.error(`[server] 資料表有誤：\n  ${dataErrors.join('\n  ')}`);
  process.exit(1);
}

// 先確認資料庫可用並套用 migration，失敗就不啟動
try {
  if (config.autoMigrate) {
    const applied = await runMigrations();
    if (applied.length > 0) {
      log.info(`[server] 已套用 migration：${applied.join('、')}`);
    }
  } else {
    await pool.query('SELECT 1');
  }
} catch (err) {
  log.error(`[server] 無法連線或初始化資料庫：${err instanceof Error ? err.message : String(err)}`);
  log.error('[server] 請確認 PostgreSQL 已啟動，且 DATABASE_URL 設定正確');
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
  log.info('[server] 已完成存檔並關閉');
});

// 沒有被任何地方接住的錯誤：一律記錄並發出警示。
// 未捕捉的例外代表程式狀態已不可靠，先讓所有玩家離線存檔再結束行程（由 Docker 等機制重啟）。
process.on('unhandledRejection', (reason) => {
  log.error('未處理的 Promise 錯誤', reason);
  reportEvent({ level: 'alert', kind: 'server_error', message: `未處理的 Promise 錯誤：${reason instanceof Error ? reason.message : String(reason)}` });
});
process.on('uncaughtException', (err) => {
  log.error('未捕捉的例外，伺服器即將關閉', err);
  reportEvent({ level: 'alert', kind: 'server_error', message: `未捕捉的例外：${err.message}` });
  void gameServer.gracefullyShutdown(true, err);
});

await gameServer.listen(config.port);

// 單機時房間之間的訊息轉送（世界頻道、公告）用的是 Node 內建的事件機制，預設同一個主題超過 10 個
// 監聽者就會印警告。每個地圖房間（含分流）都會訂閱這些主題，房間一多就會超過，所以取消這個上限。
const localSubscriptions = (matchMaker.presence as { subscriptions?: { setMaxListeners(n: number): void } }).subscriptions;
localSubscriptions?.setMaxListeners(0);
log.info(`[server] 已啟動，連接埠 ${config.port}`);
log.info(`[server] 已載入資料表：魔物 ${MONSTERS.length} 種、技能 ${SKILLS.length} 個、任務 ${QUESTS.length} 個`);
log.info(`[server] 已載入地圖：${allMaps().map((m) => `${m.id} ${m.displayName}`).join('、')}`);
if (config.gmCommands) {
  log.warn('[server] GM 指令已開啟（ENABLE_GM_COMMANDS），請勿用於正式環境');
}
