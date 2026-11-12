// 安全事件與警示：把異常狀況寫進日誌與資料庫（後台可查），嚴重的另外發到 Webhook。

import { config } from './config';
import { insertSecurityEvent, type SecurityEvent } from './db/admin';
import { log } from './log';

/** 同一種警示（同種類、同角色）多久內只發一次 Webhook（毫秒） */
const ALERT_THROTTLE_MS = 60_000;
const lastAlertAt = new Map<string, number>();

/** 把警示 POST 到 Webhook。內容同時帶 text 與 content 欄位，Slack 與 Discord 都能直接顯示。 */
async function sendWebhook(event: SecurityEvent): Promise<void> {
  if (!config.alertWebhookUrl) {
    return;
  }
  const key = `${event.kind}:${event.characterId ?? event.accountId ?? ''}`;
  const now = Date.now();
  if (now - (lastAlertAt.get(key) ?? 0) < ALERT_THROTTLE_MS) {
    return;
  }
  lastAlertAt.set(key, now);
  const text = `[星憶旅團警示] ${event.kind}：${event.message}`;
  try {
    const response = await fetch(config.alertWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text, event }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      log.warn(`警示 Webhook 回應 ${response.status}`);
    }
  } catch (err) {
    log.warn('警示 Webhook 發送失敗', err);
  }
}

/**
 * 回報一個安全事件。不會丟出例外，也不必等待：寫入失敗只記在日誌裡，不影響遊戲進行。
 * level 為 alert 的事件會另外發送 Webhook 警示。
 */
export function reportEvent(event: SecurityEvent): void {
  const line = `[${event.kind}] ${event.message}`;
  const context = { accountId: event.accountId, characterId: event.characterId, ...event.detail };
  if (event.level === 'info') {
    log.info(line, context);
  } else {
    log.warn(line, context);
  }
  insertSecurityEvent(event).catch((err: unknown) => {
    log.error('安全事件寫入資料庫失敗', err);
  });
  if (event.level === 'alert') {
    void sendWebhook(event);
  }
}

// ------------------------------------------------------------ 登入失敗監控

const LOGIN_FAILURE_WINDOW_MS = 10 * 60_000;
const LOGIN_FAILURE_THRESHOLD = 10;
const loginFailures = new Map<string, { count: number; resetAt: number; reported: boolean }>();

/** 記錄一次登入失敗；同一個帳號短時間內失敗太多次時回報（可能有人在猜密碼） */
export function recordLoginFailure(username: string, ip: string): void {
  const key = username.toLowerCase();
  const now = Date.now();
  let entry = loginFailures.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + LOGIN_FAILURE_WINDOW_MS, reported: false };
    loginFailures.set(key, entry);
  }
  entry.count++;
  if (entry.count >= LOGIN_FAILURE_THRESHOLD && !entry.reported) {
    entry.reported = true;
    reportEvent({
      level: 'warn',
      kind: 'login_failures',
      message: `帳號「${username}」在 10 分鐘內登入失敗 ${entry.count} 次`,
      detail: { username, ip },
    });
  }
  // 順手清掉過期的紀錄，避免 Map 無限成長
  if (loginFailures.size > 5000) {
    for (const [k, v] of loginFailures) {
      if (v.resetAt <= now) {
        loginFailures.delete(k);
      }
    }
  }
}

// ------------------------------------------------------------ 星幣收入監控

/** 同等級玩家每小時打怪的預期星幣收入（GDD 10.3 的表格以直線近似） */
export function expectedCoinsPerHour(level: number): number {
  return 6000 + 520 * level;
}

/** 超過預期收入幾倍時視為異常 */
const COIN_RATE_MULTIPLIER = 3;

interface IncomeWindow {
  startedAt: number;
  total: number;
  character: { id: number; accountId: number; name: string; level: number };
}
const incomeWindows = new Map<number, IncomeWindow>();

/**
 * 記錄角色的一筆打怪星幣收入。每個統計區間結束時，若收入超過同等級預期值的 3 倍就回報。
 * 這只是標記給 GM 查看，不會自動處置。
 */
export function recordCoinIncome(character: IncomeWindow['character'], coins: number): void {
  const entry = incomeWindows.get(character.id);
  if (entry) {
    entry.total += coins;
    entry.character = character;
  } else {
    incomeWindows.set(character.id, { startedAt: Date.now(), total: coins, character });
  }
}

// 定期結算到期的統計區間
setInterval(() => {
  const now = Date.now();
  const windowMs = config.economyWindowSec * 1000;
  for (const [id, entry] of incomeWindows) {
    if (now - entry.startedAt < windowMs) {
      continue;
    }
    incomeWindows.delete(id);
    const { character } = entry;
    const limit = ((expectedCoinsPerHour(character.level) * windowMs) / 3_600_000) * COIN_RATE_MULTIPLIER;
    if (entry.total > limit) {
      reportEvent({
        level: 'alert',
        kind: 'coin_rate',
        accountId: character.accountId,
        characterId: character.id,
        message: `角色「${character.name}」（Lv.${character.level}）在 ${config.economyWindowSec} 秒內打怪獲得 ${entry.total} 星幣，超過預期上限 ${Math.round(limit)}`,
        detail: { coins: entry.total, limit: Math.round(limit), windowSec: config.economyWindowSec },
      });
    }
  }
}, 2_000).unref();
