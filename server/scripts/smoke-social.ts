// 社交與任務煙霧測試：組隊與經驗分配、公會、好友、任務、首領定時重生。
// 用法：伺服器需以 ENABLE_GM_COMMANDS=true 啟動，再執行 npm run smoke（接在前三個測試之後執行）。
// 環境變數：
//   SERVER_URL          伺服器位址（預設 http://localhost:2567）
//   DATABASE_URL        設定後會直接查資料庫做額外驗證
// 伺服器若以 BOSS_RESPAWN_SCALE=0.006 之類的小倍率啟動，會額外驗證首領重生。

import { Client, type Room } from '@colyseus/sdk';
import pg from 'pg';
import {
  DEFAULT_SERVER_PORT,
  GUILD_CREATE_COST,
  MSG,
  ROOM_MAP,
  type AttackRequest,
  type AuthResponse,
  type ChatChannel,
  type ChatMessage,
  type ChatSendMessage,
  type CreateCharacterResponse,
  type FriendsMessage,
  type GuildMessage,
  type InventoryMessage,
  type JoinMapOptions,
  type MoveRequest,
  type PartyMessage,
  type QuestRequest,
  type QuestsMessage,
  type SelfMessage,
  type SocialInviteMessage,
  type SocialKind,
  type SocialRequest,
  type SystemMessage,
  type TransferMessage,
} from '@starmemory/shared';

