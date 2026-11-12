// 後台與防外掛煙霧測試：管理 API 的權限、查帳號、發道具、公告、封鎖、線上人數，
// 以及封包頻率限制、冷卻濫用偵測、登入失敗與經濟異常的事件、警示 Webhook。
// 用法：伺服器需以 ENABLE_GM_COMMANDS=true 啟動，並設定 DATABASE_URL（測試要直接把帳號設成管理員）。
// 選用：伺服器設 ALERT_WEBHOOK_URL=http://localhost:28999/alert 會驗證 Webhook；
//       設 ECONOMY_WINDOW_SEC=5 會驗證星幣收入警示；AUTH_RATE_LIMIT 設大一點才驗證得到登入失敗事件。

import { createServer } from 'node:http';
import { Client, type Room } from '@colyseus/sdk';
import pg from 'pg';
import {
  CLOSE_CODE,
  DEFAULT_SERVER_PORT,
  MSG,
  ROOM_MAP,
  type AnnounceMessage,
  type AttackRequest,
  type AuthResponse,
  type ChatSendMessage,
  type CombatEvent,
  type CreateCharacterResponse,
  type InventoryMessage,
  type JoinMapOptions,
  type MoveRequest,
  type SelfMessage,
  type SkillRequest,
  type SystemMessage,
  type TransferMessage,
} from '@starmemory/shared';

