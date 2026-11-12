// 壓力測試：模擬大量玩家同時上線、移動、聊天、打怪，量測伺服器的反應時間與穩定度。
//
// 用法（伺服器要先啟動，並把登入頻率限制調高）：
//   AUTH_RATE_LIMIT=100000 npm run server
//   BOTS=200 DURATION_SEC=120 npm run loadtest
//
// 環境變數：
//   SERVER_URL     伺服器位址（預設 http://localhost:2567）
//   BOTS           模擬玩家數（預設 50）
//   DURATION_SEC   全部上線後持續多久（預設 60）
//   RAMP_SEC       用多久時間讓所有玩家陸續上線（預設 20）
//   FIELD_RATIO    多少比例的玩家去野外打怪，其餘留在城裡走動（預設 0.5）
//   PREFIX         測試帳號的前綴（預設 load）；帳號會重複使用，不會每次都新建
//
// 測試帳號是真的寫進資料庫的帳號，請只對測試環境執行。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client, type Room } from '@colyseus/sdk';
import {
  buildCollisionGrid,
  CLASSES,
  DEFAULT_SERVER_PORT,
  isWalkable,
  MSG,
  ROOM_MAP,
  type AttackRequest,
  type AuthResponse,
  type CharacterListResponse,
  type ChatSendMessage,
  type CollisionGrid,
  type CreateCharacterResponse,
  type JoinMapOptions,
  type MoveRequest,
  type TiledMap,
  type TransferMessage,
} from '@starmemory/shared';

