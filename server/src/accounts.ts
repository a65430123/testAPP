// 帳號與角色的暫存（存在記憶體中，伺服器重啟就會清空）。
// 之後接上 PostgreSQL 時，只要把這個檔案換成資料庫實作即可，對外介面不變。

import { randomBytes } from 'node:crypto';
import { START_MAP_ID } from '@starmemory/shared';
import { getMap } from './maps';

export interface Account {
  id: number;
  name: string;
  /** 目前有效的登入憑證（重新登入會換新，舊的立即失效） */
  token: string;
  /** 角色所在地圖與位置（格座標，浮點數）。伺服器是唯一會改寫這些欄位的地方。 */
  mapId: string;
  x: number;
  y: number;
  /** 目前在線時所屬的連線代號；離線時為 null */
  activeSessionId: string | null;
  /** 把目前在線的連線踢下線（同帳號重複登入時使用） */
  kick: (() => void) | null;
}

const byName = new Map<string, Account>();
const byToken = new Map<string, Account>();
let nextId = 1;

function newToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * 以角色名稱登入：名稱第一次出現就建立新角色，否則沿用原本的角色與位置。
 * 本階段沒有密碼，名稱相同就視為同一人。
 */
export function login(name: string): Account {
  const key = name.toLowerCase();
  let account = byName.get(key);
  if (!account) {
    const map = getMap(START_MAP_ID);
    if (!map) {
      throw new Error(`找不到起始地圖 ${START_MAP_ID}`);
    }
    account = {
      id: nextId++,
      name,
      token: '',
      mapId: map.id,
      x: map.spawn.x,
      y: map.spawn.y,
      activeSessionId: null,
      kick: null,
    };
    byName.set(key, account);
  } else {
    byToken.delete(account.token);
  }
  account.token = newToken();
  byToken.set(account.token, account);
  return account;
}

export function getAccountByToken(token: unknown): Account | undefined {
  return typeof token === 'string' ? byToken.get(token) : undefined;
}
