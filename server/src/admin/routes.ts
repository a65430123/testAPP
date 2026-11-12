// 管理後台 API（/api/admin/*）：查帳號、封鎖、發道具、公告、線上人數、事件與操作紀錄。
// 每個請求都會重新查資料庫確認角色（gm 或 admin），權限被撤銷或帳號被封鎖時立即失效。

import type { Application, Request, Response } from 'express';
import { matchMaker } from 'colyseus';
import { CLOSE_CODE, getItemDef, type AnnounceMessage, type ErrorResponse } from '@starmemory/shared';
import { verifyToken } from '../auth';
import { loadCharacter } from '../db/characters';
import {
  banAccount,
  getAccountStatus,
  getCharacterOwner,
  insertAdminLog,
  listAdminLog,
  listSecurityEvents,
  recentItemLog,
  searchAccounts,
  unbanAccount,
  type AccountStatus,
} from '../db/admin';
import { getMap } from '../maps';
import { WORLD_ANNOUNCE_TOPIC } from '../rooms/MapRoom';
import { reportEvent } from '../security';
import { hub } from '../social/hub';
import { grantToCharacter } from './grant';

/** 公告與原因的長度上限 */
const TEXT_MAX = 200;
/** 一次發放的上限 */
const GRANT_MAX_QUANTITY = 999;
const GRANT_MAX_COINS = 10_000_000;
/** 「永久」封鎖實際上設成一百年後 */
const PERMANENT_MS = 100 * 365 * 24 * 3600 * 1000;

function fail(res: Response, status: number, error: string): void {
  const body: ErrorResponse = { error };
  res.status(status).json(body);
}

/** 確認請求者是 GM 或管理員；不符合時直接回應錯誤並回傳 null */
async function requireStaff(req: Request, res: Response, adminOnly = false): Promise<AccountStatus | null> {
  const header = req.headers.authorization ?? '';
  const identity = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!identity) {
    fail(res, 401, '請先登入');
    return null;
  }
  const status = await getAccountStatus(identity.accountId);
  if (!status || status.bannedUntil !== null || status.role === 'player' || (adminOnly && status.role !== 'admin')) {
    fail(res, 403, adminOnly ? '需要管理員權限' : '需要 GM 權限');
    return null;
  }
  return status;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, TEXT_MAX) : '';
}