const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${DEFAULT_SERVER_PORT}`;
const DATABASE_URL = process.env.DATABASE_URL;

interface PlayerView { name: string; level: number; x: number; y: number; hp: number; guild: string }
interface MonsterView { monsterId: string; x: number; y: number; hp: number }
interface DropView { itemId: string; owner: string }
interface Collection<T> {
  size: number;
  get(key: string): T | undefined;
  forEach(cb: (value: T, key: string) => void): void;
}
interface StateView {
  players: Collection<PlayerView>;
  monsters: Collection<MonsterView>;
  drops: Collection<DropView>;
}

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
  room!: Room<any, StateView>;
  self!: SelfMessage;
  inv!: InventoryMessage;
  party: PartyMessage = { members: [] };
  guild: GuildMessage = { guild: null };
  friends: FriendsMessage = { friends: [] };
  quests: QuestsMessage = { active: [], done: [] };
  invite: SocialInviteMessage | undefined;
  transfer: TransferMessage | undefined;
  readonly chats: ChatMessage[] = [];
  readonly system: string[] = [];
  private lastChatAt = 0;
  private lastActionAt = 0;

  constructor(
    readonly token: string,
    readonly characterId: number,
    readonly name: string,
  ) {}

  async join(mapId: string): Promise<void> {
    const options: JoinMapOptions = { token: this.token, characterId: this.characterId, mapId };
    const room = await new Client(SERVER_URL).joinOrCreate<StateView>(ROOM_MAP, options);
    this.room = room;
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
    room.onMessage(MSG.quests, (m: QuestsMessage) => (this.quests = m));
    room.onMessage(MSG.party, (m: PartyMessage) => (this.party = m));
    room.onMessage(MSG.guild, (m: GuildMessage) => (this.guild = m));
    room.onMessage(MSG.friends, (m: FriendsMessage) => (this.friends = m));
    room.onMessage(MSG.socialInvite, (m: SocialInviteMessage) => (this.invite = m));
    room.onMessage(MSG.transfer, (m: TransferMessage) => (this.transfer = m));
    room.onMessage(MSG.chat, (m: ChatMessage) => this.chats.push(m));
    room.onMessage(MSG.system, (m: SystemMessage) => this.system.push(m.text));
    room.onMessage('*', () => undefined);
    await waitFor(() => room.state?.players?.get(room.sessionId) !== undefined, 3000);
    room.send(MSG.inventory);
    await waitFor(() => ready === 3, 3000);
    await this.social({ action: 'refresh' });
  }

  get id(): string {
    return this.room.sessionId;
  }

  get me(): PlayerView {
    return this.room.state.players.get(this.id)!;
  }

  /** 送出一個動作訊息（遵守伺服器的動作間隔），並等伺服器處理完 */
  async act(type: string, message?: unknown, settleMs = 300): Promise<void> {
    const wait = this.lastActionAt + 130 - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
    this.lastActionAt = Date.now();
    this.room.send(type, message);
    await sleep(settleMs);
  }

  social(request: SocialRequest): Promise<void> {
    return this.act(MSG.social, request);
  }

  quest(request: QuestRequest): Promise<void> {
    return this.act(MSG.quest, request);
  }

  async chat(channel: ChatChannel, text: string): Promise<void> {
    const wait = this.lastChatAt + 900 - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
    this.lastChatAt = Date.now();
    this.room.send(MSG.chat, { channel, text } satisfies ChatSendMessage);
    await sleep(300);
  }

  gm(command: string): Promise<void> {
    return this.chat('map', `/gm ${command}`);
  }

  async walkTo(x: number, y: number, timeoutMs = 15000): Promise<boolean> {
    await sleep(120);
    this.room.send(MSG.move, { x, y } satisfies MoveRequest);
    return waitFor(() => Math.abs(this.me.x - (x + 0.5)) < 0.01 && Math.abs(this.me.y - (y + 0.5)) < 0.01, timeoutMs);
  }

  /** 走進傳送點並進入目標地圖的房間 */
  async travel(portalX: number, portalY: number, mapId: string): Promise<void> {
    await sleep(120);
    this.room.send(MSG.move, { x: portalX, y: portalY } satisfies MoveRequest);
    await waitFor(() => this.transfer?.mapId === mapId, 15000);
    await this.room.leave();
    await this.join(mapId);
  }

  monsters(monsterId: string): Array<MonsterView & { key: string }> {
    const list: Array<MonsterView & { key: string }> = [];
    this.room.state.monsters.forEach((m, key) => {
      if (m.monsterId === monsterId) {
        list.push({ key, monsterId, x: m.x, y: m.y, hp: m.hp });
      }
    });
    const { x, y } = this.me;
    return list.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
  }

  async kill(key: string, timeoutMs = 20000): Promise<boolean> {
    await sleep(130);
    this.room.send(MSG.attack, { targetId: key } satisfies AttackRequest);
    return waitFor(() => this.room.state.monsters.get(key) === undefined, timeoutMs);
  }

  count(itemId: string): number {
    return this.inv.items.filter((i) => i.itemId === itemId).reduce((n, i) => n + i.quantity, 0);
  }

  said(text: string): boolean {
    return this.system.some((t) => t.includes(text));
  }

  progressOf(questId: string): number[] | undefined {
    return this.quests.active.find((q) => q.questId === questId)?.progress;
  }
}

async function createPlayer(tag: string, label: string, suffix: number): Promise<Player> {
  const { token } = await post<AuthResponse>('/api/register', { username: `social_${tag}_${suffix}`, password: 'correct-horse-battery' });
  const name = `${label}${suffix}`;
  const { character } = await post<CreateCharacterResponse>('/api/characters', { name, classId: 'bladeguard' }, token);
  return new Player(token, character.id, name);
}

/** 邀請並等對方收到 */
async function invite(from: Player, to: Player, kind: SocialKind): Promise<void> {
  to.invite = undefined;
  await from.social({ action: 'invite', kind, targetId: to.id });
  await waitFor(() => to.invite !== undefined, 2000);
}

async function main(): Promise<void> {
  const suffix = Math.floor(Math.random() * 900000 + 100000);
  const db = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL }) : null;
  const a = await createPlayer('a', '社甲', suffix);
  const b = await createPlayer('b', '社乙', suffix);
  const c = await createPlayer('c', '社丙', suffix);
  await a.join('C01');
  await b.join('C01');
  await c.join('C01');

  await a.gm('coins 12000');
  if (!a.said('星幣 +12000')) {
    console.log('略過  社交與任務測試（伺服器未開啟 ENABLE_GM_COMMANDS）');
    process.exit(0);
  }

  // ---------------------------------------------------------- 1. 接任務
  await a.quest({ action: 'accept', questId: 'q_first_steps', npcId: 'c01_guide' });
  check('向 NPC 接任務', a.progressOf('q_first_steps')?.join() === '0');
  await a.quest({ action: 'accept', questId: 'q_first_steps', npcId: 'c01_guide' });
  await a.quest({ action: 'accept', questId: 'q_cellar_king', npcId: 'c01_guide' });
  await a.quest({ action: 'accept', questId: 'q_sticky_business', npcId: 'c01_grocer' });
  await a.quest({ action: 'accept', questId: 'q_mushroom_menace', npcId: 'c01_guide' });
  check('不能重複接、等級不足、未完成前置、離 NPC 太遠或找錯 NPC 都接不到', a.quests.active.length === 1, `進行中 ${a.quests.active.length} 個`);

  // ---------------------------------------------------------- 2. 組隊
  await invite(a, b, 'party');
  check('收到組隊邀請', b.invite?.kind === 'party' && b.invite.fromName === a.name);
  await b.social({ action: 'respond', kind: 'party', accept: true });
  check('接受後雙方都看到隊伍名單，邀請者是隊長', a.party.members.length === 2 && b.party.members.length === 2 && b.party.members.find((m) => m.leader)?.name === a.name);
  await invite(b, c, 'party');
  check('只有隊長可以邀請', c.invite === undefined && b.said('只有隊長'));
  await a.chat('party', '隊伍頻道測試');
  check('隊伍頻道只有隊員收得到', b.chats.some((m) => m.channel === 'party' && m.name === a.name) && !c.chats.some((m) => m.channel === 'party'));
  await c.chat('party', '我沒有隊伍');
  check('沒有隊伍時不能在隊伍頻道發言', c.said('沒有隊伍'));

  // ---------------------------------------------------------- 3. 組隊經驗（到嫩芽草原）
  await Promise.all([a.travel(14, 28, 'F01'), b.travel(15, 28, 'F01')]);
  await waitFor(() => a.party.members.filter((m) => m.online && m.mapId === 'F01').length === 2, 3000);
  check('切換地圖後隊伍仍然存在', a.party.members.length === 2 && a.party.members.every((m) => m.online && m.mapId === 'F01'));
  const expA = a.self.exp;
  const expB = b.self.exp;
  await a.kill(a.monsters('bobolu')[0]!.key);
  await sleep(300);
  // 啵啵露經驗 9：兩人隊伍 9 × 1.1 ÷ 2 = 4.95 → 每人 5（單人會是 9）
  check('同地圖的隊員平分經驗（每多 1 人 +10%），沒出手的隊員也分得到', a.self.exp === expA + 5 && b.self.exp === expB + 5, `甲 +${a.self.exp - expA}，乙 +${b.self.exp - expB}`);
  check('參與擊殺的人累計任務進度', a.progressOf('q_first_steps')?.join() === '1');
  await b.social({ action: 'partyLeave' });
  check('隊員離開後剩一人的隊伍自動解散', a.party.members.length === 0 && b.party.members.length === 0);
  const soloExp = a.self.exp;
  await a.kill(a.monsters('bobolu')[0]!.key);
  await sleep(300);
  check('解散後恢復單人經驗', a.self.exp === soloExp + 9, `+${a.self.exp - soloExp}`);

  // ---------------------------------------------------------- 4. 完成擊殺任務並回報
  for (let i = 0; i < 6 && (a.progressOf('q_first_steps')?.[0] ?? 0) < 5; i++) {
    const next = a.monsters('bobolu')[0];
    if (!next) {
      await sleep(1000);
      continue;
    }
    await a.kill(next.key);
    await sleep(200);
  }
  check('擊殺數達標並收到提示', a.progressOf('q_first_steps')?.join() === '5' && a.said('目標已達成'));
  await a.quest({ action: 'complete', questId: 'q_first_steps', npcId: 'c01_guide' });
  check('不在 NPC 旁邊不能回報', a.progressOf('q_first_steps') !== undefined);
  await a.travel(20, 1, 'C01');
  check('任務進度跟著角色存檔（換地圖後仍在）', a.progressOf('q_first_steps')?.join() === '5');
  await a.walkTo(15, 15);
  const before = { exp: a.self.exp, level: a.self.level, coins: a.inv.coins, potions: a.count('potion_hp_s') };
  await a.quest({ action: 'complete', questId: 'q_first_steps', npcId: 'c01_guide' });
  const gainedExp = a.self.level > before.level || a.self.exp === before.exp + 60;
  check('回報任務：獲得經驗、星幣與道具', a.quests.done.includes('q_first_steps') && gainedExp && a.inv.coins === before.coins + 100 && a.count('potion_hp_s') === before.potions + 5, `星幣 +${a.inv.coins - before.coins}，藥水 +${a.count('potion_hp_s') - before.potions}`);
  await a.quest({ action: 'complete', questId: 'q_first_steps', npcId: 'c01_guide' });
  await a.quest({ action: 'accept', questId: 'q_first_steps', npcId: 'c01_guide' });
  check('已完成的任務不能重複回報或重接', a.inv.coins === before.coins + 100 && a.quests.active.length === 0);

  // 收集任務
  await a.walkTo(14, 13);
  await a.quest({ action: 'accept', questId: 'q_sticky_business', npcId: 'c01_grocer' });
  check('完成前置任務後可以接下一個任務', a.progressOf('q_sticky_business') !== undefined);
  const dewBefore = a.count('mat_sticky_dew');
  if (dewBefore > 0) {
    // 先把打怪撿到的清掉，確認「道具不足時不能回報」
    await a.act(MSG.shopSell, { npcId: 'c01_grocer', slot: a.inv.items.find((i) => i.itemId === 'mat_sticky_dew')!.slot, quantity: dewBefore });
  }
  await a.quest({ action: 'complete', questId: 'q_sticky_business', npcId: 'c01_grocer' });
  check('收集的道具不足時不能回報', a.progressOf('q_sticky_business') !== undefined && a.said('還沒完成'));
  await a.gm('item mat_sticky_dew 7');
  await a.quest({ action: 'complete', questId: 'q_sticky_business', npcId: 'c01_grocer' });
  check('回報收集任務：交出道具、領到獎勵裝備', a.quests.done.includes('q_sticky_business') && a.count('mat_sticky_dew') === 2 && a.count('novice_cloth_cap') === 1);

  // 放棄
  await a.gm('level 30');
  await a.walkTo(15, 15);
  await a.quest({ action: 'accept', questId: 'q_cellar_king', npcId: 'c01_guide' });
  const accepted = a.progressOf('q_cellar_king') !== undefined;
  await a.quest({ action: 'abandon', questId: 'q_cellar_king' });
  check('可以放棄進行中的任務', accepted && a.progressOf('q_cellar_king') === undefined);
  await a.quest({ action: 'accept', questId: 'q_cellar_king', npcId: 'c01_guide' });

  // ---------------------------------------------------------- 5. 好友
  await invite(a, c, 'friend');
  await c.social({ action: 'respond', kind: 'friend', accept: true });
  check('互加好友後雙方名單都有對方且顯示在線上', a.friends.friends.some((f) => f.characterId === c.characterId && f.online) && c.friends.friends.some((f) => f.characterId === a.characterId && f.online));
  await c.room.leave();
  await sleep(300);
  await a.social({ action: 'refresh' });
  check('好友離線後顯示為離線', a.friends.friends.find((f) => f.characterId === c.characterId)?.online === false);
  await c.join('C01');
  check('好友關係存在資料庫（重新登入後仍在）', c.friends.friends.some((f) => f.characterId === a.characterId));
  await a.social({ action: 'friendRemove', characterId: c.characterId });
  check('刪除好友後雙方名單都移除', a.friends.friends.length === 0 && c.friends.friends.length === 0);

  // ---------------------------------------------------------- 6. 公會
  const guildName = `星${suffix}`;
  await c.social({ action: 'guildCreate', name: guildName });
  check('星幣不足時不能建立公會', c.guild.guild === null && c.said('建立公會需要'));
  const coinsBefore = a.inv.coins;
  await a.social({ action: 'guildCreate', name: guildName });
  check('建立公會：扣除費用並成為會長', a.guild.guild?.name === guildName && a.guild.guild.members[0]?.leader === true && a.inv.coins === coinsBefore - GUILD_CREATE_COST);
  check('其他玩家看得到公會名稱', c.room.state.players.get(a.id)?.guild === guildName);
  await c.gm('coins 6000');
  const cCoins = c.inv.coins;
  await c.social({ action: 'guildCreate', name: guildName.toUpperCase() });
  check('公會名稱重複時建立失敗且不扣錢', c.guild.guild === null && c.inv.coins === cCoins && c.said('已經有人使用'));
  await invite(a, c, 'guild');
  check('收到公會邀請（含公會名稱）', c.invite?.kind === 'guild' && c.invite.detail === guildName);
  await c.social({ action: 'respond', kind: 'guild', accept: true });
  check('加入後雙方的成員名單更新', a.guild.guild?.members.length === 2 && c.guild.guild?.members.length === 2 && c.me.guild === guildName);
  await c.social({ action: 'guildKick', characterId: a.characterId });
  await c.social({ action: 'guildDisband' });
  check('一般成員不能請離成員或解散公會', a.guild.guild?.members.length === 2 && c.said('只有會長'));
  await a.chat('guild', '公會頻道測試');
  check('公會頻道只有成員收得到', c.chats.some((m) => m.channel === 'guild' && m.name === a.name));
  await a.room.leave();
  await a.join('C01');
  check('公會存在資料庫（重新登入後仍在）', a.guild.guild?.name === guildName && a.me.guild === guildName);
  await a.social({ action: 'guildLeave' });
  check('會長不能直接退出', a.guild.guild !== null && a.said('會長不能直接退出'));
  await a.social({ action: 'guildKick', characterId: c.characterId });
  check('會長請離成員：對方立刻失去公會', c.guild.guild === null && c.me.guild === '' && a.guild.guild?.members.length === 1);
  await a.social({ action: 'guildDisband' });
  check('解散公會', a.guild.guild === null && a.me.guild === '');

  // ---------------------------------------------------------- 7. 首領與定時重生
  await a.walkTo(15, 15);
  await a.travel(21, 20, 'D01');
  const boss = a.monsters('cellarking_gru')[0];
  check('地下城深處有首領', boss !== undefined && a.room.state.monsters.size === 14, `${a.room.state.monsters.size} 隻魔物`);
  if (boss) {
    a.system.length = 0;
    const expBefore = { level: a.self.level, exp: a.self.exp };
    await a.act(MSG.attack, { targetId: boss.key } satisfies AttackRequest);
    await a.gm('slay');
    await waitFor(() => a.room.state.monsters.get(boss.key) === undefined, 3000);
    await sleep(300);
    let tooth = false;
    a.room.state.drops.forEach((d) => {
      tooth = tooth || (d.itemId === 'mat_king_tooth' && d.owner === a.id);
    });
    check('擊倒首領：全伺服器公告、掉落必掉道具、獲得大量經驗', a.said('被擊倒了') && tooth && (a.self.level > expBefore.level || a.self.exp > expBefore.exp));
    check('首領計入任務進度', a.progressOf('q_cellar_king')?.join() === '1');
    await c.social({ action: 'refresh' });
    check('其他地圖的玩家也收到首領公告', c.said('被擊倒了'));

    // 離開讓房間關閉，再進來：首領不應該因為房間重開而立刻出現
    await a.room.leave();
    await sleep(1500);
    await a.join('D01');
    check('房間重開後首領仍在等待重生（計時存在資料庫）', a.monsters('cellarking_gru').length === 0 && a.room.state.monsters.size === 13);
    if (db) {
      const timer = (await db.query(`SELECT respawn_at FROM boss_timers WHERE map_id = 'D01' AND spawn_name = 'gru_lair'`)).rows;
      check('資料庫記錄了首領的重生時間', timer.length === 1);
    }
    a.system.length = 0;
    const respawned = await waitFor(() => a.monsters('cellarking_gru').length === 1, 25000);
    if (respawned) {
      await sleep(300);
      check('重生時間到了首領再次出現並公告', a.said('出現在'));
      if (db) {
        const timer = (await db.query(`SELECT 1 FROM boss_timers WHERE map_id = 'D01' AND spawn_name = 'gru_lair'`)).rows;
        check('首領重生後清除計時', timer.length === 0);
      }
    } else {
      console.log('略過  首領重生（伺服器未設定 BOSS_RESPAWN_SCALE，要等 30 分鐘）');
    }
  }

  // ---------------------------------------------------------- 8. 資料庫紀錄
  await a.room.leave();
  await b.room.leave();
  await c.room.leave();
  await sleep(500);
  if (db) {
    const actions = (await db.query<{ action: string }>('SELECT DISTINCT action FROM item_log WHERE character_id = $1', [a.characterId])).rows.map((r) => r.action);
    check('任務獎勵、任務道具、公會費用都有異動紀錄', ['quest_reward', 'quest_turn_in', 'guild_create'].every((x) => actions.includes(x)));
    const quests = (await db.query<{ quest_id: string; status: string; progress: number[] }>('SELECT quest_id, status, progress FROM character_quests WHERE character_id = $1 ORDER BY quest_id', [a.characterId])).rows;
    check(
      '任務狀態與進度已寫入資料庫',
      quests.filter((q) => q.status === 'done').length === 2 && quests.find((q) => q.quest_id === 'q_cellar_king')?.progress.join() === '1',
      quests.map((q) => `${q.quest_id}:${q.status}`).join('、'),
    );
    const leftovers = (await db.query('SELECT 1 FROM guilds WHERE lower(name) = lower($1)', [guildName])).rows.length;
    check('解散的公會已從資料庫移除', leftovers === 0);
  } else {
    console.log('略過  資料庫檢查（未設定 DATABASE_URL）');
  }

  await db?.end();
  console.log(failed === 0 ? '\n全部通過' : `\n有 ${failed} 項失敗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
