// 與伺服器的連線：帳號與角色 API（HTTP）、加入地圖房間（Colyseus WebSocket）

import { Callbacks, Client, type Room } from '@colyseus/sdk';
import {
  DEFAULT_SERVER_PORT,
  ROOM_MAP,
  type AuthRequest,
  type AuthResponse,
  type CharacterListResponse,
  type CharacterSummary,
  type CreateCharacterRequest,
  type CreateCharacterResponse,
  type ErrorResponse,
  type JoinMapOptions,
} from '@starmemory/shared';

/** 用戶端看到的玩家同步狀態（欄位與伺服器的 PlayerState 對應） */
export interface PlayerView {
  name: string;
  classId: string;
  level: number;
  x: number;
  y: number;
}

/** 用戶端看到的地圖房間同步狀態（與伺服器的 MapState 對應） */
export interface MapStateView {
  mapId: string;
  players: {
    size: number;
    get(sessionId: string): PlayerView | undefined;
    forEach(callback: (player: PlayerView, sessionId: string) => void): void;
  };
}

export type MapRoomConnection = Room<any, MapStateView>;

/** 登入後取得的帳號憑證 */
export interface Auth {
  token: string;
  username: string;
}

/** 選好角色後、遊戲進行中使用的連線資訊 */
export interface Session extends Auth {
  character: CharacterSummary;
  /** 角色目前所在地圖；切換地圖時由伺服器通知後更新 */
  mapId: string;
}

/** API 回應錯誤；status 為 HTTP 狀態碼（0 表示連不上伺服器） */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const SERVER_URL: string =
  import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:${DEFAULT_SERVER_PORT}`;

const client = new Client(SERVER_URL);

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, '無法連線到伺服器，請確認伺服器已啟動');
  }
  const data = (await response.json().catch(() => null)) as (T & Partial<ErrorResponse>) | null;
  if (!response.ok || data === null) {
    throw new ApiError(response.status, data?.error ?? `伺服器回應錯誤（${response.status}）`);
  }
  return data;
}

export function register(username: string, password: string): Promise<AuthResponse> {
  const body: AuthRequest = { username, password };
  return request<AuthResponse>('POST', '/api/register', body);
}

export function login(username: string, password: string): Promise<AuthResponse> {
  const body: AuthRequest = { username, password };
  return request<AuthResponse>('POST', '/api/login', body);
}

export function fetchCharacters(auth: Auth): Promise<CharacterListResponse> {
  return request<CharacterListResponse>('GET', '/api/characters', undefined, auth.token);
}

export async function createCharacter(auth: Auth, name: string, classId: string): Promise<CharacterSummary> {
  const body: CreateCharacterRequest = { name, classId };
  return (await request<CreateCharacterResponse>('POST', '/api/characters', body, auth.token)).character;
}

// ------------------------------------------------------------ 憑證保存（重新整理後不必重新登入）

const AUTH_STORAGE_KEY = 'starmemory.auth';

export function loadSavedAuth(): Auth | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    const data = raw ? (JSON.parse(raw) as Partial<Auth>) : null;
    return data && typeof data.token === 'string' && typeof data.username === 'string'
      ? { token: data.token, username: data.username }
      : null;
  } catch {
    return null;
  }
}

export function saveAuth(auth: Auth): void {
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: auth.token, username: auth.username }));
  } catch {
    // 無痕模式等情況下無法儲存，忽略即可（只是重新整理後要再登入一次）
  }
}

export function clearSavedAuth(): void {
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // 同上
  }
}

// ------------------------------------------------------------ 地圖房間

/** 以目前選擇的角色加入指定地圖的房間。角色不在該地圖時伺服器會拒絕。 */
export async function joinMap(session: Session, mapId: string): Promise<MapRoomConnection> {
  const options: JoinMapOptions = { token: session.token, characterId: session.character.id, mapId };
  return client.joinOrCreate<MapStateView>(ROOM_MAP, options);
}

/** 訂閱房間內玩家的加入、離開與狀態變動 */
export interface PlayerCallbacks {
  /** 有玩家加入（進房時已在房內的玩家也會各觸發一次） */
  onAdd(handler: (player: PlayerView, sessionId: string) => void): void;
  onRemove(handler: (player: PlayerView, sessionId: string) => void): void;
  /** 指定玩家的任何欄位有變動（每次同步最多觸發一次） */
  onChange(player: PlayerView, handler: () => void): void;
}

/**
 * 取得玩家狀態的回呼介面。
 * 用戶端沒有伺服器的 schema 類別（狀態結構是連線時由伺服器告知的），
 * 所以 Colyseus 的回呼 API 在這裡沒有型別資訊；把缺少型別的部分集中包在這個函式裡。
 */
export function playerCallbacks(room: MapRoomConnection): PlayerCallbacks {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const callbacks = Callbacks.get(room as any) as any;
  return {
    onAdd: (handler) => void callbacks.onAdd('players', handler),
    onRemove: (handler) => void callbacks.onRemove('players', handler),
    onChange: (player, handler) => void callbacks.onChange(player, handler),
  };
}