const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${DEFAULT_SERVER_PORT}`;
const BOTS = Number(process.env.BOTS ?? 50);
const DURATION_SEC = Number(process.env.DURATION_SEC ?? 60);
const RAMP_SEC = Number(process.env.RAMP_SEC ?? 20);
const FIELD_RATIO = Number(process.env.FIELD_RATIO ?? 0.5);
const PREFIX = process.env.PREFIX ?? 'load';
const PASSWORD = 'loadtest-password';

interface PlayerView { x: number; y: number; hp: number }
interface MonsterView { x: number; y: number }
interface StateView {
  players: { get(key: string): PlayerView | undefined };
  monsters: { forEach(cb: (m: MonsterView, key: string) => void): void; get(key: string): MonsterView | undefined };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min: number, max: number): number => min + Math.random() * (max - min);

// ------------------------------------------------------------ 量測

const stats = {
  setupMs: [] as number[],
  joinMs: [] as number[],
  /** 送出移動要求到自己的位置開始變化的時間 */
  moveMs: [] as number[],
  /** 相鄰兩次狀態同步的間隔（伺服器每 50 毫秒同步一次） */
  patchGapMs: [] as number[],
  setupFailures: 0,
  joinFailures: 0,
  transfers: 0,
  deaths: 0,
  movesSent: 0,
  attacksSent: 0,
  chatsSent: 0,
  disconnects: new Map<number, number>(),
  errors: new Map<string, number>(),
};

function countError(message: string): void {
  stats.errors.set(message, (stats.errors.get(message) ?? 0) + 1);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function summary(values: number[]): string {
  return values.length === 0
    ? '（沒有資料）'
    : `中位數 ${Math.round(percentile(values, 50))}、95% ${Math.round(percentile(values, 95))}、最大 ${Math.round(values.reduce((m, v) => (v > m ? v : m), 0))} 毫秒（${values.length} 筆）`;
}

// ------------------------------------------------------------ 地圖（讓機器人只點可以走的格子）

const grids = new Map<string, CollisionGrid>();
function gridOf(mapId: string): CollisionGrid | undefined {
  if (grids.size === 0) {
    const dir = fileURLToPath(new URL('../../shared/maps/', import.meta.url));
    for (const [id, file] of [['C01', 'c01_dawnsprout_town.json'], ['F01', 'f01_sprout_meadow.json']] as const) {
      grids.set(id, buildCollisionGrid(JSON.parse(readFileSync(dir + file, 'utf-8')) as TiledMap));
    }
  }
  return grids.get(mapId);
}

// ------------------------------------------------------------ 帳號準備

async function request<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
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

interface Credentials {
  token: string;
  characterId: number;
  mapId: string;
}

/** 登入（沒有帳號就註冊）並確保有一個角色 */
async function prepare(index: number): Promise<Credentials> {
  const username = `${PREFIX}_${String(index).padStart(5, '0')}`;
  let auth = await request<AuthResponse>('POST', '/api/login', { username, password: PASSWORD });
  if (auth.status === 401) {
    auth = await request<AuthResponse>('POST', '/api/register', { username, password: PASSWORD });
  }
  if (auth.status === 429) {
    throw new Error('被登入頻率限制擋下：請用 AUTH_RATE_LIMIT=100000 啟動伺服器');
  }
  if (auth.status !== 200 && auth.status !== 201) {
    throw new Error(`登入失敗（${auth.status}）`);
  }
  const token = auth.body.token;
  const list = await request<CharacterListResponse>('GET', '/api/characters', undefined, token);
  let character = list.body.characters?.[0];
  if (!character) {
    const created = await request<CreateCharacterResponse>(
      'POST',
      '/api/characters',
      { name: `壓測${PREFIX}${index}`, classId: CLASSES[index % CLASSES.length]!.id },
      token,
    );
    if (created.status !== 201) {
      throw new Error(`建立角色失敗（${created.status}）`);
    }
    character = created.body.character;
  }
  return { token, characterId: character.id, mapId: character.mapId };
}

// ------------------------------------------------------------ 機器人

class Bot {
  private room: Room<any, StateView> | null = null;
  private mapId: string;
  private stopped = false;
  private lastPatchAt = 0;
  private moveSentAt = 0;
  private lastPos = '';
  private targetKey = '';
  private switching = false;
  /** 上一輪到現在位置都沒有變（站著不動） */
  private idle = false;
  private posAtLastLoop = '';

  constructor(
    private readonly creds: Credentials,
    /** 是否去野外打怪 */
    private readonly fighter: boolean,
  ) {
    this.mapId = creds.mapId;
  }

  async start(): Promise<void> {
    await this.join(this.mapId);
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    void this.room?.leave().catch(() => undefined);
  }

  private async join(mapId: string): Promise<void> {
    const started = Date.now();
    const options: JoinMapOptions = { token: this.creds.token, characterId: this.creds.characterId, mapId };
    try {
      const room = await new Client(SERVER_URL).joinOrCreate<StateView>(ROOM_MAP, options);
      stats.joinMs.push(Date.now() - started);
      this.room = room;
      this.mapId = mapId;
      this.lastPatchAt = 0;
      this.targetKey = '';
      room.onMessage('*', () => undefined);
      room.onMessage(MSG.transfer, (message: TransferMessage) => void this.switchMap(message.mapId));
      room.onStateChange(() => this.onPatch());
      room.onLeave((code: number) => {
        if (!this.stopped && !this.switching && this.room === room) {
          stats.disconnects.set(code, (stats.disconnects.get(code) ?? 0) + 1);
          this.room = null;
        }
      });
      room.send(MSG.inventory);
    } catch (err) {
      stats.joinFailures++;
      countError(`加入房間：${err instanceof Error ? err.message : String(err)}`);
      this.room = null;
    }
  }

  /** 伺服器通知切換地圖（走進傳送點，或倒地後被送回城） */
  private async switchMap(mapId: string): Promise<void> {
    if (this.switching || this.stopped) {
      return;
    }
    this.switching = true;
    stats.transfers++;
    const old = this.room;
    this.room = null;
    await old?.leave().catch(() => undefined);
    await this.join(mapId);
    this.switching = false;
  }

  private onPatch(): void {
    const now = Date.now();
    if (this.lastPatchAt > 0 && now - this.lastPatchAt < 1000) {
      stats.patchGapMs.push(now - this.lastPatchAt);
    }
    this.lastPatchAt = now;
    const me = this.room?.state?.players?.get(this.room.sessionId);
    if (!me) {
      return;
    }
    const pos = `${me.x},${me.y}`;
    if (this.moveSentAt > 0 && pos !== this.lastPos) {
      stats.moveMs.push(now - this.moveSentAt);
      this.moveSentAt = 0;
    }
    this.lastPos = pos;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      await sleep(rand(1000, 3000));
      const room = this.room;
      const me = room?.state?.players?.get(room.sessionId);
      if (!room || !me || this.switching) {
        // 斷線了：稍等後重新連線（模擬玩家重新整理）
        if (!room && !this.switching && !this.stopped) {
          await sleep(2000);
          await this.join(this.mapId);
        }
        continue;
      }
      // 上一輪送出的移動若到現在都沒有造成位移（例如目標走不到），就不列入統計
      this.moveSentAt = 0;
      const posNow = `${me.x},${me.y}`;
      this.idle = posNow === this.posAtLastLoop;
      this.posAtLastLoop = posNow;
      if (me.hp <= 0) {
        stats.deaths++;
        await sleep(6000); // 等伺服器送回城
        continue;
      }
      try {
        if (Math.random() < 0.03) {
          room.send(MSG.chat, { channel: 'map', text: `壓力測試訊息 ${Math.floor(Math.random() * 1000)}` } satisfies ChatSendMessage);
          stats.chatsSent++;
        }
        if (this.fighter && this.mapId === 'C01') {
          this.move(room, 14 + Math.round(Math.random()), 28); // 走向通往野外的傳送點
        } else if (this.fighter) {
          this.fight(room, me);
        } else {
          this.wander(room, me);
        }
      } catch (err) {
        countError(`操作：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private move(room: Room<any, StateView>, x: number, y: number): void {
    room.send(MSG.move, { x, y } satisfies MoveRequest);
    stats.movesSent++;
    // 只量「原本站著不動、且目標不是腳下這一格」的要求：這種情況下位置一定會變，量到的才是反應時間
    const me = room.state?.players?.get(room.sessionId);
    if (me && this.idle && (Math.floor(me.x) !== x || Math.floor(me.y) !== y)) {
      this.moveSentAt = Date.now();
    }
  }

  /** 在附近隨機挑一個可以走的格子 */
  private wander(room: Room<any, StateView>, me: PlayerView): void {
    const grid = gridOf(this.mapId);
    for (let attempt = 0; attempt < 10; attempt++) {
      const x = Math.floor(me.x + rand(-6, 6));
      const y = Math.floor(me.y + rand(-6, 6));
      // 城裡不要走到傳送點上（南門與地窖入口），留在城裡走動
      const onPortal = this.mapId === 'C01' && (y >= 28 || (x === 21 && y === 20));
      if (grid && isWalkable(grid, x, y) && !onPortal) {
        this.move(room, x, y);
        return;
      }
    }
  }

  /** 攻擊最近的魔物；目標還活著就繼續打 */
  private fight(room: Room<any, StateView>, me: PlayerView): void {
    if (this.targetKey && room.state.monsters?.get(this.targetKey)) {
      return;
    }
    let best = '';
    let bestDist = Infinity;
    room.state.monsters?.forEach((m, key) => {
      const d = Math.hypot(m.x - me.x, m.y - me.y);
      if (d < bestDist) {
        bestDist = d;
        best = key;
      }
    });
    if (best) {
      this.targetKey = best;
      room.send(MSG.attack, { targetId: best } satisfies AttackRequest);
      stats.attacksSent++;
    } else {
      this.wander(room, me);
    }
  }
}

