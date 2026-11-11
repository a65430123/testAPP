// 用戶端與伺服器之間的通訊協定：房間名稱、訊息代號、訊息內容型別與共用的驗證規則

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

export interface LoginRequest {
  name: string;
}

export interface LoginResponse {
  /** 之後加入房間時要帶上的憑證 */
  token: string;
  name: string;
  /** 角色目前所在地圖，用戶端應加入這張地圖的房間 */
  mapId: string;
}

export interface ErrorResponse {
  error: string;
}

/** 加入地圖房間時的參數 */
export interface JoinMapOptions {
  token: string;
  mapId: string;
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
