// 線上角色名冊：讓隊伍、公會、好友可以跨地圖房間找到對方並傳訊息。
// 目前存在單一行程的記憶體中；之後多台伺服器時改用 Redis 的發佈／訂閱。

export interface OnlineCharacter {
  readonly characterId: number;
  readonly accountId: number;
  readonly name: string;
  readonly level: number;
  readonly mapId: string;
  readonly guildId: number | null;
  /** 傳訊息給這位玩家的用戶端 */
  send(type: string, message?: unknown): void;
  /** 公會有變動（加入、被踢、解散）時，更新這位玩家在所屬房間裡的資料 */
  setGuild(guild: { id: number; name: string } | null): void;
  /** 把這位玩家踢下線（封鎖帳號時使用） */
  kick(code: number): void;
  /**
   * GM 發放道具或星幣給這位在線上的玩家（走房間的道具流程，會即時反映在他的背包）。
   * @returns 成功時回傳 null，否則回傳原因
   */
  adminGrant(grant: AdminGrant): Promise<string | null>;
}

export interface AdminGrant {
  itemId?: string;
  quantity?: number;
  coins?: number;
  /** 寫進道具異動紀錄的說明（發放的管理員與原因） */
  detail: Record<string, unknown>;
}

const online = new Map<number, OnlineCharacter>();

export const hub = {
  get(characterId: number): OnlineCharacter | undefined {
    return online.get(characterId);
  },
  set(entry: OnlineCharacter): void {
    online.set(entry.characterId, entry);
  },
  /** 只有登記的仍是同一筆時才移除（切換地圖時新房間可能已經先登記了） */
  delete(entry: OnlineCharacter): void {
    if (online.get(entry.characterId) === entry) {
      online.delete(entry.characterId);
    }
  },
  values(): IterableIterator<OnlineCharacter> {
    return online.values();
  },
  /** 找出某個帳號目前在線上的角色 */
  findByAccount(accountId: number): OnlineCharacter | undefined {
    for (const entry of online.values()) {
      if (entry.accountId === accountId) {
        return entry;
      }
    }
    return undefined;
  },
};