const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${DEFAULT_SERVER_PORT}`;
const DATABASE_URL = process.env.DATABASE_URL;
const WEBHOOK_PORT = Number(process.env.ALERT_WEBHOOK_PORT ?? 28999);

interface StateView {
  players: { get(key: string): { x: number; y: number; hp: number } | undefined };
  monsters: { forEach(cb: (m: { monsterId: string }, key: string) => void): void };
}

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '通過' : '失敗'}  ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) {
    failed++;
  }
}
const skip = (label: string, reason: string): void => console.log(`略過  ${label}（${reason}）`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return true;
    }
    await sleep(stepMs);
  }
  return condition();
}

async function api<T = any>(method: 'GET' | 'POST', path: string, token?: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

class Player {
  room!: Room<any, StateView>;
  self!: SelfMessage;
  inv!: InventoryMessage;
  leaveCode = 0;
  transfer: TransferMessage | undefined;
  readonly announces: string[] = [];
  readonly system: string[] = [];
  readonly events: CombatEvent[] = [];
  private lastChatAt = 0;

  constructor(
    readonly username: string,
    public token: string,
    readonly accountId: number,
    readonly characterId: number,
    readonly name: string,
  ) {}

  async join(mapId = 'C01'): Promise<void> {
    const options: JoinMapOptions = { token: this.token, characterId: this.characterId, mapId };
    const room = await new Client(SERVER_URL).joinOrCreate<StateView>(ROOM_MAP, options);
    this.room = room;
    this.leaveCode = 0;
    this.transfer = undefined;
    let ready = 0;
    room.onMessage(MSG.self, (m: SelfMessage) => {
      this.self = m;
      ready |= 1;
    });
    room.onMessage(MSG.inventory, (m: InventoryMessage) => {
      this.inv = m;
      ready |= 2;
    });
    room.onMessage(MSG.announce, (m: AnnounceMessage) => this.announces.push(m.text));
    room.onMessage(MSG.system, (m: SystemMessage) => this.system.push(m.text));
    room.onMessage(MSG.combat, (m: CombatEvent) => this.events.push(m));
    room.onMessage(MSG.transfer, (m: TransferMessage) => (this.transfer = m));
    room.onMessage('*', () => undefined);
    room.onLeave((code: number) => (this.leaveCode = code));
    await waitFor(() => room.state?.players?.get(room.sessionId) !== undefined, 3000);
    room.send(MSG.inventory);
    await waitFor(() => ready === 3, 3000);
  }

  async gm(command: string): Promise<void> {
    const wait = this.lastChatAt + 900 - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
    this.lastChatAt = Date.now();
    this.room.send(MSG.chat, { channel: 'map', text: `/gm ${command}` } satisfies ChatSendMessage);
    await sleep(300);
  }

  count(itemId: string): number {
    return this.inv.items.filter((i) => i.itemId === itemId).reduce((n, i) => n + i.quantity, 0);
  }
}

/** 從 JWT 取出帳號編號（JWT 的內容是公開的，只是有簽章） */
function accountIdOf(token: string): number {
  return Number(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sub);
}

const PASSWORD = 'correct-horse-battery';

async function register(username: string): Promise<string> {
  const res = await api<AuthResponse>('POST', '/api/register', undefined, { username, password: PASSWORD });
  if (res.status !== 201) {
    throw new Error(`註冊失敗：${res.status}`);
  }
  return res.body.token;
}

async function createPlayer(tag: string, label: string, classId: string, suffix: number): Promise<Player> {
  const username = `adm_${tag}_${suffix}`;
  const token = await register(username);
  const name = `${label}${suffix}`;
  const created = await api<CreateCharacterResponse>('POST', '/api/characters', token, { name, classId });
  return new Player(username, token, accountIdOf(token), created.body.character.id, name);
}

async function main(): Promise<void> {
  if (!DATABASE_URL) {
    skip('後台與防外掛測試', '未設定 DATABASE_URL，無法把測試帳號設成管理員');
    process.exit(0);
  }
  const db = new pg.Pool({ connectionString: DATABASE_URL });
  const suffix = Math.floor(Math.random() * 900000 + 100000);

  // 接收警示 Webhook 的小伺服器（伺服器有設定 ALERT_WEBHOOK_URL 指到這裡才會收到）
  const webhooks: string[] = [];
  const hookServer = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      webhooks.push(data);
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => hookServer.listen(WEBHOOK_PORT, resolve)).catch(() => undefined);

  const adminToken = await register(`adm_root_${suffix}`);
  const gmToken = await register(`adm_gm_${suffix}`);
  const p = await createPlayer('p', '管甲', 'lightprayer', suffix);
  const q = await createPlayer('q', '管乙', 'bladeguard', suffix);

  // ---------------------------------------------------------- 1. 權限
  check('沒有登入不能使用後台 API', (await api('GET', '/api/admin/overview')).status === 401);
  check('一般玩家不能使用後台 API', (await api('GET', '/api/admin/overview', p.token)).status === 403);
  check('設成管理員之前，連自己註冊的帳號也沒有權限', (await api('GET', '/api/admin/me', adminToken)).status === 403);
  await db.query(`UPDATE accounts SET role = 'admin' WHERE id = $1`, [accountIdOf(adminToken)]);
  await db.query(`UPDATE accounts SET role = 'gm' WHERE id = $1`, [accountIdOf(gmToken)]);
  const me = await api('GET', '/api/admin/me', adminToken);
  check('角色改為管理員後立即生效（不必重新登入）', me.status === 200 && me.body.role === 'admin');

  await p.join();
  await p.gm('hp 1');
  if (!p.system.some((t) => t.includes('HP 已設為'))) {
    skip('後台與防外掛測試', '伺服器未開啟 ENABLE_GM_COMMANDS');
    process.exit(0);
  }

  // ---------------------------------------------------------- 2. 線上人數與查帳號
  const overview = await api('GET', '/api/admin/overview', gmToken);
  check(
    '線上人數與各地圖人數',
    overview.body.online >= 1 && overview.body.players.some((x: any) => x.characterId === p.characterId) && overview.body.maps.some((m: any) => m.mapId === 'C01' && m.count >= 1),
    `線上 ${overview.body.online} 人`,
  );
  const byUser = await api('GET', `/api/admin/accounts?q=${p.username}`, gmToken);
  const byName = await api('GET', `/api/admin/accounts?q=${encodeURIComponent(p.name)}`, gmToken);
  const found = byUser.body.accounts?.[0];
  check('可用帳號名稱或角色名稱搜尋', found?.id === p.accountId && byName.body.accounts?.[0]?.id === p.accountId);
  check('搜尋結果包含角色與線上狀態', found?.characters[0]?.name === p.name && found.characters[0].online === true);
  const detail = await api('GET', `/api/admin/characters/${p.characterId}`, gmToken);
  check('角色詳細資料包含背包、裝備與道具紀錄', detail.body.inventory?.length > 0 && detail.body.equipment?.length === 1 && detail.body.itemLog?.some((l: any) => l.action === 'create'));

  // ---------------------------------------------------------- 3. 發放道具
  const grantBody = { characterId: p.characterId, itemId: 'potion_hp_s', quantity: 3, coins: 500, reason: '測試補償' };
  check('GM 不能發放道具（只有管理員可以）', (await api('POST', '/api/admin/grant', gmToken, grantBody)).status === 403);
  check('不存在的道具、沒有填原因都會被拒絕',
    (await api('POST', '/api/admin/grant', adminToken, { ...grantBody, itemId: 'no_such_item' })).status === 400 &&
    (await api('POST', '/api/admin/grant', adminToken, { ...grantBody, reason: '' })).status === 400);
  const potions = p.count('potion_hp_s');
  const coins = p.inv.coins;
  const granted = await api('POST', '/api/admin/grant', adminToken, grantBody);
  await waitFor(() => p.count('potion_hp_s') === potions + 3, 2000);
  check('發放給在線上的玩家：背包與星幣立即更新', granted.body.online === true && p.count('potion_hp_s') === potions + 3 && p.inv.coins === coins + 500);
  const offline = await api('POST', '/api/admin/grant', adminToken, { characterId: q.characterId, itemId: 'novice_tunic', quantity: 1, reason: '離線補發' });
  await q.join();
  check('發放給離線的玩家：上線後背包裡有', offline.body.online === false && q.count('novice_tunic') === 1);
  const logged = (await db.query(`SELECT character_id, item_id, coins, detail FROM item_log WHERE action = 'admin_grant' AND character_id = ANY($1)`, [[p.characterId, q.characterId]])).rows;
  check('發放都有道具異動紀錄（含管理員與原因）', logged.length === 3 && logged.every((r) => r.detail?.admin === `adm_root_${suffix}` && r.detail?.reason));

  // ---------------------------------------------------------- 4. 公告
  const announced = await api('POST', '/api/admin/announce', gmToken, { text: `維護預告 ${suffix}` });
  await waitFor(() => p.announces.length > 0 && q.announces.length > 0, 2000);
  check('全伺服器公告送達所有線上玩家', announced.status === 200 && p.announces[0] === `維護預告 ${suffix}` && q.announces[0] === `維護預告 ${suffix}`);
  check('空白的公告被拒絕', (await api('POST', '/api/admin/announce', gmToken, { text: '   ' })).status === 400);

  // ---------------------------------------------------------- 5. 冷卻驗證
  const events = async (): Promise<any[]> => (await api('GET', '/api/admin/events', gmToken)).body.events ?? [];
  const heals = (): number => p.events.filter((e) => e.skillId === 'mending_light').length;
  p.room.send(MSG.skill, { skillId: 'mending_light' } satisfies SkillRequest);
  await waitFor(() => heals() === 1, 2000);
  for (let i = 0; i < 22; i++) {
    await sleep(120);
    p.room.send(MSG.skill, { skillId: 'mending_light' } satisfies SkillRequest);
  }
  await sleep(400);
  check('冷卻中重複施放技能全部無效', heals() === 1, `治療 ${heals()} 次`);
  const warned = await waitFor(async () => (await events()).some((e) => e.kind === 'cheat_warn' && e.characterId === p.characterId), 3000, 300);
  check('大量冷卻中的施放要求被記錄為可疑事件', warned);
  check('只到警告程度時不會被中斷連線', p.leaveCode === 0);

  // ---------------------------------------------------------- 6. 封包頻率限制
  const before = { x: q.room.state.players.get(q.room.sessionId)!.x };
  for (let i = 0; i < 400; i++) {
    q.room.send(MSG.move, { x: 10 + (i % 5), y: 15 } satisfies MoveRequest);
  }
  const kicked = await waitFor(() => q.leaveCode !== 0, 5000);
  check('短時間灌入大量訊息會被中斷連線', kicked && q.leaveCode === CLOSE_CODE.antiCheat, `代碼 ${q.leaveCode}，起點 x=${before.x}`);
  const kickEvent = await waitFor(async () => (await events()).some((e) => e.kind === 'cheat_kick' && e.characterId === q.characterId && e.level === 'alert'), 3000, 300);
  check('中斷連線時產生警示等級的安全事件', kickEvent);
  if (await waitFor(() => webhooks.some((w) => w.includes('cheat_kick')), 3000)) {
    const payload = JSON.parse(webhooks.find((w) => w.includes('cheat_kick'))!);
    check('警示送到 Webhook（含 text 與 content 欄位）', typeof payload.text === 'string' && payload.text === payload.content && payload.event.characterId === q.characterId);
  } else {
    skip('警示 Webhook', `伺服器未設定 ALERT_WEBHOOK_URL=http://localhost:${WEBHOOK_PORT}/alert`);
  }
  await q.join();
  check('被中斷後可以重新連線（不會自動封鎖）', q.leaveCode === 0);

  // ---------------------------------------------------------- 7. 封鎖
  check('GM 不能封鎖管理員', (await api('POST', '/api/admin/ban', gmToken, { accountId: accountIdOf(adminToken), hours: 1, reason: '測試' })).status === 403);
  check('不能封鎖自己', (await api('POST', '/api/admin/ban', adminToken, { accountId: accountIdOf(adminToken), hours: 1, reason: '測試' })).status === 403);
  check('封鎖必須填寫原因', (await api('POST', '/api/admin/ban', gmToken, { accountId: p.accountId, hours: 1, reason: '' })).status === 400);
  const banned = await api('POST', '/api/admin/ban', gmToken, { accountId: p.accountId, hours: 1, reason: '使用外掛（測試）' });
  await waitFor(() => p.leaveCode !== 0, 3000);
  check('封鎖後在線上的角色立刻被踢下線', banned.status === 200 && p.leaveCode === CLOSE_CODE.banned, `代碼 ${p.leaveCode}`);
  const login = await api<{ error?: string }>('POST', '/api/login', undefined, { username: p.username, password: PASSWORD });
  check('被封鎖的帳號無法登入，並看到原因', login.status === 403 && (login.body.error ?? '').includes('使用外掛（測試）'));
  check('被封鎖的帳號拿舊的憑證也進不了房間', await p.join().then(() => false, () => true));
  const status = (await api('GET', `/api/admin/accounts?q=${p.username}`, gmToken)).body.accounts[0];
  check('後台顯示封鎖狀態與原因', status.bannedUntil > Date.now() && status.banReason === '使用外掛（測試）');
  await api('POST', '/api/admin/unban', gmToken, { accountId: p.accountId });
  const relogin = await api<AuthResponse>('POST', '/api/login', undefined, { username: p.username, password: PASSWORD });
  check('解除封鎖後可以登入', relogin.status === 200);

  // ---------------------------------------------------------- 8. 登入失敗監控
  let limited = false;
  for (let i = 0; i < 10; i++) {
    const res = await api('POST', '/api/login', undefined, { username: q.username, password: 'wrong-password' });
    limited = limited || res.status === 429;
  }
  if (limited) {
    skip('登入失敗事件', '被登入頻率限制擋下；伺服器設 AUTH_RATE_LIMIT=1000 可驗證');
  } else {
    const flagged = await waitFor(async () => (await events()).some((e) => e.kind === 'login_failures' && e.detail?.username === q.username), 3000, 300);
    check('同一帳號連續登入失敗 10 次會產生安全事件', flagged);
  }

  // ---------------------------------------------------------- 9. 操作紀錄
  const adminLog = (await api('GET', '/api/admin/log', gmToken)).body.entries as any[];
  const mine = adminLog.filter((e) => [`adm_root_${suffix}`, `adm_gm_${suffix}`].includes(e.adminUsername)).map((e) => e.action);
  check('GM 的每個操作都有紀錄', ['ban', 'unban', 'grant', 'announce'].every((a) => mine.includes(a)), mine.join('、'));

  // ---------------------------------------------------------- 10. 星幣收入監控（打倒首領一次拿到大量星幣）
  await q.gm('level 30');
  await sleep(120);
  q.room.send(MSG.move, { x: 21, y: 20 } satisfies MoveRequest);
  await waitFor(() => q.transfer?.mapId === 'D01', 15000);
  await q.room.leave();
  await q.join('D01');
  let bossKey = '';
  await waitFor(() => {
    q.room.state.monsters.forEach((m, key) => {
      if (m.monsterId === 'cellarking_gru') {
        bossKey = key;
      }
    });
    return bossKey !== '';
  }, 20000);
  if (bossKey) {
    q.room.send(MSG.attack, { targetId: bossKey } satisfies AttackRequest);
    await q.gm('slay');
    const flagged = await waitFor(async () => (await events()).some((e) => e.kind === 'coin_rate' && e.characterId === q.characterId), 12000, 500);
    if (flagged) {
      check('短時間內星幣收入遠超預期時產生警示', true);
    } else {
      skip('星幣收入警示', '伺服器未設定 ECONOMY_WINDOW_SEC=5（預設要 10 分鐘才結算）');
    }
  } else {
    skip('星幣收入警示', '首領還在等待重生');
  }

  await q.room.leave().catch(() => undefined);
  hookServer.close();
  await db.end();
  console.log(failed === 0 ? '\n全部通過' : `\n有 ${failed} 項失敗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
