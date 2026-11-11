// 房間內每位玩家只存在伺服器、不同步給用戶端的資料

import type { Client } from 'colyseus';
import type { ClassDef, InventoryItem, MoveState, PlayerCombatStats } from '@starmemory/shared';
import type { CharacterRecord } from '../db/characters';
import type { OnlineEntry } from '../online';
import type { PlayerState } from './schema';

export interface PlayerRuntime {
  /** 角色資料（記憶體中的最新狀態） */
  record: CharacterRecord;
  client: Client;
  state: PlayerState;
  move: MoveState;
  cls: ClassDef;
  /** 由等級、素質與裝備算出的戰鬥數值；升級、配點或換裝後重新計算 */
  combat: PlayerCombatStats;
  /** 目前鎖定的攻擊目標（魔物的鍵） */
  targetKey: string | null;
  nextAttackAt: number;
  nextChaseRepathAt: number;
  /** 各技能可再次使用的時間 */
  cooldowns: Map<string, number>;
  dead: boolean;
  reviveAt: number;
  nextRegenAt: number;
  lastMoveAt: number;
  lastChatAt: number;
  lastActionAt: number;
  lastInventoryRequestAt: number;
  /** 位置、等級等資料自上次存檔後有變動 */
  dirty: boolean;
  /** 個人數值有變動，這個 tick 結束時要傳給本人 */
  selfDirty: boolean;
  /** 已踩到傳送點、正在等用戶端換房間 */
  transferring: boolean;
  /** 傳送時已經存過檔，離開房間時不必再存 */
  savedForTransfer: boolean;
  /** 倉庫內容；第一次開啟倉庫時才從資料庫載入 */
  storage: InventoryItem[] | null;
  /**
   * 道具操作的佇列：同一位玩家的道具操作（買賣、精煉、交易…）一律依序執行，
   * 每個操作都看得到前一個操作完成後的背包，避免連點造成重複扣款或重複取得。
   */
  itemQueue: Promise<void>;
  online: OnlineEntry;
  /** 離線存檔完成時呼叫，讓等待中的新連線繼續 */
  resolveLeft: () => void;
}
