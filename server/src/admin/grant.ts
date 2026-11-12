// 管理後台發放道具或星幣：玩家在線上時走房間的道具流程，離線時直接寫資料庫。兩種都留下 admin_grant 紀錄。

import { randomUUID } from 'node:crypto';
import { addToContainer, INVENTORY_SIZE } from '@starmemory/shared';
import { getCharacterOwner } from '../db/admin';
import { loadCharacterItems, writeItemChange, type ItemLogEntry, type OwnerChange } from '../db/items';
import { withCharacterLock } from '../db/locks';
import { withTransaction } from '../db/pool';
import { hub, type AdminGrant } from '../social/hub';

/**
 * 發放給指定角色。
 * @returns 成功時 error 為 null；online 表示當下玩家是否在線上
 */
export async function grantToCharacter(
  characterId: number,
  grant: AdminGrant,
): Promise<{ error: string | null; online: boolean }> {
  const live = hub.get(characterId);
  if (live) {
    return { error: await live.adminGrant(grant), online: true };
  }

  const owner = await getCharacterOwner(characterId);
  if (!owner) {
    return { error: '角色不存在', online: false };
  }
  // 離線：鎖住這個角色的寫入佇列後，讀出背包、放入道具、寫回，全部在同一個資料庫交易內。
  // 玩家若剛好在這時登入，載入角色會等這次寫入完成，所以不會讀到舊的背包。
  const error = await withCharacterLock([characterId], () =>
    withTransaction(async (client) => {
      const change: OwnerChange = { characterId, accountId: owner.accountId };
      const logs: ItemLogEntry[] = [];
      if (grant.itemId && grant.quantity) {
        const { bag } = await loadCharacterItems(characterId);
        if (!addToContainer(bag, INVENTORY_SIZE, { itemId: grant.itemId, quantity: grant.quantity }, randomUUID)) {
          return '對方的背包放不下';
        }
        change.bag = bag;
        logs.push({ action: 'admin_grant', characterId, itemId: grant.itemId, quantity: grant.quantity, detail: grant.detail });
      }
      if (grant.coins) {
        const current = await client.query<{ coins: number }>('SELECT coins FROM characters WHERE id = $1 FOR UPDATE', [characterId]);
        if ((current.rows[0]?.coins ?? 0) + grant.coins < 0) {
          return '扣除後星幣會變成負數';
        }
        change.coinsDelta = grant.coins;
        logs.push({ action: 'admin_grant', characterId, coins: grant.coins, detail: grant.detail });
      }
      await writeItemChange(client, [change], logs);
      return null;
    }),
  );
  return { error, online: false };
}
