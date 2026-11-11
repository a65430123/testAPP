// 用戶端與伺服器之間的通訊協定：房間名稱、訊息代號、訊息內容型別與共用的驗證規則

import type { InventoryItem, Stats } from './character';

/** Colyseus 房間類型名稱：每張地圖一個房間，以 mapId 區分 */
export const ROOM_MAP = 'map';

/** 伺服器預設連接埠 */
export const DEFAULT_SERVER_PORT = 2567;

/** 新角色的起始地圖 */
export const START_MAP_ID = 'C01';

/** 伺服器模擬與狀態同步的間隔（毫秒），即每秒 20 次 */
export const SERVER_TICK_MS = 50;

/** 伺服器接受同一玩家移動指令的最短間隔（毫秒） */
export const MOVE_MIN_INTERVAL_MS = 80;

/** 聊天訊息長度上限與發言最短間隔 */
export const CHAT_MAX_LENGTH = 120;
export const CHAT_MIN_INTERVAL_MS = 800;

/** 定時存檔間隔（毫秒）：有變動的角色每隔這麼久寫入資料庫一次 */
export const AUTOSAVE_INTERVAL_MS = 30_000;

/** 撿取掉落物的最大距離（格） */
export const PICKUP_RANGE = 2;
/** 掉落物只有歸屬者能撿的保護時間，以及無人撿取時的消失時間（毫秒） */
export const DROP_OWNER_MS = 10_000;
export const DROP_LIFETIME_MS = 60_000;
/** 玩家被擊倒後多久自動復活（毫秒） */
export const REVIVE_DELAY_MS = 5_000;
/** HP／SP 自然回復的間隔（毫秒） */
export const REGEN_INTERVAL_MS = 6_000;
/** 死亡懲罰：損失「升到下一級所需經驗」的這個比例；低於指定等級不罰 */
export const DEATH_EXP_PENALTY = 0.01;
export const DEATH_PENALTY_MIN_LEVEL = 11;

/** 帳號與密碼長度限制（bcrypt 只會使用密碼的前 72 個位元組） */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

/** 角色名稱長度限制 */
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 12;

/** 單一地圖房間人數上限 */
export const ROOM_MAX_CLIENTS = 80;

/** 訊息代號 */
export const MSG = {
  /** 用戶端 → 伺服器：要求移動到某一格 */
  move: 'move',
  /** 伺服器 → 用戶端：移動被拒絕，附上伺服器認定的位置 */
  moveReject: 'moveReject',
  /** 雙向：聊天 */
  chat: 'chat',
  /** 伺服器 → 用戶端：系統訊息 */
  system: 'system',
  /**
   * 用戶端 → 伺服器：要求背包內容（不帶資料，進入房間並準備好接收後送一次）
   * 伺服器 → 用戶端（只傳給本人）：背包內容與星幣
   */
  inventory: 'inventory',
  /** 用戶端 → 伺服器：指定攻擊目標（伺服器會自動追擊並持續普攻） */
  attack: 'attack',
  /** 用戶端 → 伺服器：施放技能 */
  skill: 'skill',
  /** 用戶端 → 伺服器：撿取掉落物 */
  pickup: 'pickup',
  /** 用戶端 → 伺服器：使用背包中的消耗品 */
  useItem: 'useItem',
  /** 用戶端 → 伺服器：把一項素質加 1 */
  allocStat: 'allocStat',
  /** 伺服器 → 用戶端（只傳給本人）：等級、經驗、HP／SP、素質等個人數值 */
  self: 'self',
  /** 伺服器 → 用戶端：戰鬥事件（傷害、未命中、治療），用來顯示數字 */
  combat: 'combat',
  /** 伺服器 → 用戶端：踩到傳送點，請改連另一張地圖的房間 */
  transfer: 'transfer',
} as const;

/** 伺服器主動中斷連線時使用的代碼 */
export const CLOSE_CODE = {
  // 4000–4010 是 Colyseus 內建代碼，自訂代碼從 4100 起
  /** 同一帳號在別處登入 */
  duplicateLogin: 4101,
  /** 切換地圖逾時 */
  transferTimeout: 4102,
} as const;

export type ChatChannel = 'map' | 'world';

export const CHAT_CHANNEL_LABEL: Record<ChatChannel, string> = {
  map: '地圖',
  world: '世界',
};

export interface MoveRequest {
  /** 目標格（整數格座標） */
  x: number;
  y: number;
}