// ------------------------------------------------------------ 主流程

async function main(): Promise<void> {
  console.log(`壓力測試：${BOTS} 個模擬玩家，${RAMP_SEC} 秒內陸續上線，持續 ${DURATION_SEC} 秒，${Math.round(FIELD_RATIO * 100)}% 去野外打怪`);
  console.log(`伺服器：${SERVER_URL}\n`);

  // 1. 準備帳號（一次 8 個同時進行；密碼雜湊很花 CPU，同時太多反而慢）
  const creds: Array<Credentials | null> = new Array(BOTS).fill(null);
  let next = 0;
  const setupStarted = Date.now();
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < BOTS) {
        const index = next++;
        const started = Date.now();
        try {
          creds[index] = await prepare(index);
          stats.setupMs.push(Date.now() - started);
        } catch (err) {
          stats.setupFailures++;
          countError(`準備帳號：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }),
  );
  console.log(`帳號準備完成：成功 ${BOTS - stats.setupFailures}、失敗 ${stats.setupFailures}，耗時 ${((Date.now() - setupStarted) / 1000).toFixed(1)} 秒`);

  // 2. 監控：伺服器的事件迴圈延遲與線上人數、壓測程式自己的延遲
  const server = { maxLag: 0, lagSamples: [] as number[], peakOnline: 0, healthFailures: 0 };
  let ownMaxLag = 0;
  let expected = Date.now() + 100;
  const ownTimer = setInterval(() => {
    ownMaxLag = Math.max(ownMaxLag, Date.now() - expected);
    expected = Date.now() + 100;
  }, 100);
  const healthTimer = setInterval(() => {
    void request<{ online: number; loopLag: { avgMs: number; maxMs: number } }>('GET', '/api/health').then(
      (res) => {
        if (res.status !== 200) {
          server.healthFailures++;
          return;
        }
        server.maxLag = Math.max(server.maxLag, res.body.loopLag.maxMs);
        server.lagSamples.push(res.body.loopLag.avgMs);
        server.peakOnline = Math.max(server.peakOnline, res.body.online);
      },
      () => server.healthFailures++,
    );
  }, 2000);

  // 3. 陸續上線
  const bots: Bot[] = [];
  const valid = creds.filter((c): c is Credentials => c !== null);
  const gap = (RAMP_SEC * 1000) / Math.max(1, valid.length);
  for (const [index, c] of valid.entries()) {
    const bot = new Bot(c, index < valid.length * FIELD_RATIO);
    bots.push(bot);
    void bot.start();
    await sleep(gap);
  }
  console.log(`全部上線，開始持續 ${DURATION_SEC} 秒…`);
  for (let elapsed = 0; elapsed < DURATION_SEC; elapsed += 10) {
    await sleep(Math.min(10, DURATION_SEC - elapsed) * 1000);
    console.log(`  ${Math.min(elapsed + 10, DURATION_SEC)} 秒：線上 ${server.peakOnline}（峰值）、伺服器延遲最大 ${server.maxLag} 毫秒、斷線 ${[...stats.disconnects.values()].reduce((a, b) => a + b, 0)} 次`);
  }

  // 4. 結束並輸出報告
  clearInterval(healthTimer);
  clearInterval(ownTimer);
  for (const bot of bots) {
    bot.stop();
  }
  await sleep(1500);

  const disconnects = [...stats.disconnects].map(([code, n]) => `代碼 ${code}：${n} 次`).join('、') || '無';
  const avgLag = server.lagSamples.length > 0 ? server.lagSamples.reduce((a, b) => a + b, 0) / server.lagSamples.length : 0;
  console.log('\n================ 結果 ================');
  console.log(`模擬玩家            ${valid.length}（線上峰值 ${server.peakOnline}）`);
  console.log(`登入＋取得角色      ${summary(stats.setupMs)}`);
  console.log(`加入房間            ${summary(stats.joinMs)}；失敗 ${stats.joinFailures} 次`);
  console.log(`移動反應時間        ${summary(stats.moveMs)}`);
  console.log(`狀態同步間隔        ${summary(stats.patchGapMs)}`);
  console.log(`伺服器事件迴圈延遲  平均 ${avgLag.toFixed(1)}、最大 ${server.maxLag} 毫秒；健康檢查失敗 ${server.healthFailures} 次`);
  console.log(`送出的操作          移動 ${stats.movesSent}、攻擊 ${stats.attacksSent}、聊天 ${stats.chatsSent}；切換地圖 ${stats.transfers}、倒地 ${stats.deaths}`);
  console.log(`非預期斷線          ${disconnects}`);
  console.log(`壓測程式自身延遲    最大 ${ownMaxLag} 毫秒${ownMaxLag > 200 ? '（偏高：壓測這台機器本身可能是瓶頸，數字僅供參考）' : ''}`);
  if (stats.errors.size > 0) {
    console.log('錯誤：');
    for (const [message, n] of stats.errors) {
      console.log(`  ${n} 次  ${message}`);
    }
  }

  // 判定：這些門檻是「玩家不會感覺到卡」的經驗值，可依實際需求調整
  const problems: string[] = [];
  if (stats.setupFailures + stats.joinFailures > valid.length * 0.01) problems.push('登入或加入房間的失敗率超過 1%');
  if (percentile(stats.moveMs, 95) > 250) problems.push('移動反應時間的 95% 超過 250 毫秒');
  if (percentile(stats.patchGapMs, 95) > 150) problems.push('狀態同步間隔的 95% 超過 150 毫秒');
  if (server.maxLag > 200) problems.push('伺服器事件迴圈延遲超過 200 毫秒');
  if ([...stats.disconnects.values()].reduce((a, b) => a + b, 0) > 0) problems.push('有非預期的斷線');
  console.log(problems.length === 0 ? '\n判定：通過' : `\n判定：未通過\n  - ${problems.join('\n  - ')}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
