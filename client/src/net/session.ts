// 與伺服器的連線：登入（HTTP）與加入地圖房間（Colyseus WebSocket）

import { Callbacks, Client, type Room } from '@colyseus/sdk';
import {
  DEFAULT_SERVER_PORT,
  ROOM_MAP,
  type ErrorResponse,
  type JoinMapOptions,
  type LoginRequest,
  type LoginResponse,
} from '@starmemory/shared';

/** 用戶端看到的玩家同步狀態（欄位與伺服器的 PlayerState 對應） */
export interface PlayerView {
  name: string;
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

/** 登入後保存在記憶體中的資訊 */
export interface Session {
  token: string;
  name: string;
  /** 角色目前所在地圖；切換地圖時由伺服器通知後更新 */
  mapId: string;
}

export const SERVER_URL: string =
  import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:${DEFAULT_SERVER_PORT}`;

const client = new Client(SERVER_URL);

/** 以角色名稱登入；失敗時丟出帶有中文訊息的 Error */
export async function login(name: string): Promise<Session> {
  const request: LoginRequest = { name };
  let response: Response;
  try {
    response = await fetch(`${SERVER_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    throw new Error('無法連線到伺服器，請確認伺服器已啟動');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorResponse | null;
    throw new Error(body?.error ?? `登入失敗（${response.status}）`);
  }
  const body = (await response.json()) as LoginResponse;
  return { token: body.token, name: body.name, mapId: body.mapId };
}

/** 加入指定地圖的房間。角色不在該地圖時伺服器會拒絕。 */
export async function joinMap(session: Session, mapId: string): Promise<MapRoomConnection> {
  const options: JoinMapOptions = { token: session.token, mapId };
  return client.joinOrCreate<MapStateView>(ROOM_MAP, options);
}

/** 訂閱房間內玩家的加入、離開與位置變動 */
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