export interface MoveRejectMessage {
  /** 伺服器認定的目前位置（格座標，浮點數） */
  x: number;
  y: number;
}

export interface ChatSendMessage {
  channel: ChatChannel;
  text: string;
}

export interface ChatMessage {
  channel: ChatChannel;
  /** 發言者的連線代號（世界頻道來自其他地圖時無法對應到畫面上的角色） */
  sessionId: string;
  name: string;
  text: string;
}

export interface SystemMessage {
  text: string;
}

export interface TransferMessage {
  mapId: string;
}

/** 註冊與登入共用的請求內容 */
export interface AuthRequest {
  username: string;
  password: string;
}

export interface AuthResponse {
  /** JWT，之後呼叫 API 與加入房間時都要帶上 */
  token: string;
  username: string;
}

/** 選角畫面顯示的角色摘要 */
export interface CharacterSummary {
  id: number;
  name: string;
  classId: string;
  level: number;
  mapId: string;
}

export interface CharacterListResponse {
  characters: CharacterSummary[];
  maxCharacters: number;
}

export interface CreateCharacterRequest {
  name: string;
  classId: string;
}

export interface CreateCharacterResponse {
  character: CharacterSummary;
}

export interface ErrorResponse {
  error: string;
}

/** 加入地圖房間時的參數 */
export interface JoinMapOptions {
  token: string;
  characterId: number;
  mapId: string;
}

export interface AttackRequest {
  /** 魔物在房間狀態中的鍵 */
  targetId: string;
}

export interface SkillRequest {
  skillId: string;
  /** 傷害技能的目標魔物；對自己施放的技能不需要 */
  targetId?: string;
}

export interface PickupRequest {
  dropId: string;
}

export interface UseItemRequest {
  /** 背包格子位置 */
  slot: number;
}

export interface AllocStatRequest {
  stat: keyof Stats;
}

/** 個人數值（只傳給本人） */
export interface SelfMessage {
  level: number;
  exp: number;
  expNext: number;
  hp: number;
  maxHp: number;
  sp: number;
  maxSp: number;
  statPoints: number;
  stats: Stats;
}

/** 戰鬥事件。sourceId／targetId 是玩家的連線代號或魔物的鍵。 */
export interface CombatEvent {
  type: 'damage' | 'miss' | 'heal';
  sourceId: string;
  targetId: string;
  amount: number;
  crit: boolean;
  /** 由技能造成時附上技能代號 */
  skillId?: string;
}

/** 背包同步訊息 */
export interface InventoryMessage {
  items: InventoryItem[];
  coins: number;
}

/**
 * 檢查帳號名稱。
 * @returns 合法時回傳 null，否則回傳錯誤訊息
 */
export function validateUsername(username: unknown): string | null {
  if (typeof username !== 'string') {
    return '請輸入帳號';
  }
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    return `帳號長度需為 ${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} 個字元`;
  }
  if (!/^[A-Za-z0-9_]+$/.test(username)) {
    return '帳號只能使用英文字母、數字與底線';
  }
  return null;
}

/**
 * 檢查密碼。
 * @returns 合法時回傳 null，否則回傳錯誤訊息
 */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') {
    return '請輸入密碼';
  }
  const bytes = new TextEncoder().encode(password).length;
  if (password.length < PASSWORD_MIN_LENGTH || bytes > PASSWORD_MAX_LENGTH) {
    return `密碼長度需為 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 個字元`;
  }
  return null;
}

/**
 * 檢查角色名稱。
 * @returns 合法時回傳 null，否則回傳錯誤訊息
 */
export function validateName(name: unknown): string | null {
  if (typeof name !== 'string') {
    return '請輸入角色名稱';
  }
  const trimmed = name.trim();
  const length = [...trimmed].length;
  if (length < NAME_MIN_LENGTH || length > NAME_MAX_LENGTH) {
    return `角色名稱長度需為 ${NAME_MIN_LENGTH}–${NAME_MAX_LENGTH} 個字`;
  }
  if (!/^[\p{L}\p{N}_]+$/u.test(trimmed)) {
    return '角色名稱只能使用文字、數字與底線';
  }
  return null;
}

/** 整理聊天內容：去頭尾空白、移除控制字元、截斷長度。空字串表示不該送出。 */
export function sanitizeChatText(text: unknown): string {
  if (typeof text !== 'string') {
    return '';
  }
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return [...cleaned].slice(0, CHAT_MAX_LENGTH).join('');
}
