// 伺服器端防外掛：封包頻率限制，以及可疑行為的累計與處置。
//
// 這個遊戲的移動、攻擊間隔、技能冷卻、傷害、掉落全部由伺服器計算，用戶端只送「我想做什麼」，
// 所以改用戶端無法加速或竄改數值。這裡處理的是剩下的部分：
// 1. 灌封包（一秒送幾百個訊息拖慢伺服器）
// 2. 正常用戶端不會送出的要求（冷卻中硬放技能、隔很遠撿東西、格式錯誤的內容）
// 這些要求本來就會被拒絕，這裡額外累計「可疑分數」，分數太高就中斷連線並發出警示。

import type { Client } from 'colyseus';
import { CLOSE_CODE } from '@starmemory/shared';
import { reportEvent } from '../security';

/** 封包頻率：每條連線的額度上限，以及每秒補充的額度（正常遊玩每秒約 5–10 個訊息） */
const BUCKET_CAPACITY = 60;
const BUCKET_REFILL_PER_SEC = 30;

/** 可疑分數每秒自然減少多少（偶爾的誤觸會自己消掉） */
const SCORE_DECAY_PER_SEC = 0.2;
/** 分數到這裡記一筆警告；到這裡中斷連線 */
const WARN_SCORE = 15;
const KICK_SCORE = 40;
/** 同一位玩家的警告多久最多記一次（毫秒） */
const WARN_INTERVAL_MS = 60_000;

/** 可疑行為的種類與每次累計的分數 */
export const VIOLATION = {
  /** 超過封包頻率（每個被丟棄的訊息算一次） */
  rate: { weight: 1, label: '封包頻率過高' },
  /** 技能還在冷卻就要求施放（用戶端的按鈕會擋，偶爾連點會誤觸） */
  cooldown: { weight: 1, label: '冷卻中施放技能' },
  /** 距離不夠就要求撿取或施放 */
  range: { weight: 1, label: '超出距離的操作' },
  /** 格式錯誤的訊息（正常用戶端不會送出） */
  invalid: { weight: 2, label: '格式錯誤的訊息' },
  /** 移動速度超過上限（移動由伺服器模擬，理論上不會發生；發生代表程式有漏洞） */
  speed: { weight: 10, label: '移動速度異常' },
} as const;

export type ViolationKind = keyof typeof VIOLATION;

/** 被累計的對象 */
export interface Suspect {
  client: Client;
  accountId: number;
  characterId: number;
  name: string;
}

interface Track {
  tokens: number;
  refilledAt: number;
  score: number;
  scoredAt: number;
  lastWarnAt: number;
  counts: Partial<Record<ViolationKind, number>>;
  kicked: boolean;
}

export class AntiCheat {
  private readonly tracks = new Map<string, Track>();

  constructor(private readonly mapId: string) {}

  private track(sessionId: string, now: number): Track {
    let track = this.tracks.get(sessionId);
    if (!track) {
      track = { tokens: BUCKET_CAPACITY, refilledAt: now, score: 0, scoredAt: now, lastWarnAt: 0, counts: {}, kicked: false };
      this.tracks.set(sessionId, track);
    }
    return track;
  }

  /**
   * 每收到一個訊息呼叫一次。
   * @returns 是否放行；false 表示超過頻率，這個訊息應該直接丟棄
   */
  allowMessage(suspect: Suspect | undefined, sessionId: string): boolean {
    const now = Date.now();
    const track = this.track(sessionId, now);
    if (track.kicked) {
      return false;
    }
    track.tokens = Math.min(BUCKET_CAPACITY, track.tokens + ((now - track.refilledAt) / 1000) * BUCKET_REFILL_PER_SEC);
    track.refilledAt = now;
    if (track.tokens >= 1) {
      track.tokens -= 1;
      return true;
    }
    if (suspect) {
      this.flag(suspect, 'rate');
    }
    return false;
  }

  /** 記錄一次可疑行為；分數太高時中斷連線 */
  flag(suspect: Suspect, kind: ViolationKind, detail?: Record<string, unknown>): void {
    const now = Date.now();
    const track = this.track(suspect.client.sessionId, now);
    if (track.kicked) {
      return;
    }
    track.score = Math.max(0, track.score - ((now - track.scoredAt) / 1000) * SCORE_DECAY_PER_SEC) + VIOLATION[kind].weight;
    track.scoredAt = now;
    track.counts[kind] = (track.counts[kind] ?? 0) + 1;

    const context = { mapId: this.mapId, score: Math.round(track.score), counts: track.counts, ...detail };
    if (track.score >= KICK_SCORE) {
      track.kicked = true;
      reportEvent({
        level: 'alert',
        kind: 'cheat_kick',
        accountId: suspect.accountId,
        characterId: suspect.characterId,
        message: `角色「${suspect.name}」因異常操作過多被中斷連線（最後一次：${VIOLATION[kind].label}）`,
        detail: context,
      });
      suspect.client.leave(CLOSE_CODE.antiCheat);
      return;
    }
    if (track.score >= WARN_SCORE && now - track.lastWarnAt >= WARN_INTERVAL_MS) {
      track.lastWarnAt = now;
      reportEvent({
        level: 'warn',
        kind: 'cheat_warn',
        accountId: suspect.accountId,
        characterId: suspect.characterId,
        message: `角色「${suspect.name}」出現多次可疑操作（${VIOLATION[kind].label}）`,
        detail: context,
      });
    }
  }

  /** 玩家離開房間時清掉紀錄 */
  remove(sessionId: string): void {
    this.tracks.delete(sessionId);
  }
}
