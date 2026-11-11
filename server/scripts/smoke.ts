// 連線煙霧測試：對一台執行中的伺服器跑一遍登入、移動驗證、聊天、傳送。
// 用法：先啟動伺服器（npm run server），再執行 npm run smoke
// 可用環境變數 SERVER_URL 指定伺服器位址（預設 http://localhost:2567）

import { Client, type Room } from '@colyseus/sdk';
import {
  CLOSE_CODE,
  DEFAULT_SERVER_PORT,
  MSG,
  PLAYER_MOVE_SPEED,
  ROOM_MAP,
  type ChatMessage,
  type ChatSendMessage,
  type JoinMapOptions,
  type LoginResponse,
  type MoveRejectMessage,
  type MoveRequest,
  type TransferMessage,
} from '@starmemory/shared';

const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${DEFAULT_SERVER_PORT}`;

interface PlayerView {
  name: string;
  x: number;
  y: number;
}
interface StateView {
  mapId: string;
  players: { get(key: string): PlayerView | undefined; size: number };
}

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '通過' : '失敗'}  ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) {
    failed++;
  }
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

async function login(name: string): Promise<LoginResponse> {
  const res = await fetch(`${SERVER_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(`登入失敗：${res.status} ${await res.text()}`);
  }
  return (await res.json()) as LoginResponse;
}

async function join(token: string, mapId: string): Promise<Room<any, StateView>> {
  const client = new Client(SERVER_URL);
  const options: JoinMapOptions = { token, mapId };
  const room = await client.joinOrCreate<StateView>(ROOM_MAP, options);
  await waitFor(() => room.state?.players?.get(room.sessionId) !== undefined, 2000);
  return room;
}

