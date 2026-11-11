// 線上角色登記：一個帳號同一時間只能有一個角色在線上。
// 目前存在單一行程的記憶體中；之後多台伺服器時改放 Redis。

export interface OnlineEntry {
  characterId: number;
  /** 把這條連線踢下線，並等它的離線存檔完成 */
  kick: () => Promise<void>;
}

const online = new Map<number, OnlineEntry>();

export function getOnline(accountId: number): OnlineEntry | undefined {
  return online.get(accountId);
}

export function setOnline(accountId: number, entry: OnlineEntry): void {
  online.set(accountId, entry);
}

/** 只有登記的仍是同一筆時才移除，避免把後來登入的新連線清掉 */
export function clearOnline(accountId: number, entry: OnlineEntry): void {
  if (online.get(accountId) === entry) {
    online.delete(accountId);
  }
}

export function onlineCount(): number {
  return online.size;
}
