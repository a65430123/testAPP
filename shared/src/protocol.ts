// 用戶端與伺服器之間的通訊協定：房間名稱、訊息代號、訊息內容型別與共用的驗證規則

import type { Stats } from './character';
import type { InventoryItem, ItemStack } from './equipment';
import type { QuestProgress } from './quests';

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

/** 與 NPC 互動的最大距離（格） */
export const NPC_RANGE = 3;
/** 一次向商店購買的數量上限 */
export const SHOP_MAX_QUANTITY = 99;
/** 玩家交易：雙方的最大距離（格）、每方最多放幾種道具 */
export const TRADE_RANGE = 6;
export const TRADE_MAX_ITEMS = 10;
/** 交易星幣的稅率（收款方實拿 95%），以及可以交易星幣的最低等級 */
export const TRADE_TAX = 0.05;
export const TRADE_COIN_MIN_LEVEL = 15;

/** 公會：建立費用（星幣）、人數上限、名稱長度 */
export const GUILD_CREATE_COST = 5000;
export const GUILD_MAX_MEMBERS = 30;
/** 好友人數上限 */
export const FRIEND_MAX = 50;
/** 組隊、公會、好友邀請的有效時間（毫秒） */
export const INVITE_TTL_MS = 30_000;

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
  /** 用戶端 → 伺服器：裝備背包中的道具／卸下身上的裝備 */
  equip: 'equip',
  unequip: 'unequip',
  /** 用戶端 → 伺服器：向商店購買／賣出 */
  shopBuy: 'shopBuy',
  shopSell: 'shopSell',
  /** 用戶端 → 伺服器：精煉背包中的裝備 */
  refine: 'refine',
  /** 用戶端 → 伺服器：把卡片鑲嵌到背包中的裝備 */
  cardInsert: 'cardInsert',
  /** 用戶端 → 伺服器：開啟倉庫、存入、取出 */
  storageOpen: 'storageOpen',
  storageDeposit: 'storageDeposit',
  storageWithdraw: 'storageWithdraw',
  /** 伺服器 → 用戶端（只傳給本人）：倉庫內容 */
  storage: 'storage',
  /** 用戶端 → 伺服器：向某位玩家提出交易；伺服器 → 用戶端：有人向你提出交易 */
  tradeRequest: 'tradeRequest',
  /** 用戶端 → 伺服器：接受或拒絕交易邀請 */
  tradeRespond: 'tradeRespond',
  /** 用戶端 → 伺服器：更新自己放上交易的內容、確認、取消 */
  tradeOffer: 'tradeOffer',
  tradeConfirm: 'tradeConfirm',
  tradeCancel: 'tradeCancel',
  /** 伺服器 → 用戶端：交易視窗的最新內容／交易結束 */
  tradeState: 'tradeState',
  tradeEnd: 'tradeEnd',
  /** 用戶端 → 伺服器：組隊、公會、好友的各種操作（內容見 SocialRequest） */
  social: 'social',
  /** 伺服器 → 用戶端：有人邀請你（組隊、公會、好友） */
  socialInvite: 'socialInvite',
  /** 伺服器 → 用戶端（只傳給本人）：隊伍、公會、好友的最新內容 */
  party: 'party',
  guild: 'guild',
  friends: 'friends',
  /** 用戶端 → 伺服器：接任務、回報、放棄；伺服器 → 用戶端：任務狀態 */
  quest: 'quest',
  quests: 'quests',
  /** 用戶端 → 伺服器：把一項素質加 1 */
  allocStat: 'allocStat',
  /** 伺服器 → 用戶端（只傳給本人）：等級、經驗、HP／SP、素質等個人數值 */
  self: 'self',
  /** 伺服器 → 用戶端：戰鬥事件（傷害、未命中、治療），用來顯示數字 */
  combat: 'combat',
  /** 伺服器 → 用戶端：GM 發布的全伺服器公告（顯示在畫面上方） */
  announce: 'announce',
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
  /** 異常操作過多，被防外掛機制中斷 */
  antiCheat: 4103,
  /** 帳號被封鎖 */
  banned: 4104,
} as const;

export type ChatChannel = 'map' | 'world' | 'party' | 'guild';

