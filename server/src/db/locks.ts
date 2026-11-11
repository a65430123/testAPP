// 角色層級的寫入排隊：同一個角色的資料庫寫入一律依呼叫順序執行，不會互相交錯。
// 一次操作牽涉多個角色時（例如玩家交易），會等所有相關角色前面的寫入都完成才開始。

const queues = new Map<number, Promise<unknown>>();

export function withCharacterLock<T>(characterIds: readonly number[], fn: () => Promise<T>): Promise<T> {
  const ids = [...new Set(characterIds)];
  const previous = ids.map((id) => (queues.get(id) ?? Promise.resolve()).catch(() => undefined));
  const current = Promise.all(previous).then(fn);
  for (const id of ids) {
    queues.set(id, current);
  }
  // 佇列清空後移除，避免 Map 無限成長
  const cleanup = (): void => {
    for (const id of ids) {
      if (queues.get(id) === current) {
        queues.delete(id);
      }
    }
  };
  current.then(cleanup, cleanup);
  return current;
}

/** 等這個角色目前排隊中的寫入全部完成（載入角色前呼叫，確保讀到最新資料） */
export async function waitForCharacterWrites(characterId: number): Promise<void> {
  await (queues.get(characterId) ?? Promise.resolve()).catch(() => undefined);
}