async function main(): Promise<void> {
  const suffix = Math.floor(Math.random() * 9000 + 1000);

  // 1. 登入
  const badName = await fetch(`${SERVER_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x' }),
  });
  check('不合法的名稱被拒絕', badName.status === 400);
  const a = await login(`測試甲${suffix}`);
  const b = await login(`測試乙${suffix}`);
  check('登入後取得憑證與起始地圖', a.token.length > 10 && a.mapId === 'C01', `地圖 ${a.mapId}`);

  // 2. 進入地圖房間、看得到彼此
  const roomA = await join(a.token, a.mapId);
  const roomB = await join(b.token, b.mapId);
  const seen = await waitFor(() => roomB.state.players.get(roomA.sessionId)?.name === a.name, 2000);
  check('兩位玩家進入同一個房間並看得到彼此', seen && roomA.roomId === roomB.roomId);

  // 3. 無效憑證、不在該地圖都不能加入
  const noToken = await join('不存在的憑證', 'C01').then(() => true, () => false);
  check('無效憑證無法加入房間', !noToken);
  const wrongMap = await join(b.token, 'F01').then(() => true, () => false);
  check('不能自行加入角色不在的地圖', !wrongMap);

  // 4. 移動：B 觀察 A 的位置由伺服器逐步推進，且速度不超過上限
  const me = (): PlayerView => roomB.state.players.get(roomA.sessionId)!;
  const start = { x: me().x, y: me().y };
  const samples: Array<{ t: number; x: number; y: number }> = [];
  const sampler = setInterval(() => samples.push({ t: Date.now(), x: me().x, y: me().y }), 25);
  const target: MoveRequest = { x: 15, y: 19 };
  const t0 = Date.now();
  roomA.send(MSG.move, target);
  const arrived = await waitFor(() => Math.abs(me().x - 15.5) < 0.01 && Math.abs(me().y - 19.5) < 0.01, 5000);
  const elapsed = (Date.now() - t0) / 1000;
  clearInterval(sampler);
  const distance = Math.hypot(15.5 - start.x, 19.5 - start.y);
  const distinct = new Set(samples.map((s) => `${s.x.toFixed(3)},${s.y.toFixed(3)}`)).size;
  check('角色抵達目標格', arrived, `(${me().x.toFixed(2)}, ${me().y.toFixed(2)})`);
  check(
    '移動速度由伺服器控制',
    elapsed >= (distance / PLAYER_MOVE_SPEED) * 0.9,
    `${distance.toFixed(1)} 格花了 ${elapsed.toFixed(2)} 秒`,
  );
  check('其他玩家收到多筆中途位置（可供插值）', distinct >= 8, `${distinct} 筆不同位置`);

  // 5. 伺服器拒絕走到障礙物或地圖外
  let rejects = 0;
  roomA.onMessage(MSG.moveReject, (_m: MoveRejectMessage) => rejects++);
  const before = { x: me().x, y: me().y };
  roomA.send(MSG.move, { x: 9, y: 9 } satisfies MoveRequest); // 小屋
  await sleep(150);
  roomA.send(MSG.move, { x: 999, y: -5 } satisfies MoveRequest); // 地圖外
  await sleep(150);
  roomA.send(MSG.move, { x: 1.5, y: 'abc' } as unknown as MoveRequest); // 格式錯誤
  await sleep(400);
  check('走向障礙物、地圖外、格式錯誤的要求都被拒絕', rejects === 3, `收到 ${rejects} 次拒絕`);
  check('被拒絕後位置不變', me().x === before.x && me().y === before.y);

  // 6. 地圖頻道聊天
  const chatsB: ChatMessage[] = [];
  roomB.onMessage(MSG.chat, (m: ChatMessage) => chatsB.push(m));
  roomA.send(MSG.chat, { channel: 'map', text: '  大家好  ' } satisfies ChatSendMessage);
  await waitFor(() => chatsB.length > 0, 2000);
  check(
    '地圖頻道訊息送達同房玩家',
    chatsB[0]?.text === '大家好' && chatsB[0]?.name === a.name && chatsB[0]?.channel === 'map',
  );

  // 7. 傳送點：走到南門，伺服器通知切換到 F01
  let transfer: TransferMessage | undefined;
  roomA.onMessage(MSG.transfer, (m: TransferMessage) => (transfer = m));
  roomA.send(MSG.move, { x: 14, y: 28 } satisfies MoveRequest);
  await waitFor(() => transfer !== undefined, 6000);
  check('踩到傳送點後收到切換地圖通知', transfer?.mapId === 'F01');
  await roomA.leave();
  const gone = await waitFor(() => roomB.state.players.get(roomA.sessionId) === undefined, 2000);
  check('離開後其他玩家看不到該角色', gone);
  const stale = await join(a.token, 'C01').then(() => true, () => false);
  check('傳送後不能再回到舊地圖的房間', !stale);
  const roomA2 = await join(a.token, 'F01');
  const pos = roomA2.state.players.get(roomA2.sessionId);
  check(
    '進入新地圖房間並出現在傳送目的地',
    roomA2.state.mapId === 'F01' && pos?.x === 20.5 && pos?.y === 3.5,
    pos ? `(${pos.x}, ${pos.y})` : '沒有角色',
  );

  // 8. 世界頻道跨房間
  chatsB.length = 0;
  await sleep(900);
  roomA2.send(MSG.chat, { channel: 'world', text: '草原這邊風景不錯' } satisfies ChatSendMessage);
  await waitFor(() => chatsB.length > 0, 2000);
  check('世界頻道訊息送達其他地圖的玩家', chatsB[0]?.channel === 'world' && chatsB[0]?.name === a.name);

  // 9. 同帳號重複登入會把舊連線踢掉
  let kickedCode = 0;
  roomB.onLeave((code: number) => (kickedCode = code));
  const b2 = await login(b.name);
  const roomB2 = await join(b2.token, b2.mapId);
  await waitFor(() => kickedCode !== 0, 2000);
  check('同帳號重複登入時舊連線被中斷', kickedCode === CLOSE_CODE.duplicateLogin, `代碼 ${kickedCode}`);

  await roomA2.leave();
  await roomB2.leave();
  console.log(failed === 0 ? '\n全部通過' : `\n有 ${failed} 項失敗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