export const CHAT_CHANNEL_LABEL: Record<ChatChannel, string> = {
  map: '地圖',
  world: '世界',
  party: '隊伍',
  guild: '公會',
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

/** GM 公告 */
export interface AnnounceMessage {
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
  /** 自己配的素質（不含裝備加成） */
  stats: Stats;
  /** 含裝備加成的戰鬥數值 */
  atk: number;
  matk: number;
  def: number;
  mdef: number;
  hit: number;
  eva: number;
  crit: number;
  attackIntervalMs: number;
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

export type SocialKind = 'party' | 'guild' | 'friend';

/** 組隊、公會、好友的操作。targetId 是同地圖玩家的連線代號；characterId 是角色編號（對方可能不在線上）。 */
export type SocialRequest =
  | { action: 'refresh' }
  | { action: 'invite'; kind: SocialKind; targetId: string }
  | { action: 'respond'; kind: SocialKind; accept: boolean }
  | { action: 'partyLeave' }
  | { action: 'partyKick'; characterId: number }
  | { action: 'guildCreate'; name: string }
  | { action: 'guildLeave' }
  | { action: 'guildKick'; characterId: number }
  | { action: 'guildDisband' }
  | { action: 'friendRemove'; characterId: number };

export interface SocialInviteMessage {
  kind: SocialKind;
  fromName: string;
  /** 公會邀請時是公會名稱 */
  detail?: string;
}

/** 隊伍、公會、好友列表中的一位成員 */
export interface SocialMember {
  characterId: number;
  name: string;
  level: number;
  online: boolean;
  /** 所在地圖（不在線上時為空字串） */
  mapId: string;
  /** 隊長或會長 */
  leader: boolean;
}

/** 隊伍內容；沒有隊伍時 members 為空陣列 */
export interface PartyMessage {
  members: SocialMember[];
}

/** 公會內容；沒有公會時 guild 為 null */
export interface GuildMessage {
  guild: { id: number; name: string; members: SocialMember[] } | null;
}

export interface FriendsMessage {
  friends: SocialMember[];
}

export type QuestRequest =
  | { action: 'accept'; questId: string; npcId: string }
  | { action: 'complete'; questId: string; npcId: string }
  | { action: 'abandon'; questId: string };

/** 任務狀態（只傳給本人） */
export interface QuestsMessage {
  active: QuestProgress[];
  /** 已完成的任務代號 */
  done: string[];
}

/** 背包同步訊息（只傳給本人）：背包、身上的裝備與星幣 */
export interface InventoryMessage {
  items: InventoryItem[];
  /** 身上的裝備；slot 是 EQUIP_SLOTS 的索引 */
  equipment: InventoryItem[];
  coins: number;
}

export interface EquipRequest {
  /** 背包格子位置 */
  slot: number;
}

export interface UnequipRequest {
  /** 裝備欄位（EQUIP_SLOTS 的索引） */
  equipSlot: number;
}

export interface ShopBuyRequest {
  npcId: string;
  itemId: string;
  quantity: number;
}

export interface ShopSellRequest {
  npcId: string;
  /** 背包格子位置 */
  slot: number;
  quantity: number;
}

export interface RefineRequest {
  npcId: string;
  /** 背包中要精煉的裝備所在格子 */
  slot: number;
}

export interface CardInsertRequest {
  /** 卡片與目標裝備在背包中的格子位置 */
  cardSlot: number;
  targetSlot: number;
}

export interface StorageOpenRequest {
  npcId: string;
}

export interface StorageMoveRequest {
  npcId: string;
  /** 存入時是背包格子，取出時是倉庫格子 */
  slot: number;
  quantity: number;
}

export interface StorageMessage {
  items: InventoryItem[];
}

export interface TradeRequest {
  /** 對方的連線代號 */
  targetId: string;
}

/** 有人向你提出交易 */
export interface TradeInviteMessage {
  fromId: string;
  fromName: string;
}

export interface TradeRespondRequest {
  accept: boolean;
}

/** 自己放上交易的完整內容（每次送出都會取代上一次的內容） */
export interface TradeOfferRequest {
  /** 以道具的唯一編號指定，避免格子變動後指到別的道具 */
  items: Array<{ uid: string; quantity: number }>;
  coins: number;
}

export interface TradeSide {
  name: string;
  items: ItemStack[];
  coins: number;
  confirmed: boolean;
}

export interface TradeStateMessage {
  mine: TradeSide;
  theirs: TradeSide;
}

export interface TradeEndMessage {
  completed: boolean;
  reason: string;
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
