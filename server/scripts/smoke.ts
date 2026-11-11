// 連線煙霧測試：對一台執行中的伺服器跑一遍註冊登入、建立角色、移動驗證、聊天、傳送與存檔。
// 用法：先啟動伺服器（npm run server），再執行 npm run smoke
// 環境變數：
//   SERVER_URL    伺服器位址（預設 http://localhost:2567）
//   DATABASE_URL  設定後會直接查資料庫，額外驗證密碼雜湊與定時存檔
// 伺服器若以 ENABLE_GM_COMMANDS=true 啟動，會額外驗證等級與背包的存檔。

import { Client, type Room } from '@colyseus/sdk';
import pg from 'pg';
import {
  AUTOSAVE_INTERVAL_MS,
  CLOSE_CODE,
  DEFAULT_SERVER_PORT,
  MSG,
  PLAYER_MOVE_SPEED,
  ROOM_MAP,
  type AuthResponse,
  type CharacterListResponse,
  type CharacterSummary,
  type ChatMessage,
  type ChatSendMessage,
  type CreateCharacterResponse,
  type InventoryMessage,
  type JoinMapOptions,
  type MoveRejectMessage,
  type MoveRequest,
  type SystemMessage,
  type TransferMessage,
} from '@starmemory/shared';

const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${DEFAULT_SERVER_PORT}`;
const DATABASE_URL = process.env.DATABASE_URL;

interface PlayerView {
  name: string;
  level: number;
  x: number;
  y: number;
}
interface StateView {
  mapId: string;
  players: { get(key: string): PlayerView | undefined; size: number };
}
type MapRoomConn = Room<any, StateView>;

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '通過' : '失敗'}  ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) {
    failed++;
  }
}
function skip(label: string, reason: string): void {
  console.log(`略過  ${label}（${reason}）`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 等到條件成立或逾時 */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return true;
    }
    await sleep(20);
  }
  return condition();
}

async function api<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: T }> {
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

async function join(token: string, characterId: number, mapId: string): Promise<MapRoomConn> {
  const client = new Client(SERVER_URL);
  const options: JoinMapOptions = { token, characterId, mapId };
  const room = await client.joinOrCreate<StateView>(ROOM_MAP, options);
  await waitFor(() => room.state?.players?.get(room.sessionId) !== undefined, 2000);
  return room;
}

const joinFails = (token: string, characterId: number, mapId: string): Promise<boolean> =>
  join(token, characterId, mapId).then(
    async (room) => {
      await room.leave();
      return false;
    },
    () => true,
  );

async function main(): Promise<void> {
  const suffix = Math.floor(Math.random() * 900000 + 100000);
  const db = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL }) : null;

  // ---------------------------------------------------------- 1. 註冊與登入
  const userA = `smoke_a_${suffix}`;
  const userB = `smoke_b_${suffix}`;
  const password = 'correct-horse-battery';

  check('帳號格式不合法時拒絕註冊', (await api('POST', '/api/register', { username: 'x', password })).status === 400);
  check('密碼太短時拒絕註冊', (await api('POST', '/api/register', { username: userA, password: '123' })).status === 400);
  const regA = await api<AuthResponse>('POST', '/api/register', { username: userA, password });
  check('註冊成功並取得 JWT', regA.status === 201 && regA.body.token.split('.').length === 3);
  check(
    '重複的帳號（不分大小寫）被拒絕',
    (await api('POST', '/api/register', { username: userA.toUpperCase(), password })).status === 409,
  );
  check('密碼錯誤無法登入', (await api('POST', '/api/login', { username: userA, password: 'wrong-password' })).status === 401);
  check('不存在的帳號無法登入', (await api('POST', '/api/login', { username: `nobody_${suffix}`, password })).status === 401);
  const loginA = await api<AuthResponse>('POST', '/api/login', { username: userA, password });
  check('正確的帳號密碼可以登入', loginA.status === 200 && loginA.body.username === userA);
  const tokenA = loginA.body.token;
  const tokenB = (await api<AuthResponse>('POST', '/api/register', { username: userB, password })).body.token;

  if (db) {
    const row = (await db.query<{ password_hash: string }>('SELECT password_hash FROM accounts WHERE username = $1', [userA]))
      .rows[0];
    check('資料庫中的密碼是 bcrypt 雜湊而非明碼', /^\$2[aby]\$\d\d\$.{53}$/.test(row?.password_hash ?? ''));
  } else {
    skip('資料庫中的密碼是 bcrypt 雜湊', '未設定 DATABASE_URL');
  }

  // ---------------------------------------------------------- 2. 角色建立與列表
  check('未帶 JWT 不能讀取角色列表', (await api('GET', '/api/characters')).status === 401);
  check('偽造的 JWT 被拒絕', (await api('GET', '/api/characters', undefined, `${tokenA}x`)).status === 401);
  check('不存在的職業被拒絕', (await api('POST', '/api/characters', { name: `甲${suffix}`, classId: 'dragon' }, tokenA)).status === 400);
  const nameA = `甲${suffix}`;
  const nameB = `乙${suffix}`;
  const createA = await api<CreateCharacterResponse>('POST', '/api/characters', { name: nameA, classId: 'bladeguard' }, tokenA);
  const charA = createA.body.character;
  check('建立角色成功，出生在起始地圖', createA.status === 201 && charA.level === 1 && charA.mapId === 'C01');
  check(
    '重複的角色名稱被拒絕',
    (await api('POST', '/api/characters', { name: nameA, classId: 'starcaller' }, tokenB)).status === 409,
  );
  const charB = (await api<CreateCharacterResponse>('POST', '/api/characters', { name: nameB, classId: 'starcaller' }, tokenB))
    .body.character;
  await api('POST', '/api/characters', { name: `丙${suffix}`, classId: 'tinkerer' }, tokenA);
  await api('POST', '/api/characters', { name: `丁${suffix}`, classId: 'shadestep' }, tokenA);
  check(
    '超過角色數上限時被拒絕',
    (await api('POST', '/api/characters', { name: `戊${suffix}`, classId: 'trailhunter' }, tokenA)).status === 409,
  );
  const listA = await api<CharacterListResponse>('GET', '/api/characters', undefined, tokenA);
  check('角色列表只包含自己的角色', listA.body.characters.length === 3 && listA.body.characters[0]?.name === nameA);

  // ---------------------------------------------------------- 3. 進入地圖房間
  check('無效的 JWT 無法加入房間', await joinFails('not-a-jwt', charA.id, 'C01'));
  check('不能使用別人的角色', await joinFails(tokenA, charB.id, 'C01'));
  check('不能自行加入角色不在的地圖', await joinFails(tokenA, charA.id, 'F01'));

  // 包在物件裡，TypeScript 才不會因為「在回呼中指派」而誤判型別
  const inv: { value?: InventoryMessage } = {};
  const getInv = (): InventoryMessage | undefined => inv.value;
  const systemA: string[] = [];
  const hookA = (room: MapRoomConn): void => {
    room.onMessage(MSG.inventory, (m: InventoryMessage) => (inv.value = m));
    room.onMessage(MSG.system, (m: SystemMessage) => systemA.push(m.text));
    room.onMessage(MSG.chat, () => undefined);
    room.send(MSG.inventory);
  };
  let roomA = await join(tokenA, charA.id, 'C01');
  hookA(roomA);
  const roomB = await join(tokenB, charB.id, 'C01');
  const chatsB: ChatMessage[] = [];
  roomB.onMessage(MSG.chat, (m: ChatMessage) => chatsB.push(m));
  roomB.onMessage(MSG.system, () => undefined);
  roomB.onMessage(MSG.inventory, () => undefined);
  const seen = await waitFor(() => roomB.state.players.get(roomA.sessionId)?.name === nameA, 2000);
  check('兩位玩家進入同一個房間並看得到彼此', seen && roomA.roomId === roomB.roomId);
  await waitFor(() => getInv() !== undefined, 2000);
  check(
    '進入房間後收到背包（含職業的起始道具）',
    getInv()?.items.find((i) => i.itemId === 'potion_hp_s')?.quantity === 10 &&
      getInv()!.items.some((i) => i.itemId === 'novice_sword') &&
      getInv()!.coins === 100,
  );

  // ---------------------------------------------------------- 4. 伺服器驗證移動
  const viewOfA = (): PlayerView => roomB.state.players.get(roomA.sessionId)!;
  const start = { x: viewOfA().x, y: viewOfA().y };
  const samples = new Set<string>();
  const sampler = setInterval(() => samples.add(`${viewOfA().x.toFixed(3)},${viewOfA().y.toFixed(3)}`), 25);
  const t0 = Date.now();
  roomA.send(MSG.move, { x: 15, y: 19 } satisfies MoveRequest);
  const arrived = await waitFor(() => Math.abs(viewOfA().x - 15.5) < 0.01 && Math.abs(viewOfA().y - 19.5) < 0.01, 5000);
  const elapsed = (Date.now() - t0) / 1000;
  clearInterval(sampler);
  const distance = Math.hypot(15.5 - start.x, 19.5 - start.y);
  check('角色抵達目標格', arrived);
  check(
    '移動速度由伺服器控制',
    elapsed >= (distance / PLAYER_MOVE_SPEED) * 0.9,
    `${distance.toFixed(1)} 格花了 ${elapsed.toFixed(2)} 秒`,
  );
  check('其他玩家收到多筆中途位置（可供插值）', samples.size >= 8, `${samples.size} 筆`);

  let rejects = 0;
  roomA.onMessage(MSG.moveReject, (_m: MoveRejectMessage) => rejects++);
  roomA.send(MSG.move, { x: 9, y: 9 } satisfies MoveRequest); // 小屋
  await sleep(150);
  roomA.send(MSG.move, { x: 999, y: -5 } satisfies MoveRequest); // 地圖外
  await sleep(150);
  roomA.send(MSG.move, { x: 1.5, y: 'abc' } as unknown as MoveRequest); // 格式錯誤
  await sleep(400);
  check('走向障礙物、地圖外、格式錯誤的要求都被拒絕', rejects === 3, `收到 ${rejects} 次拒絕`);

  // ---------------------------------------------------------- 5. 聊天
  roomA.send(MSG.chat, { channel: 'map', text: '  大家好  ' } satisfies ChatSendMessage);
  await waitFor(() => chatsB.length > 0, 2000);
  check('地圖頻道訊息送達同房玩家', chatsB[0]?.text === '大家好' && chatsB[0]?.name === nameA);

  // ---------------------------------------------------------- 6. 等級與背包（需要 GM 指令）
  await sleep(900);
  systemA.length = 0;
  roomA.send(MSG.chat, { channel: 'map', text: '/gm level 7' } satisfies ChatSendMessage);
  await sleep(500);
  const gmEnabled = systemA.some((t) => t.includes('等級已設為 7'));
  if (gmEnabled) {
    await sleep(500);
    roomA.send(MSG.chat, { channel: 'map', text: '/gm item mat_sticky_dew 25' } satisfies ChatSendMessage);
    await waitFor(() => getInv()?.items.some((i) => i.itemId === 'mat_sticky_dew') === true, 2000);
    check('等級變更同步給其他玩家', viewOfA().level === 7);
    check('取得道具後背包即時更新', getInv()?.items.find((i) => i.itemId === 'mat_sticky_dew')?.quantity === 25);
  } else {
    skip('等級與背包的變更', '伺服器未開啟 ENABLE_GM_COMMANDS');
  }

  // ---------------------------------------------------------- 7. 離線存檔
  await roomA.leave();
  await waitFor(() => roomB.state.players.get(roomA.sessionId) === undefined, 2000);
  inv.value = undefined;
  roomA = await join(tokenA, charA.id, 'C01');
  hookA(roomA);
  await waitFor(() => getInv() !== undefined, 2000);
  const meA = (): PlayerView => roomA.state.players.get(roomA.sessionId)!;
  check('離線後重新進入，位置已存檔', meA().x === 15.5 && meA().y === 19.5, `(${meA().x}, ${meA().y})`);
  if (gmEnabled) {
    check('離線後重新進入，等級已存檔', meA().level === 7);
    check(
      '離線後重新進入，背包已存檔',
      getInv()?.items.find((i) => i.itemId === 'mat_sticky_dew')?.quantity === 25 &&
        getInv()!.items.find((i) => i.itemId === 'potion_hp_s')?.quantity === 10,
    );
  }

  // ---------------------------------------------------------- 8. 定時存檔（需要直接查資料庫）
  if (db) {
    roomA.send(MSG.move, { x: 12, y: 15 } satisfies MoveRequest);
    await waitFor(() => meA().x === 12.5 && meA().y === 15.5, 5000);
    const readPos = async (): Promise<string> => {
      const row = (await db.query<{ x: number; y: number }>('SELECT x, y FROM characters WHERE id = $1', [charA.id])).rows[0];
      return `${row?.x},${row?.y}`;
    };
    const beforeSave = await readPos();
    console.log(`　　　等待定時存檔（最多 ${AUTOSAVE_INTERVAL_MS / 1000 + 3} 秒）…`);
    let saved = false;
    const deadline = Date.now() + AUTOSAVE_INTERVAL_MS + 3000;
    while (Date.now() < deadline && !saved) {
      await sleep(500);
      saved = (await readPos()) === '12.5,15.5';
    }
    check('角色仍在線上時，定時存檔把新位置寫入資料庫', beforeSave === '15.5,19.5' && saved, `存檔前 ${beforeSave}`);
  } else {
    skip('定時存檔', '未設定 DATABASE_URL');
  }

  // ---------------------------------------------------------- 9. 傳送點與跨地圖
  let transfer: TransferMessage | undefined;
  roomA.onMessage(MSG.transfer, (m: TransferMessage) => (transfer = m));
  roomA.send(MSG.move, { x: 14, y: 28 } satisfies MoveRequest);
  await waitFor(() => transfer !== undefined, 8000);
  check('踩到傳送點後收到切換地圖通知', transfer?.mapId === 'F01');
  await roomA.leave();
  check('傳送後不能再回到舊地圖的房間', await joinFails(tokenA, charA.id, 'C01'));
  roomA = await join(tokenA, charA.id, 'F01');
  hookA(roomA);
  check('進入新地圖房間並出現在傳送目的地', roomA.state.mapId === 'F01' && meA().x === 20.5 && meA().y === 3.5);
  const listAfter = await api<CharacterListResponse>('GET', '/api/characters', undefined, tokenA);
  const summary: CharacterSummary | undefined = listAfter.body.characters.find((c) => c.id === charA.id);
  check('角色列表反映新的所在地圖', summary?.mapId === 'F01');

  chatsB.length = 0;
  await sleep(900);
  roomA.send(MSG.chat, { channel: 'world', text: '草原這邊風景不錯' } satisfies ChatSendMessage);
  await waitFor(() => chatsB.length > 0, 2000);
  check('世界頻道訊息送達其他地圖的玩家', chatsB[0]?.channel === 'world' && chatsB[0]?.name === nameA);

  // ---------------------------------------------------------- 10. 同帳號重複登入
  let kickedCode = 0;
  roomA.onLeave((code: number) => (kickedCode = code));
  roomA.send(MSG.move, { x: 20, y: 6 } satisfies MoveRequest);
  await waitFor(() => meA().y === 6.5, 3000);
  const roomA2 = await join(tokenA, charA.id, 'F01');
  roomA2.onMessage(MSG.inventory, () => undefined);
  roomA2.onMessage(MSG.system, () => undefined);
  await waitFor(() => kickedCode !== 0, 2000);
  check('同帳號重複登入時舊連線被中斷', kickedCode === CLOSE_CODE.duplicateLogin, `代碼 ${kickedCode}`);
  const posA2 = roomA2.state.players.get(roomA2.sessionId);
  check('新連線讀到舊連線離線時存下的最新位置', posA2?.x === 20.5 && posA2?.y === 6.5, `(${posA2?.x}, ${posA2?.y})`);

  await roomA2.leave();
  await roomB.leave();
  await db?.end();
  console.log(failed === 0 ? '\n全部通過' : `\n有 ${failed} 項失敗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
