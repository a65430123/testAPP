// 伺服器設定：全部來自環境變數，啟動時會先讀取 server/.env（若存在）

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVER_PORT } from '@starmemory/shared';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) {
  // 已存在的環境變數優先，不會被 .env 覆蓋
  process.loadEnvFile(envFile);
}

const isProduction = process.env.NODE_ENV === 'production';
const DEV_JWT_SECRET = 'dev-only-secret-do-not-use-in-production';

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }
  return value === 'true' || value === '1';
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) ? n : fallback;
}

const jwtSecret = process.env.JWT_SECRET ?? '';
if (isProduction && jwtSecret.length < 32) {
  throw new Error('正式環境必須設定 JWT_SECRET（至少 32 個字元）');
}
if (!jwtSecret) {
  // 這裡還不能用 log 模組（它本身不依賴設定，但為了避免循環匯入，啟動訊息直接輸出）
  process.stderr.write('[server] 未設定 JWT_SECRET，使用開發用金鑰（請勿用於正式環境）\n');
}

export const config = {
  isProduction,
  port: int(process.env.PORT, DEFAULT_SERVER_PORT),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://starmemory:starmemory@localhost:5432/starmemory',
  jwtSecret: jwtSecret || DEV_JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  bcryptRounds: Math.max(4, Math.min(15, int(process.env.BCRYPT_ROUNDS, 12))),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  autoMigrate: bool(process.env.AUTO_MIGRATE, true),
  gmCommands: bool(process.env.ENABLE_GM_COMMANDS, false),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  /** 註冊與登入：同一 IP 每分鐘最多嘗試次數 */
  authRateLimit: Math.max(1, int(process.env.AUTH_RATE_LIMIT, 20)),
  /** 嚴重警示要 POST 到哪個網址（Slack、Discord 的 Webhook 都可以）；空字串表示不發送 */
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? '',
  /** 星幣收入監控的統計區間（秒） */
  economyWindowSec: Math.max(1, int(process.env.ECONOMY_WINDOW_SEC, 600)),
  /** 首領重生時間的倍率（測試時設成很小的數字，就不必真的等 30 分鐘） */
  bossRespawnScale: Math.max(0, Number(process.env.BOSS_RESPAWN_SCALE ?? 1) || 1),
} as const;
