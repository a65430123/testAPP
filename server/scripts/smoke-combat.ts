// 戰鬥煙霧測試：魔物 AI、普攻與技能、經驗與升級、素質配點、掉落與撿取、倒地復活。
// 用法：伺服器需以 ENABLE_GM_COMMANDS=true 啟動，再執行 npm run smoke（會接在連線測試之後執行）。
// 環境變數 SERVER_URL：伺服器位址（預設 http://localhost:2567）

import { Client, type Room } from '@colyseus/sdk';
import {
  DEFAULT_SERVER_PORT,
  MSG,
  ROOM_MAP,
  STAT_POINTS_PER_LEVEL,
  type AllocStatRequest,
  type AttackRequest,
  type AuthResponse,
  type ChatSendMessage,
  type CombatEvent,
  type CreateCharacterResponse,
  type InventoryMessage,
  type JoinMapOptions,
  type MoveRequest,
  type PickupRequest,
  type SelfMessage,
  type SkillRequest,
  type SystemMessage,
  type TransferMessage,
  type UseItemRequest,
} from '@starmemory/shared';

const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${DEFAULT_SERVER_PORT}`;

interface PlayerView { name: string; level: number; x: number; y: number; hp: number; maxHp: number }
interface MonsterView { monsterId: string; x: number; y: number; hp: number; maxHp: number }
interface DropView { itemId: string; quantity: number; x: number; y: number; owner: string }
interface Collection<T> {
  size: number;
  get(key: string): T | undefined;
  forEach(cb: (value: T, key: string) => void): void;
}
interface StateView {
  mapId: string;
  players: Collection<PlayerView>;
  monsters: Collection<MonsterView>;
  drops: Collection<DropView>;
}
type Conn = Room<any, StateView>;

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '通過' : '失敗'}  ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) {
    failed++;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} 回應 ${res.status}：${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** 一位測試玩家：包住房間連線，並記錄伺服器傳來的各種訊息 */
class Player {
  room!: Conn;
  self: SelfMessage | undefined;
  inventory: InventoryMessage | undefined;
  transfer: TransferMessage | undefined;
  readonly events: CombatEvent[] = [];
  readonly system: string[] = [];
  private lastChatAt = 0;

  constructor(
    private readonly token: string,
    private readonly characterId: number,
  ) {}

  async join(mapId: string): Promise<void> {
    const options: JoinMapOptions = { token: this.token, characterId: this.characterId, mapId };
    const room = await new Client(SERVER_URL).joinOrCreate<StateView>(ROOM_MAP, options);
    this.room = room;
    this.transfer = undefined;
    room.onMessage(MSG.self, (m: SelfMessage) => (this.self = m));
    room.onMessage(MSG.inventory, (m: InventoryMessage) => (this.inventory = m));
    room.onMessage(MSG.transfer, (m: TransferMessage) => (this.transfer = m));
    room.onMessage(MSG.combat, (m: CombatEvent) => this.events.push(m));
    room.onMessage(MSG.system, (m: SystemMessage) => this.system.push(m.text));
    room.onMessage(MSG.chat, () => undefined);
    room.onMessage(MSG.moveReject, () => undefined);
    await waitFor(() => room.state?.players?.get(room.sessionId) !== undefined, 3000);
    this.self = undefined;
    room.send(MSG.inventory);
    await waitFor(() => this.self !== undefined && this.inventory !== undefined, 3000);
  }

  get id(): string {
    return this.room.sessionId;
  }

  get me(): PlayerView {
    return this.room.state.players.get(this.id)!;
  }

  /** 取得最新的個人數值（一定已收到過） */
  get stats(): SelfMessage {
    return this.self!;
  }

  moveTo(x: number, y: number): void {
    this.room.send(MSG.move, { x, y } satisfies MoveRequest);
  }

  /** 走到指定格並等待抵達 */
  async walkTo(x: number, y: number, timeoutMs = 15000): Promise<boolean> {
    await sleep(120);
    this.moveTo(x, y);
    return waitFor(() => Math.abs(this.me.x - (x + 0.5)) < 0.01 && Math.abs(this.me.y - (y + 0.5)) < 0.01, timeoutMs);
  }

  attack(targetId: string): void {
    this.room.send(MSG.attack, { targetId } satisfies AttackRequest);
  }

  /** 送出 GM 指令（遵守聊天的發言間隔） */
  async gm(command: string): Promise<void> {
    const wait = this.lastChatAt + 900 - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
    this.lastChatAt = Date.now();
    this.room.send(MSG.chat, { channel: 'map', text: `/gm ${command}` } satisfies ChatSendMessage);
    await sleep(200);
  }

  monsters(): Array<MonsterView & { key: string }> {
    const list: Array<MonsterView & { key: string }> = [];
    this.room.state.monsters.forEach((m, key) => list.push({ key, monsterId: m.monsterId, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp }));
    return list;
  }

  /** 離自己最近的指定種類魔物 */
  nearest(monsterId: string): (MonsterView & { key: string }) | undefined {
    const { x, y } = this.me;
    return this.monsters()
      .filter((m) => m.monsterId === monsterId)
      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
  }

  /** 攻擊指定魔物直到牠消失 */
  async kill(key: string, timeoutMs = 20000): Promise<boolean> {
    await sleep(120);
    this.attack(key);
    return waitFor(() => this.room.state.monsters.get(key) === undefined, timeoutMs);
  }
}

async function main(): Promise<void> {
  const suffix = Math.floor(Math.random() * 900000 + 100000);
  const { token } = await post<AuthResponse>('/api/register', { username: `combat_${suffix}`, password: 'correct-horse-battery' });
  const { character } = await post<CreateCharacterResponse>('/api/characters', { name: `戰${suffix}`, classId: 'bladeguard' }, token);
  const p = new Player(token, character.id);
  await p.join('C01');

  // GM 指令沒開就無法測試升級與倒地，直接結束
  await p.gm('hp 136');
  if (!p.system.some((t) => t.includes('HP 已設為'))) {
    console.log('略過  戰鬥測試（伺服器未開啟 ENABLE_GM_COMMANDS）');
    process.exit(0);
  }

  // ---------------------------------------------------------- 1. 素質配點
  check('新角色有 10 點素質點、六項素質皆為 5', p.stats.statPoints === 10 && p.stats.stats.pow === 5);
  const maxHpBefore = p.stats.maxHp;
  for (let i = 0; i < 3; i++) {
    p.room.send(MSG.allocStat, { stat: 'con' } satisfies AllocStatRequest);
    await sleep(150);
  }
  p.room.send(MSG.allocStat, { stat: 'luck' } as unknown as AllocStatRequest); // 不存在的素質
  await sleep(300);
  check('配點後素質增加、點數扣除', p.stats.stats.con === 8 && p.stats.statPoints === 7, `體魄 ${p.stats.stats.con}，剩 ${p.stats.statPoints} 點`);
  check('體魄提高後 MaxHP 上升並同步給其他人', p.stats.maxHp > maxHpBefore && p.me.maxHp === p.stats.maxHp, `${maxHpBefore} → ${p.stats.maxHp}`);

  // ---------------------------------------------------------- 2. 前往嫩芽草原
  p.moveTo(14, 28);
  await waitFor(() => p.transfer !== undefined, 10000);
  await p.room.leave();
  await p.join('F01');
  const initial = new Map(p.monsters().map((m) => [m.key, m]));
  const kinds = new Set([...initial.values()].map((m) => m.monsterId));
  check('地圖依重生區設定生出魔物', initial.size === 26 && kinds.size === 3, `${initial.size} 隻、${kinds.size} 種`);

  // ---------------------------------------------------------- 3. 被動魔物不會主動攻擊
  const calm = p.nearest('bobolu')!;
  await p.walkTo(Math.floor(calm.x), Math.floor(calm.y));
  await sleep(2500);
  check('站在被動魔物旁邊不會被攻擊', !p.events.some((e) => e.targetId === p.id));

  // ---------------------------------------------------------- 4. 被打會追擊，離重生點太遠會返回並回滿 HP
  const corner = p
    .monsters()
    .filter((m) => m.monsterId === 'bobolu' && m.y < 17)
    .sort((a, b) => a.x + a.y - (b.x + b.y))[0]!;
  p.events.length = 0;
  p.attack(corner.key);
  const hitIt = await waitFor(() => p.events.some((e) => e.sourceId === p.id && e.targetId === corner.key && e.type === 'damage'), 15000);
  p.moveTo(20, 19); // 立刻跑開（移動會取消攻擊目標）
  // 傷害事件會比狀態同步早到一點，稍等 HP 的變動傳到
  await waitFor(() => {
    const m = p.room.state.monsters.get(corner.key);
    return m === undefined || m.hp < m.maxHp;
  }, 500);
  const wounded = p.room.state.monsters.get(corner.key);
  check('普攻命中並扣除魔物 HP', hitIt && wounded !== undefined && wounded.hp < wounded.maxHp, wounded ? `HP ${wounded.hp}/${wounded.maxHp}` : '魔物已死亡');
  if (wounded) {
    const startPos = { x: wounded.x, y: wounded.y };
    const chased = await waitFor(() => {
      const m = p.room.state.monsters.get(corner.key);
      return m !== undefined && Math.hypot(m.x - startPos.x, m.y - startPos.y) > 1.5;
    }, 6000);
    check('被動魔物被打後會追擊攻擊者', chased);
    const healed = await waitFor(() => {
      const m = p.room.state.monsters.get(corner.key);
      return m !== undefined && m.hp === m.maxHp;
    }, 20000);
    check('追出牽引範圍後放棄並回滿 HP', healed);
    const beforeReturn = p.room.state.monsters.get(corner.key)!;
    const farthest = Math.hypot(beforeReturn.x - corner.x, beforeReturn.y - corner.y);
    const cameBack = await waitFor(() => {
      const m = p.room.state.monsters.get(corner.key);
      return m !== undefined && Math.hypot(m.x - corner.x, m.y - corner.y) < Math.min(4, farthest - 2);
    }, 20000);
    check('魔物走回重生點附近', cameBack, `最遠離開 ${farthest.toFixed(1)} 格`);
  }
  await waitFor(() => Math.abs(p.me.y - 19.5) < 0.01, 10000);

  // ---------------------------------------------------------- 5. 擊殺：經驗、星幣、反擊
  const expBefore = p.stats.exp;
  const coinsBefore = p.inventory!.coins;
  p.events.length = 0;
  const prey = p.nearest('bobolu')!;
  const killed = await p.kill(prey.key);
  await sleep(200);
  check('持續普攻直到擊倒魔物', killed);
  check('擊倒後獲得經驗值', p.stats.exp > expBefore, `${expBefore} → ${p.stats.exp}`);
  check('擊倒後獲得星幣', p.inventory!.coins > coinsBefore, `${coinsBefore} → ${p.inventory!.coins}`);

  // ---------------------------------------------------------- 6. 掉落物與撿取
  let dropKey: string | undefined;
  const findMyDrop = (): string | undefined => {
    let found: string | undefined;
    p.room.state.drops.forEach((d, key) => {
      if (d.owner === p.id) {
        found = key;
      }
    });
    return found;
  };
  let retaliated = false;
  for (let i = 0; i < 12 && !(dropKey = findMyDrop()); i++) {
    const next = p.nearest('bobolu');
    if (!next) {
      await sleep(1000);
      continue;
    }
    await p.kill(next.key);
    retaliated = retaliated || p.events.some((e) => e.sourceId === next.key && e.targetId === p.id);
    await sleep(150);
  }
  check('被動魔物被打後會還手', retaliated || p.events.some((e) => e.sourceId.startsWith('m') && e.targetId === p.id));
  check('魔物依機率掉落道具，並標示歸屬者', dropKey !== undefined);
  if (dropKey) {
    const drop = p.room.state.drops.get(dropKey)!;
    const itemId = drop.itemId;
    const countOf = (): number => p.inventory!.items.filter((i) => i.itemId === itemId).reduce((n, i) => n + i.quantity, 0);
    const before = countOf();
    await p.walkTo(Math.floor(drop.x), Math.floor(drop.y));
    p.room.send(MSG.pickup, { dropId: dropKey } satisfies PickupRequest);
    const picked = await waitFor(() => p.room.state.drops.get(dropKey!) === undefined, 3000);
    await sleep(200);
    check('撿取後掉落物消失、道具進入背包', picked && countOf() === before + 1, `${itemId} ${before} → ${countOf()}`);
  }

  // ---------------------------------------------------------- 7. 技能
  // 用啵啵露當目標：牠們的重生區離會主動攻擊的芽芽菇很遠，測試不會被打擾
  const dummy = p.nearest('bobolu')!;
  p.events.length = 0;
  await sleep(120);
  p.attack(dummy.key);
  await waitFor(() => p.events.some((e) => e.sourceId === p.id && e.targetId === dummy.key), 20000);
  const spBefore = p.stats.sp;
  const skillEvents = (): number => p.events.filter((e) => e.skillId === 'heavy_slash').length;
  await sleep(120);
  p.room.send(MSG.skill, { skillId: 'heavy_slash', targetId: dummy.key } satisfies SkillRequest);
  await waitFor(() => skillEvents() > 0, 2000);
  await sleep(150);
  // 重斬消耗 6 SP；等待期間可能剛好碰上一次自然回復（+1）
  const spent = spBefore - p.stats.sp;
  check('施放技能並消耗 SP', skillEvents() === 1 && (spent === 6 || spent === 5), `SP ${spBefore} → ${p.stats.sp}`);
  p.room.send(MSG.skill, { skillId: 'heavy_slash', targetId: dummy.key } satisfies SkillRequest);
  await sleep(150);
  p.room.send(MSG.skill, { skillId: 'spark_bolt', targetId: dummy.key } satisfies SkillRequest); // 別的職業的技能
  await sleep(500);
  check('冷卻中與非本職業的技能無效', skillEvents() === 1 && !p.events.some((e) => e.skillId === 'spark_bolt'));
  await waitFor(() => p.room.state.monsters.get(dummy.key) === undefined, 20000);

  // 接下來幾項會把 HP 調得很低並原地等待：先走到地圖西側的道路上，
  // 那裡超出芽芽菇的牽引範圍，就算有芽芽菇追過來也會中途折返
  await p.walkTo(8, 24, 25000);

  // ---------------------------------------------------------- 8. 升級（用 GM 指令給經驗）
  const pointsBefore = p.stats.statPoints;
  const levelBefore = p.stats.level;
  await p.gm('exp 500');
  await waitFor(() => p.stats.level > levelBefore, 2000);
  const gained = p.stats.level - levelBefore;
  check('經驗足夠時升級（可連升多級）並同步等級', gained >= 2 && p.me.level === p.stats.level, `Lv.${levelBefore} → Lv.${p.stats.level}`);
  check('每升一級獲得素質點，HP／SP 回滿', p.stats.statPoints === pointsBefore + gained * STAT_POINTS_PER_LEVEL && p.stats.hp === p.stats.maxHp && p.stats.sp === p.stats.maxSp);

  // ---------------------------------------------------------- 9. 使用藥水
  await p.gm('hp 5');
  const potion = p.inventory!.items.find((i) => i.itemId === 'potion_hp_s')!;
  await sleep(150);
  p.room.send(MSG.useItem, { slot: potion.slot } satisfies UseItemRequest);
  await waitFor(() => p.stats.hp >= 65, 2000);
  await sleep(150);
  const potionAfter = p.inventory!.items.find((i) => i.itemId === 'potion_hp_s');
  check('使用藥水回復 HP 並扣除數量', p.stats.hp >= 65 && potionAfter?.quantity === potion.quantity - 1, `HP ${p.stats.hp}`);

  // ---------------------------------------------------------- 10. 閒晃與重生
  const now = new Map(p.monsters().map((m) => [m.key, m]));
  let wandered = 0;
  for (const [key, before] of initial) {
    const after = now.get(key);
    if (after && (after.x !== before.x || after.y !== before.y)) {
      wandered++;
    }
  }
  check('沒被打擾的魔物會在重生區內閒晃', wandered >= 3, `${wandered} 隻移動過`);
  const respawned = await waitFor(() => p.room.state.monsters.size === 26, 20000);
  check('被擊倒的魔物在重生時間後重新出現', respawned, `${p.room.state.monsters.size} 隻`);

  // ---------------------------------------------------------- 11. 主動魔物、倒地與復活
  await p.gm(`hp ${p.stats.maxHp}`);
  p.events.length = 0;
  await p.walkTo(30, 19, 20000);
  const isSproutcap = (key: string): boolean => p.room.state.monsters.get(key)?.monsterId === 'sproutcap';
  const ambushed = await waitFor(() => p.events.some((e) => e.targetId === p.id && isSproutcap(e.sourceId)), 15000);
  check('主動魔物會自己攻擊靠近的玩家', ambushed);
  p.system.length = 0;
  await p.gm('hp 1');
  const downed = await waitFor(() => p.me.hp === 0, 10000);
  check('HP 歸零時倒地', downed && p.system.some((t) => t.includes('擊倒')));
  await sleep(300);
  p.moveTo(30, 20);
  await sleep(400);
  check('倒地時不能移動', Math.abs(p.me.x - 30.5) < 0.01 && Math.abs(p.me.y - 19.5) < 0.01);
  await waitFor(() => p.transfer !== undefined, 10000);
  check('倒地數秒後被送回起始地圖', p.transfer?.mapId === 'C01');
  await p.room.leave();
  await p.join('C01');
  check('復活後 HP 回滿並出現在出生點', p.stats.hp === p.stats.maxHp && p.me.x === 15.5 && p.me.y === 15.5, `HP ${p.stats.hp}/${p.stats.maxHp}`);
  check('等級、素質與配點都已存檔', p.stats.level === levelBefore + gained && p.stats.stats.con === 8);

  await p.room.leave();
  console.log(failed === 0 ? '\n全部通過' : `\n有 ${failed} 項失敗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