export function registerAdminRoutes(app: Application): void {
  // 目前登入的是誰（後台頁面用來確認權限）
  app.get('/api/admin/me', async (req, res) => {
    const staff = await requireStaff(req, res);
    if (staff) {
      res.json({ username: staff.username, role: staff.role });
    }
  });

  // 線上人數與各地圖人數
  app.get('/api/admin/overview', async (req, res) => {
    if (!(await requireStaff(req, res))) {
      return;
    }
    const byMap = new Map<string, number>();
    const players: Array<{ characterId: number; name: string; level: number; mapId: string }> = [];
    for (const entry of hub.values()) {
      byMap.set(entry.mapId, (byMap.get(entry.mapId) ?? 0) + 1);
      players.push({ characterId: entry.characterId, name: entry.name, level: entry.level, mapId: entry.mapId });
    }
    res.json({
      online: players.length,
      maps: [...byMap].map(([mapId, count]) => ({ mapId, name: getMap(mapId)?.displayName ?? mapId, count })),
      players,
      uptimeSec: Math.floor(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    });
  });

  // 搜尋帳號（帳號名稱、角色名稱或帳號編號）
  app.get('/api/admin/accounts', async (req, res) => {
    if (!(await requireStaff(req, res))) {
      return;
    }
    const keyword = cleanText(req.query.q);
    const accounts = await searchAccounts(keyword);
    res.json({
      accounts: accounts.map((a) => ({
        ...a,
        characters: a.characters.map((c) => ({ ...c, online: hub.get(c.id) !== undefined })),
      })),
    });
  });

  // 角色詳細資料：數值、背包、裝備、最近的道具異動
  app.get('/api/admin/characters/:id', async (req, res) => {
    if (!(await requireStaff(req, res))) {
      return;
    }
    const id = Number(req.params.id);
    const record = Number.isInteger(id) ? await loadCharacter(id) : undefined;
    if (!record) {
      fail(res, 404, '角色不存在');
      return;
    }
    res.json({
      character: {
        id: record.id, accountId: record.accountId, name: record.name, classId: record.classId,
        level: record.level, exp: record.exp, coins: record.coins, mapId: record.mapId,
        x: record.x, y: record.y, stats: record.stats, statPoints: record.statPoints,
        guild: record.guild?.name ?? null, online: hub.get(record.id) !== undefined,
      },
      inventory: record.inventory,
      equipment: record.equipment,
      itemLog: await recentItemLog(id),
    });
  });

  // 封鎖帳號（hours 為 0 表示永久）
  app.post('/api/admin/ban', async (req, res) => {
    const staff = await requireStaff(req, res);
    if (!staff) {
      return;
    }
    const { accountId, hours } = (req.body ?? {}) as { accountId?: unknown; hours?: unknown };
    const reason = cleanText((req.body as { reason?: unknown } | undefined)?.reason);
    if (typeof accountId !== 'number' || typeof hours !== 'number' || !(hours >= 0) || !reason) {
      fail(res, 400, '請填寫帳號、時數與原因');
      return;
    }
    const target = await getAccountStatus(accountId);
    if (!target) {
      fail(res, 404, '帳號不存在');
      return;
    }
    // 不能封鎖自己；GM 不能封鎖其他 GM 或管理員
    if (target.id === staff.id || (target.role !== 'player' && staff.role !== 'admin')) {
      fail(res, 403, '不能封鎖這個帳號');
      return;
    }
    const until = Date.now() + (hours === 0 ? PERMANENT_MS : hours * 3600 * 1000);
    await banAccount(accountId, until, reason);
    // 正在線上的話立刻踢下線（離線存檔照常進行）
    hub.findByAccount(accountId)?.kick(CLOSE_CODE.banned);
    await insertAdminLog({
      adminAccountId: staff.id, adminUsername: staff.username, action: 'ban',
      targetAccountId: accountId, detail: { username: target.username, hours, reason },
    });
    reportEvent({
      level: 'info', kind: 'ban', accountId,
      message: `${staff.username} 封鎖了帳號「${target.username}」（${hours === 0 ? '永久' : `${hours} 小時`}）：${reason}`,
    });
    res.json({ ok: true, bannedUntil: until });
  });

  app.post('/api/admin/unban', async (req, res) => {
    const staff = await requireStaff(req, res);
    if (!staff) {
      return;
    }
    const accountId = (req.body as { accountId?: unknown } | undefined)?.accountId;
    const target = typeof accountId === 'number' ? await getAccountStatus(accountId) : undefined;
    if (!target) {
      fail(res, 404, '帳號不存在');
      return;
    }
    await unbanAccount(target.id);
    await insertAdminLog({
      adminAccountId: staff.id, adminUsername: staff.username, action: 'unban',
      targetAccountId: target.id, detail: { username: target.username },
    });
    res.json({ ok: true });
  });

  // 發放道具或星幣（只有管理員可以）
  app.post('/api/admin/grant', async (req, res) => {
    const staff = await requireStaff(req, res, true);
    if (!staff) {
      return;
    }
    const body = (req.body ?? {}) as { characterId?: unknown; itemId?: unknown; quantity?: unknown; coins?: unknown; reason?: unknown };
    const reason = cleanText(body.reason);
    const characterId = body.characterId;
    const itemId = typeof body.itemId === 'string' && body.itemId !== '' ? body.itemId : undefined;
    const quantity = itemId ? body.quantity : undefined;
    const coins = body.coins === undefined || body.coins === 0 ? undefined : body.coins;
    if (typeof characterId !== 'number' || !reason || (!itemId && coins === undefined)) {
      fail(res, 400, '請填寫角色、原因，以及道具或星幣');
      return;
    }
    if (itemId && (!getItemDef(itemId) || typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > GRANT_MAX_QUANTITY)) {
      fail(res, 400, `道具不存在，或數量不在 1–${GRANT_MAX_QUANTITY} 之間`);
      return;
    }
    if (coins !== undefined && (typeof coins !== 'number' || !Number.isInteger(coins) || Math.abs(coins) > GRANT_MAX_COINS)) {
      fail(res, 400, '星幣數量不合法');
      return;
    }
    const owner = await getCharacterOwner(characterId);
    if (!owner) {
      fail(res, 404, '角色不存在');
      return;
    }
    const result = await grantToCharacter(characterId, {
      ...(itemId ? { itemId, quantity: quantity as number } : {}),
      ...(coins !== undefined ? { coins: coins as number } : {}),
      detail: { adminId: staff.id, admin: staff.username, reason },
    });
    if (result.error) {
      fail(res, 409, result.error);
      return;
    }
    await insertAdminLog({
      adminAccountId: staff.id, adminUsername: staff.username, action: 'grant',
      targetAccountId: owner.accountId, targetCharacterId: characterId,
      detail: { character: owner.name, itemId, quantity, coins, reason, online: result.online },
    });
    res.json({ ok: true, online: result.online });
  });

  // 全伺服器公告
  app.post('/api/admin/announce', async (req, res) => {
    const staff = await requireStaff(req, res);
    if (!staff) {
      return;
    }
    const text = cleanText((req.body as { text?: unknown } | undefined)?.text);
    if (!text) {
      fail(res, 400, '請輸入公告內容');
      return;
    }
    // 透過 presence 發佈，所有地圖房間都會轉送給房內玩家
    const message: AnnounceMessage = { text };
    matchMaker.presence.publish(WORLD_ANNOUNCE_TOPIC, message);
    await insertAdminLog({ adminAccountId: staff.id, adminUsername: staff.username, action: 'announce', detail: { text } });
    res.json({ ok: true, online: [...hub.values()].length });
  });

  // 安全事件與 GM 操作紀錄
  app.get('/api/admin/events', async (req, res) => {
    if (await requireStaff(req, res)) {
      res.json({ events: await listSecurityEvents(200) });
    }
  });

  app.get('/api/admin/log', async (req, res) => {
    if (await requireStaff(req, res)) {
      res.json({ entries: await listAdminLog(200) });
    }
  });
}
