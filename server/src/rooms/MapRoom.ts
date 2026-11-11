// 地圖房間：一張地圖一個房間。移動、戰鬥、掉落、聊天、傳送、存檔都在這裡由伺服器處理。

import { Room, ServerError, type Client } from 'colyseus';
import {
  addItemToInventory,
  advanceMove,
  allocateStat,
  applyExp,
  AUTOSAVE_INTERVAL_MS,
  CHAT_MIN_INTERVAL_MS,
  CLOSE_CODE,
  computePlayerCombatStats,
  createMoveState,
  currentTile,
  DEATH_EXP_PENALTY,
  DEATH_PENALTY_MIN_LEVEL,
  DROP_LIFETIME_MS,
  DROP_OWNER_MS,
  expLevelModifier,
  expToNext,
  findPath,
  getClassDef,
  getItemDef,
  getSkillDef,
  inBounds,
  isStatKey,
  isWalkable,
  MAX_LEVEL,
  MOVE_MIN_INTERVAL_MS,
  MSG,
  PICKUP_RANGE,
  PLAYER_MOVE_SPEED,
  portalAt,
  REGEN_INTERVAL_MS,
  removeFromSlot,
  REVIVE_DELAY_MS,
  rollAttack,
  ROOM_MAX_CLIENTS,
  sanitizeChatText,
  SERVER_TICK_MS,
  START_MAP_ID,
  STAT_POINTS_PER_LEVEL,
  type AttackOptions,
  type ChatChannel,
  type ChatMessage,
  type ClassDef,
  type CombatEvent,
  type InventoryMessage,
  type JoinMapOptions,
  type MoveRejectMessage,
  type MoveState,
  type PlayerCombatStats,
  type Point,
  type SelfMessage,
  type SystemMessage,
  type TransferMessage,
} from '@starmemory/shared';
import { verifyToken } from '../auth';
import { config } from '../config';
import { loadCharacter, saveCharacter, type CharacterRecord } from '../db/characters';
import { MonsterManager, type AiTarget, type Monster, type MonsterHost } from '../game/MonsterManager';
import { getMap, type GameMap } from '../maps';
import { clearOnline, getOnline, setOnline, type OnlineEntry } from '../online';
import { DropState, MapState, PlayerState } from './schema';

/** 世界頻道在各房間之間轉送用的主題名稱 */
const WORLD_CHAT_TOPIC = 'chat:world';
/** 送出切換地圖通知後，用戶端最多有多久時間離開房間（毫秒） */
const TRANSFER_TIMEOUT_MS = 5000;
/** 同一玩家要求背包內容的最短間隔（毫秒） */
const INVENTORY_REQUEST_MIN_INTERVAL_MS = 1000;
/** 技能、撿取、使用道具、配點等動作的最短間隔（毫秒） */
const ACTION_MIN_INTERVAL_MS = 100;
/** 追擊攻擊目標時多久重新尋路一次（毫秒） */
const CHASE_REPATH_MS = 300;
/** 踢掉舊連線時，最多等它的離線存檔多久（毫秒） */
const KICK_WAIT_MS = 5000;

/** 每位玩家只存在伺服器、不同步給用戶端的資料 */
interface PlayerRuntime {
  /** 角色資料（記憶體中的最新狀態，存檔時寫回資料庫） */
  record: CharacterRecord;
  client: Client;
  state: PlayerState;
  move: MoveState;
  cls: ClassDef;
  /** 由等級與素質算出的戰鬥數值；升級或配點後重新計算 */
  combat: PlayerCombatStats;
  /** 目前鎖定的攻擊目標（魔物的鍵） */
  targetKey: string | null;
  nextAttackAt: number;
  nextChaseRepathAt: number;
  /** 各技能可再次使用的時間 */
  cooldowns: Map<string, number>;
  dead: boolean;
  reviveAt: number;
  nextRegenAt: number;
  lastMoveAt: number;
  lastChatAt: number;
  lastActionAt: number;
  lastInventoryRequestAt: number;
  /** 位置、等級等資料自上次存檔後有變動 */
  dirty: boolean;
  /** 背包自上次存檔後有變動 */
  inventoryDirty: boolean;
  /** 個人數值有變動，這個 tick 結束時要傳給本人 */
  selfDirty: boolean;
  /** 已踩到傳送點、正在等用戶端換房間 */
  transferring: boolean;
  /** 傳送時已經存過檔，離開房間時不必再存 */
  savedForTransfer: boolean;
  online: OnlineEntry;
  /** 離線存檔完成時呼叫，讓等待中的新連線繼續 */
  resolveLeft: () => void;
}

/** 地上掉落物只存在伺服器的資料 */
interface DropRuntime {
  ownerUntil: number;
  expireAt: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export class MapRoom extends Room<{ state: MapState }> implements MonsterHost {
  override maxClients = ROOM_MAX_CLIENTS;
  override patchRate = SERVER_TICK_MS;
  override state = new MapState();

  map!: GameMap;
  private monsters!: MonsterManager;
  private readonly runtimes = new Map<string, PlayerRuntime>();
  private readonly drops = new Map<string, DropRuntime>();
  private nextDropId = 1;
  private readonly onWorldChat = (message: ChatMessage): void => {
    this.broadcast(MSG.chat, message);
  };

  override async onCreate(options: { mapId?: string }): Promise<void> {
    const map = typeof options.mapId === 'string' ? getMap(options.mapId) : undefined;
    if (!map) {
      throw new ServerError(400, `不存在的地圖：${String(options.mapId)}`);
    }
    this.map = map;
    this.state.mapId = map.id;
    this.monsters = new MonsterManager(this);
    this.monsters.spawnAll(Date.now());

    this.onMessage(MSG.move, (client, message: unknown) => this.handleMove(client, message));
    this.onMessage(MSG.attack, (client, message: unknown) => this.handleAttack(client, message));
    this.onMessage(MSG.skill, (client, message: unknown) => this.handleSkill(client, message));
    this.onMessage(MSG.pickup, (client, message: unknown) => this.handlePickup(client, message));
    this.onMessage(MSG.useItem, (client, message: unknown) => this.handleUseItem(client, message));
    this.onMessage(MSG.allocStat, (client, message: unknown) => this.handleAllocStat(client, message));
    this.onMessage(MSG.chat, (client, message: unknown) => this.handleChat(client, message));
    this.onMessage(MSG.inventory, (client) => this.handleInventoryRequest(client));
    this.setSimulationInterval((deltaMs) => this.tick(deltaMs), SERVER_TICK_MS);
    this.clock.setInterval(() => this.autosave(), AUTOSAVE_INTERVAL_MS);
    await this.presence.subscribe(WORLD_CHAT_TOPIC, this.onWorldChat);
  }

  /**
   * 驗證 JWT、從資料庫載入角色，並確認：角色屬於這個帳號、角色真的位於這張地圖。
   * 用戶端不能自己決定要進哪張地圖或使用別人的角色。
   */
  override async onAuth(_client: Client, options: Partial<JoinMapOptions>): Promise<CharacterRecord> {
    const identity = verifyToken(options?.token);
    if (!identity) {
      throw new ServerError(401, '登入已失效，請重新登入');
    }
    const characterId = options?.characterId;
    if (typeof characterId !== 'number' || !Number.isInteger(characterId)) {
      throw new ServerError(400, '未指定角色');
    }

    // 同一帳號已有角色在線上：先踢掉舊連線並等它存檔完成，才不會讀到舊資料
    const existing = getOnline(identity.accountId);
    if (existing) {
      await existing.kick();
    }

    const record = await loadCharacter(characterId);
    if (!record || record.accountId !== identity.accountId) {
      throw new ServerError(403, '角色不存在');
    }
    if (record.mapId !== this.map.id) {
      throw new ServerError(403, '角色不在這張地圖');
    }
    if (!getClassDef(record.classId)) {
      throw new ServerError(500, '角色的職業資料不存在');
    }
    return record;
  }

  override onJoin(client: Client, _options: unknown, record: CharacterRecord): void {
    // 兩條連線幾乎同時通過驗證的情況：只讓第一條進來
    if (getOnline(record.accountId)) {
      throw new ServerError(409, '此帳號已有角色在線上');
    }
    const cls = getClassDef(record.classId)!;
    const combat = computePlayerCombatStats(cls, record.level, record.stats);

    // 存檔位置若已不可站立（例如地圖改版），退回預設出生點
    let dirty = false;
    if (!isWalkable(this.map.grid, Math.floor(record.x), Math.floor(record.y))) {
      record.x = this.map.spawn.x;
      record.y = this.map.spawn.y;
      dirty = true;
    }
    // 存檔時是倒地狀態（例如倒地後伺服器異常終止）或數值超出上限：修正
    if (record.hp <= 0 || record.hp > combat.maxHp) {
      record.hp = combat.maxHp;
      dirty = true;
    }
    if (record.sp > combat.maxSp) {
      record.sp = combat.maxSp;
      dirty = true;
    }

    const state = new PlayerState();
    state.name = record.name;
    state.classId = record.classId;
    state.level = record.level;
    state.x = record.x;
    state.y = record.y;
    state.hp = record.hp;
    state.maxHp = combat.maxHp;
    this.state.players.set(client.sessionId, state);

    let resolveLeft: () => void = () => undefined;
    const left = new Promise<void>((resolve) => {
      resolveLeft = resolve;
    });
    const online: OnlineEntry = {
      characterId: record.id,
      kick: () => {
        client.leave(CLOSE_CODE.duplicateLogin);
        // 等離線存檔完成；萬一卡住，逾時後仍放行
        return Promise.race([left, new Promise<void>((resolve) => setTimeout(resolve, KICK_WAIT_MS))]);
      },
    };
    setOnline(record.accountId, online);

    this.runtimes.set(client.sessionId, {
      record,
      client,
      state,
      move: createMoveState(record.x, record.y),
      cls,
      combat,
      targetKey: null,
      nextAttackAt: 0,
      nextChaseRepathAt: 0,
      cooldowns: new Map(),
      dead: false,
      reviveAt: 0,
      nextRegenAt: Date.now() + REGEN_INTERVAL_MS,
      lastMoveAt: 0,
      lastChatAt: 0,
      lastActionAt: 0,
      lastInventoryRequestAt: 0,
      dirty,
      inventoryDirty: false,
      selfDirty: false,
      transferring: false,
      savedForTransfer: false,
      online,
      resolveLeft,
    });

    this.sendSystem(`${record.name} 來到了${this.map.displayName}`, client);
  }

  /** 離線存檔：玩家離開房間（關閉網頁、斷線、被踢、伺服器關機）時立即寫入資料庫 */
  override async onLeave(client: Client): Promise<void> {
    const runtime = this.runtimes.get(client.sessionId);
    if (!runtime) {
      return;
    }
    this.runtimes.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.monsters.forgetTarget(client.sessionId);
    try {
      if (!runtime.savedForTransfer) {
        // 倒地時離線：直接以復活後的狀態存檔，下次上線不會卡在倒地
        if (runtime.dead) {
          this.applyReviveToRecord(runtime);
        }
        await saveCharacter(runtime.record, true);
      }
    } catch (err) {
      console.error(`[room ${this.map.id}] 角色 ${runtime.record.name} 離線存檔失敗：`, err);
    } finally {
      clearOnline(runtime.record.accountId, runtime.online);
      runtime.resolveLeft();
    }
  }

  override onDispose(): void {
    this.presence.unsubscribe(WORLD_CHAT_TOPIC, this.onWorldChat);
  }

  // ------------------------------------------------------------ MonsterHost：提供給魔物 AI 的資訊

  get monsterStates(): MapState['monsters'] {
    return this.state.monsters;
  }

  *targets(): Iterable<AiTarget> {
    for (const [id, runtime] of this.runtimes) {
      yield this.toAiTarget(id, runtime);
    }
  }

  getTarget(id: string): AiTarget | undefined {
    const runtime = this.runtimes.get(id);
    return runtime ? this.toAiTarget(id, runtime) : undefined;
  }

  private toAiTarget(id: string, runtime: PlayerRuntime): AiTarget {
    return { id, x: runtime.move.x, y: runtime.move.y, alive: !runtime.dead && !runtime.transferring };
  }

  /** 魔物對玩家出手一次 */
  onMonsterAttack(monster: Monster, targetId: string): void {
    const runtime = this.runtimes.get(targetId);
    if (!runtime || runtime.dead || runtime.transferring) {
      return;
    }
    const result = rollAttack(
      monster.combat,
      runtime.combat,
      { kind: 'physical', element: 'neutral', power: 1 },
      Math.random,
    );
    this.broadcastCombat({
      type: result.miss ? 'miss' : 'damage',
      sourceId: monster.key,
      targetId,
      amount: result.damage,
      crit: result.crit,
    });
    if (result.miss) {
      return;
    }
    this.setHp(runtime, runtime.record.hp - result.damage);
    if (runtime.record.hp === 0) {
      this.killPlayer(runtime, monster.def.name);
    }
  }

  // ------------------------------------------------------------ 存檔

  /** 定時存檔：只寫入自上次存檔後有變動的角色 */
  private autosave(): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.transferring || (!runtime.dirty && !runtime.inventoryDirty)) {
        continue;
      }
      const withInventory = runtime.inventoryDirty;
      // 先清除旗標：存檔期間若又有變動，會重新被標記，下一輪再存
      runtime.dirty = false;
      runtime.inventoryDirty = false;
      saveCharacter(runtime.record, withInventory).catch((err: unknown) => {
        // 失敗就把旗標設回來，下一輪重試
        runtime.dirty = true;
        runtime.inventoryDirty = runtime.inventoryDirty || withInventory;
        console.error(`[room ${this.map.id}] 角色 ${runtime.record.name} 定時存檔失敗：`, err);
      });
    }
  }

  // ------------------------------------------------------------ 訊息處理：移動

  /** 移動要求：只接受「目標格」，路徑與實際位置都由伺服器計算。移動會取消攻擊目標。 */
  private handleMove(client: Client, message: unknown): void {
    const runtime = this.runtimes.get(client.sessionId);
    if (!runtime || runtime.transferring) {
      return;
    }
    const now = Date.now();
    if (now - runtime.lastMoveAt < MOVE_MIN_INTERVAL_MS) {
      return; // 送太快，直接忽略
    }
    runtime.lastMoveAt = now;

    const target = message as { x?: unknown; y?: unknown } | null;
    const x = target?.x;
    const y = target?.y;
    const valid =
      !runtime.dead &&
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      inBounds(this.map.grid, x as number, y as number) &&
      isWalkable(this.map.grid, x as number, y as number);
    const path = valid
      ? findPath(this.map.grid, currentTile(runtime.move), { x: x as number, y: y as number })
      : null;
    if (!path) {
      const reject: MoveRejectMessage = { x: runtime.move.x, y: runtime.move.y };
      client.send(MSG.moveReject, reject);
      return;
    }
    runtime.targetKey = null;
    runtime.move.path = path;
  }

  // ------------------------------------------------------------ 訊息處理：戰鬥

  /** 取得可以行動的玩家（存在、沒倒地、沒在傳送，且沒有送太快） */
  private actingPlayer(client: Client): PlayerRuntime | null {
    const runtime = this.runtimes.get(client.sessionId);
    if (!runtime || runtime.dead || runtime.transferring) {
      return null;
    }
    const now = Date.now();
    if (now - runtime.lastActionAt < ACTION_MIN_INTERVAL_MS) {
      return null;
    }
    runtime.lastActionAt = now;
    return runtime;
  }

  /** 指定攻擊目標：之後每個 tick 由伺服器追擊並在攻擊間隔到時自動普攻 */
  private handleAttack(client: Client, message: unknown): void {
    const runtime = this.actingPlayer(client);
    if (!runtime) {
      return;
    }
    const targetId = (message as { targetId?: unknown } | null)?.targetId;
    if (typeof targetId !== 'string' || !this.monsters.get(targetId)) {
      return; // 目標不存在（可能剛被別人打倒）
    }
    runtime.targetKey = targetId;
    runtime.nextChaseRepathAt = 0;
  }

  private handleSkill(client: Client, message: unknown): void {
    const runtime = this.actingPlayer(client);
    if (!runtime) {
      return;
    }
    const payload = message as { skillId?: unknown; targetId?: unknown } | null;
    const skill = typeof payload?.skillId === 'string' ? getSkillDef(payload.skillId) : undefined;
    // 只能使用自己職業的技能
    if (!skill || !runtime.cls.skills.includes(skill.id)) {
      return;
    }
    const { record } = runtime;
    const now = Date.now();
    if (record.level < skill.requiredLevel) {
      this.sendSystemTo(client, `${skill.name} 需要等級 ${skill.requiredLevel}`);
      return;
    }
    if (now < (runtime.cooldowns.get(skill.id) ?? 0)) {
      return; // 冷卻中（用戶端按鈕本來就會擋，這裡不必提示）
    }
    if (record.sp < skill.spCost) {
      this.sendSystemTo(client, 'SP 不足');
      return;
    }

    if (skill.type === 'heal') {
      const amount = Math.floor(runtime.combat.matk * skill.power * (0.95 + Math.random() * 0.1));
      this.spendSkillCost(runtime, skill.id, skill.spCost, skill.cooldownMs, now);
      const before = record.hp;
      this.setHp(runtime, record.hp + amount);
      this.broadcastCombat({
        type: 'heal',
        sourceId: client.sessionId,
        targetId: client.sessionId,
        amount: record.hp - before,
        crit: false,
        skillId: skill.id,
      });
      return;
    }

    const target = typeof payload?.targetId === 'string' ? this.monsters.get(payload.targetId) : undefined;
    if (!target) {
      this.sendSystemTo(client, '請先選擇目標');
      return;
    }
    // 多給 0.3 格的寬限，補償用戶端畫面與伺服器位置的些微落差
    if (distance(runtime.move, target.move) > skill.range + 0.3) {
      this.sendSystemTo(client, '距離太遠');
      return;
    }
    this.spendSkillCost(runtime, skill.id, skill.spCost, skill.cooldownMs, now);

    const options: AttackOptions = {
      kind: skill.kind,
      element: skill.element === 'weapon' ? 'neutral' : skill.element,
      power: skill.power,
    };
    // 範圍技能：以目標為中心，先列出範圍內的魔物再逐一結算
    const victims = skill.radius > 0 ? this.monsters.inRadius(target.move, skill.radius) : [target];
    for (const victim of victims) {
      for (let hit = 0; hit < skill.hits; hit++) {
        if (this.monsters.get(victim.key) !== victim) {
          break; // 前一擊已經打倒
        }
        this.playerAttack(runtime, victim, options, now, skill.id);
      }
    }
    // 施放後若目標還活著，接著自動普攻
    if (this.monsters.get(target.key) === target) {
      runtime.targetKey = target.key;
    }
  }

  private spendSkillCost(runtime: PlayerRuntime, skillId: string, spCost: number, cooldownMs: number, now: number): void {
    runtime.record.sp -= spCost;
    runtime.cooldowns.set(skillId, now + cooldownMs);
    runtime.dirty = true;
    runtime.selfDirty = true;
  }

  /** 玩家對魔物出手一次（普攻或技能的一擊） */
  private playerAttack(
    runtime: PlayerRuntime,
    monster: Monster,
    options: AttackOptions,
    now: number,
    skillId?: string,
  ): void {
    const result = rollAttack(runtime.combat, monster.combat, options, Math.random);
    this.broadcastCombat({
      type: result.miss ? 'miss' : 'damage',
      sourceId: runtime.client.sessionId,
      targetId: monster.key,
      amount: result.damage,
      crit: result.crit,
      ...(skillId ? { skillId } : {}),
    });
    if (result.miss) {
      return;
    }
    if (this.monsters.applyDamage(monster, result.damage, runtime.client.sessionId, now)) {
      this.onMonsterKilled(monster, now);
    }
  }

  /** 魔物死亡：分配經驗、給星幣、產生掉落物 */
  private onMonsterKilled(monster: Monster, now: number): void {
    const { def } = monster;

    // 經驗：依各人造成的傷害比例分配，再套用等級差倍率
    let total = 0;
    for (const amount of monster.damageBy.values()) {
      total += amount;
    }
    for (const [sessionId, amount] of monster.damageBy) {
      const runtime = this.runtimes.get(sessionId);
      if (!runtime || runtime.dead) {
        continue;
      }
      const share = total > 0 ? amount / total : 0;
      const gain = Math.max(1, Math.round(def.exp * share * expLevelModifier(runtime.record.level, def.level)));
      this.grantExp(runtime, gain);
    }

    // 星幣與掉落物歸第一個打到牠的人
    const ownerId = monster.firstAttackerId ?? '';
    const owner = this.runtimes.get(ownerId);
    if (owner) {
      const [min, max] = def.coins;
      const coins = min + Math.floor(Math.random() * (max - min + 1));
      if (coins > 0) {
        owner.record.coins += coins;
        owner.dirty = true;
        this.sendInventory(owner.client, owner.record);
      }
    }
    for (const drop of def.drops) {
      if (Math.random() * 100 >= drop.rate) {
        continue; // 每項掉落物獨立判定
      }
      const state = new DropState();
      state.itemId = drop.itemId;
      state.quantity = 1;
      // 稍微散開，避免多個掉落物疊在同一點
      state.x = monster.move.x + (Math.random() - 0.5) * 0.6;
      state.y = monster.move.y + (Math.random() - 0.5) * 0.6;
      state.owner = owner ? ownerId : '';
      const key = `d${this.nextDropId++}`;
      this.state.drops.set(key, state);
      this.drops.set(key, { ownerUntil: now + DROP_OWNER_MS, expireAt: now + DROP_LIFETIME_MS });
    }
  }

  /** 給予經驗並處理升級：每升一級獲得素質點，HP／SP 回滿 */
  private grantExp(runtime: PlayerRuntime, gain: number): void {
    const { record, state, client } = runtime;
    if (record.level >= MAX_LEVEL) {
      return;
    }
    const result = applyExp(record.level, record.exp, gain);
    record.level = result.level;
    record.exp = result.exp;
    runtime.dirty = true;
    runtime.selfDirty = true;
    if (result.levelsGained > 0) {
      record.statPoints += STAT_POINTS_PER_LEVEL * result.levelsGained;
      state.level = record.level;
      this.refreshCombat(runtime);
      record.sp = runtime.combat.maxSp;
      this.setHp(runtime, runtime.combat.maxHp);
      this.sendSystemTo(client, `升級了！目前等級 ${record.level}，獲得 ${STAT_POINTS_PER_LEVEL * result.levelsGained} 點素質點`);
    }
  }

  /** 等級或素質改變後重新計算戰鬥數值 */
  private refreshCombat(runtime: PlayerRuntime): void {
    const { record, state } = runtime;
    runtime.combat = computePlayerCombatStats(runtime.cls, record.level, record.stats);
    state.maxHp = runtime.combat.maxHp;
    record.sp = Math.min(record.sp, runtime.combat.maxSp);
    this.setHp(runtime, Math.min(record.hp, runtime.combat.maxHp));
  }

  private setHp(runtime: PlayerRuntime, hp: number): void {
    const clamped = Math.max(0, Math.min(runtime.combat.maxHp, Math.floor(hp)));
    runtime.record.hp = clamped;
    runtime.state.hp = clamped;
    runtime.dirty = true;
    runtime.selfDirty = true;
  }

  // ------------------------------------------------------------ 倒地與復活

  private killPlayer(runtime: PlayerRuntime, killerName: string): void {
    const { record, client } = runtime;
    runtime.dead = true;
    runtime.reviveAt = Date.now() + REVIVE_DELAY_MS;
    runtime.targetKey = null;
    runtime.move.path = [];
    this.monsters.forgetTarget(client.sessionId);

    // 死亡懲罰：損失升級所需經驗的 1%（低等級不罰，且不會降級）
    let lost = 0;
    if (record.level >= DEATH_PENALTY_MIN_LEVEL) {
      lost = Math.min(record.exp, Math.floor(expToNext(record.level) * DEATH_EXP_PENALTY));
      record.exp -= lost;
    }
    const penalty = lost > 0 ? `，損失 ${lost} 經驗值` : '';
    this.sendSystemTo(client, `你被${killerName}擊倒了${penalty}。${REVIVE_DELAY_MS / 1000} 秒後在${this.reviveMapName()}復活`);
  }

  private reviveMapName(): string {
    return getMap(START_MAP_ID)?.displayName ?? START_MAP_ID;
  }

  /** 把「復活後」的狀態寫進角色資料：HP 回滿、位置改到起始地圖的出生點 */
  private applyReviveToRecord(runtime: PlayerRuntime): void {
    const start = getMap(START_MAP_ID) ?? this.map;
    runtime.record.hp = runtime.combat.maxHp;
    runtime.record.mapId = start.id;
    runtime.record.x = start.spawn.x;
    runtime.record.y = start.spawn.y;
  }

  private revive(runtime: PlayerRuntime): void {
    runtime.dead = false;
    this.setHp(runtime, runtime.combat.maxHp);
    const start = getMap(START_MAP_ID) ?? this.map;
    if (start.id === this.map.id) {
      // 已經在起始地圖：直接移到出生點
      runtime.move.x = start.spawn.x;
      runtime.move.y = start.spawn.y;
      runtime.move.path = [];
      runtime.state.x = start.spawn.x;
      runtime.state.y = start.spawn.y;
      runtime.record.x = start.spawn.x;
      runtime.record.y = start.spawn.y;
      return;
    }
    void this.startTransfer(runtime, start.id, Math.floor(start.spawn.x), Math.floor(start.spawn.y));
  }

  // ------------------------------------------------------------ 訊息處理：掉落物、道具、配點

  private handlePickup(client: Client, message: unknown): void {
    const runtime = this.actingPlayer(client);
    if (!runtime) {
      return;
    }
    const dropId = (message as { dropId?: unknown } | null)?.dropId;
    const state = typeof dropId === 'string' ? this.state.drops.get(dropId) : undefined;
    const drop = typeof dropId === 'string' ? this.drops.get(dropId) : undefined;
    if (!state || !drop || typeof dropId !== 'string') {
      return; // 已被撿走或消失
    }
    if (distance(runtime.move, state) > PICKUP_RANGE) {
      this.sendSystemTo(client, '距離太遠，撿不到');
      return;
    }
    if (state.owner !== '' && state.owner !== client.sessionId && Date.now() < drop.ownerUntil) {
      this.sendSystemTo(client, '這個掉落物暫時只有擊倒魔物的人能撿');
      return;
    }
    if (!addItemToInventory(runtime.record.inventory, state.itemId, state.quantity)) {
      this.sendSystemTo(client, '背包已滿');
      return;
    }
    this.state.drops.delete(dropId);
    this.drops.delete(dropId);
    runtime.inventoryDirty = true;
    this.sendInventory(client, runtime.record);
    this.sendSystemTo(client, `取得 ${getItemDef(state.itemId)?.name ?? state.itemId} ×${state.quantity}`);
  }

  /** 使用背包中的消耗品（目前只有回復 HP／SP 的效果） */
  private handleUseItem(client: Client, message: unknown): void {
    const runtime = this.actingPlayer(client);
    if (!runtime) {
      return;
    }
    const slot = (message as { slot?: unknown } | null)?.slot;
    const { record } = runtime;
    const item = record.inventory.find((i) => i.slot === slot);
    const def = item ? getItemDef(item.itemId) : undefined;
    if (!item || !def || def.type !== 'consumable' || !def.effect) {
      return;
    }
    const hpGain = def.effect.hp ?? 0;
    const spGain = def.effect.sp ?? 0;
    const useful =
      (hpGain > 0 && record.hp < runtime.combat.maxHp) || (spGain > 0 && record.sp < runtime.combat.maxSp);
    if (!useful) {
      this.sendSystemTo(client, '現在不需要使用');
      return;
    }
    if (!removeFromSlot(record.inventory, item.slot, 1)) {
      return;
    }
    if (hpGain > 0) {
      const before = record.hp;
      this.setHp(runtime, record.hp + hpGain);
      this.broadcastCombat({
        type: 'heal',
        sourceId: client.sessionId,
        targetId: client.sessionId,
        amount: record.hp - before,
        crit: false,
      });
    }
    if (spGain > 0) {
      record.sp = Math.min(runtime.combat.maxSp, record.sp + spGain);
    }
    runtime.dirty = true;
    runtime.selfDirty = true;
    runtime.inventoryDirty = true;
    this.sendInventory(client, record);
  }

  /** 素質配點：一次加 1，花費由伺服器計算 */
  private handleAllocStat(client: Client, message: unknown): void {
    const runtime = this.actingPlayer(client);
    if (!runtime) {
      return;
    }
    const stat = (message as { stat?: unknown } | null)?.stat;
    if (!isStatKey(stat)) {
      return;
    }
    const { record } = runtime;
    const cost = allocateStat(record.stats, record.statPoints, stat);
    if (cost === null) {
      this.sendSystemTo(client, '素質點不足或已達上限');
      return;
    }
    record.statPoints -= cost;
    this.refreshCombat(runtime);
    runtime.dirty = true;
    runtime.selfDirty = true;
  }

  // ------------------------------------------------------------ 訊息處理：聊天與背包

  private handleChat(client: Client, message: unknown): void {
    const runtime = this.runtimes.get(client.sessionId);
    if (!runtime) {
      return;
    }
    const payload = message as { channel?: unknown; text?: unknown } | null;
    const text = sanitizeChatText(payload?.text);
    if (!text) {
      return;
    }
    const now = Date.now();
    if (now - runtime.lastChatAt < CHAT_MIN_INTERVAL_MS) {
      this.sendSystemTo(client, '發言太頻繁，請稍候再試');
      return;
    }
    runtime.lastChatAt = now;

    // GM 指令只在伺服器設定開啟時有效；未開啟時當成一般聊天內容
    if (config.gmCommands && text.startsWith('/gm ')) {
      this.handleGmCommand(runtime, text.slice(4).trim());
      return;
    }

    const channel: ChatChannel = payload?.channel === 'world' ? 'world' : 'map';
    const chat: ChatMessage = {
      channel,
      sessionId: client.sessionId,
      name: runtime.record.name,
      text,
    };
    if (channel === 'world') {
      // 透過 presence 發佈，所有地圖房間（包含自己）都會收到並轉送給房內玩家
      this.presence.publish(WORLD_CHAT_TOPIC, chat);
    } else {
      this.broadcast(MSG.chat, chat);
    }
  }

  /** 用戶端準備好接收後會要求一次背包與個人數值（之後有變動時由伺服器主動傳送） */
  private handleInventoryRequest(client: Client): void {
    const runtime = this.runtimes.get(client.sessionId);
    if (!runtime) {
      return;
    }
    const now = Date.now();
    if (now - runtime.lastInventoryRequestAt < INVENTORY_REQUEST_MIN_INTERVAL_MS) {
      return;
    }
    runtime.lastInventoryRequestAt = now;
    this.sendInventory(client, runtime.record);
    this.sendSelf(runtime);
  }

  /**
   * 開發與測試用的 GM 指令：
   *   /gm level <等級>           設定等級（素質點依等級重新給予）
   *   /gm item <道具代號> [數量]  取得道具
   *   /gm exp <數值>             獲得經驗值（會觸發升級）
   *   /gm hp <數值>              設定目前 HP
   */
  private handleGmCommand(runtime: PlayerRuntime, command: string): void {
    const { record, client, state } = runtime;
    const [name, ...args] = command.split(/\s+/);
    if (name === 'level') {
      const level = Number(args[0]);
      if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
        this.sendSystemTo(client, `等級需為 1–${MAX_LEVEL} 的整數`);
        return;
      }
      record.statPoints = Math.max(0, record.statPoints + (level - record.level) * STAT_POINTS_PER_LEVEL);
      record.level = level;
      record.exp = 0;
      state.level = level;
      this.refreshCombat(runtime);
      this.sendSystemTo(client, `等級已設為 ${level}`);
      return;
    }
    if (name === 'item') {
      const def = getItemDef(args[0] ?? '');
      const quantity = args[1] === undefined ? 1 : Number(args[1]);
      if (!def) {
        this.sendSystemTo(client, `沒有這個道具：${args[0] ?? ''}`);
        return;
      }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
        this.sendSystemTo(client, '數量需為 1–999 的整數');
        return;
      }
      if (!addItemToInventory(record.inventory, def.id, quantity)) {
        this.sendSystemTo(client, '背包放不下');
        return;
      }
      runtime.inventoryDirty = true;
      this.sendInventory(client, record);
      this.sendSystemTo(client, `取得 ${def.name} ×${quantity}`);
      return;
    }
    if (name === 'exp') {
      const amount = Number(args[0]);
      if (!Number.isInteger(amount) || amount < 1) {
        this.sendSystemTo(client, '經驗值需為正整數');
        return;
      }
      this.grantExp(runtime, amount);
      this.sendSystemTo(client, `獲得 ${amount} 經驗值`);
      return;
    }
    if (name === 'hp') {
      const hp = Number(args[0]);
      if (!Number.isInteger(hp) || hp < 1) {
        this.sendSystemTo(client, 'HP 需為正整數');
        return;
      }
      this.setHp(runtime, hp);
      this.sendSystemTo(client, `HP 已設為 ${record.hp}`);
      return;
    }
    this.sendSystemTo(client, '可用指令：/gm level <等級>、/gm exp <數值>、/gm item <道具代號> [數量]、/gm hp <數值>');
  }

  // ------------------------------------------------------------ 模擬

  /** 每個 tick：玩家（復活、回復、攻擊、移動、傳送點）→ 魔物 AI → 掉落物過期 → 傳送個人數值 */
  private tick(deltaMs: number): void {
    const now = Date.now();
    for (const runtime of this.runtimes.values()) {
      if (runtime.transferring) {
        continue;
      }
      if (runtime.dead) {
        if (now >= runtime.reviveAt) {
          this.revive(runtime);
        }
        continue;
      }
      this.updateRegen(runtime, now);
      this.updateAttack(runtime, now);
      this.updateMovement(runtime, deltaMs);
    }

    this.monsters.update(now, deltaMs);

    for (const [key, drop] of this.drops) {
      if (now >= drop.expireAt) {
        this.drops.delete(key);
        this.state.drops.delete(key);
      }
    }

    for (const runtime of this.runtimes.values()) {
      if (runtime.selfDirty) {
        this.sendSelf(runtime);
      }
    }
  }

  /** HP／SP 自然回復（GDD 4.3） */
  private updateRegen(runtime: PlayerRuntime, now: number): void {
    if (now < runtime.nextRegenAt) {
      return;
    }
    runtime.nextRegenAt = now + REGEN_INTERVAL_MS;
    const { record, combat } = runtime;
    if (record.hp < combat.maxHp) {
      this.setHp(runtime, record.hp + Math.floor(combat.maxHp * 0.005) + Math.floor(record.stats.con / 5));
    }
    if (record.sp < combat.maxSp) {
      const gain = Math.floor(combat.maxSp * 0.01) + Math.floor(record.stats.mnd / 6);
      record.sp = Math.min(combat.maxSp, record.sp + Math.max(1, gain));
      runtime.dirty = true;
      runtime.selfDirty = true;
    }
  }

  /** 有攻擊目標時：在射程內就停下來普攻，否則朝目標移動 */
  private updateAttack(runtime: PlayerRuntime, now: number): void {
    if (!runtime.targetKey) {
      return;
    }
    const monster = this.monsters.get(runtime.targetKey);
    if (!monster) {
      runtime.targetKey = null; // 目標已死亡
      return;
    }
    const { move, cls } = runtime;
    if (distance(move, monster.move) <= cls.attackRange) {
      move.path = [];
      if (now >= runtime.nextAttackAt) {
        runtime.nextAttackAt = now + runtime.combat.attackIntervalMs;
        this.playerAttack(
          runtime,
          monster,
          { kind: cls.attackType === 'magic' ? 'magical' : 'physical', element: 'neutral', power: 1 },
          now,
        );
      }
      return;
    }
    if (now >= runtime.nextChaseRepathAt) {
      runtime.nextChaseRepathAt = now + CHASE_REPATH_MS;
      const path = findPath(this.map.grid, currentTile(move), currentTile(monster.move));
      if (!path) {
        runtime.targetKey = null; // 走不到
        return;
      }
      move.path = path;
    }
  }

  private updateMovement(runtime: PlayerRuntime, deltaMs: number): void {
    const { move, state, record } = runtime;
    if (!advanceMove(move, deltaMs / 1000, PLAYER_MOVE_SPEED)) {
      return;
    }
    state.x = move.x;
    state.y = move.y;
    record.x = move.x;
    record.y = move.y;
    runtime.dirty = true;

    const tile = currentTile(move);
    const portal = portalAt(this.map.portals, tile.x, tile.y);
    if (portal) {
      void this.startTransfer(runtime, portal.targetMap, portal.targetX, portal.targetY);
    }
  }

  /**
   * 傳送：把角色的位置改到目標地圖並立即存檔，存檔成功後才通知用戶端改連那張地圖的房間
   * （新房間會從資料庫載入角色，所以必須先存好）。
   */
  private async startTransfer(runtime: PlayerRuntime, mapId: string, tileX: number, tileY: number): Promise<void> {
    const { record, client } = runtime;
    const before = { mapId: record.mapId, x: record.x, y: record.y };
    runtime.transferring = true;
    runtime.targetKey = null;
    runtime.move.path = [];
    this.monsters.forgetTarget(client.sessionId);
    record.mapId = mapId;
    record.x = tileX + 0.5;
    record.y = tileY + 0.5;

    try {
      await saveCharacter(record, true);
    } catch (err) {
      // 存檔失敗就取消傳送，角色留在原地
      console.error(`[room ${this.map.id}] 角色 ${record.name} 傳送存檔失敗：`, err);
      record.mapId = before.mapId;
      record.x = before.x;
      record.y = before.y;
      runtime.transferring = false;
      this.sendSystemTo(client, '傳送失敗，請稍後再試');
      return;
    }
    if (this.runtimes.get(client.sessionId) !== runtime) {
      return; // 存檔期間玩家已離線
    }
    runtime.savedForTransfer = true;
    runtime.dirty = false;
    runtime.inventoryDirty = false;

    const transfer: TransferMessage = { mapId };
    client.send(MSG.transfer, transfer);
    // 用戶端遲遲不離開就強制中斷，避免角色卡在舊房間
    this.clock.setTimeout(() => {
      if (this.runtimes.get(client.sessionId) === runtime) {
        client.leave(CLOSE_CODE.transferTimeout);
      }
    }, TRANSFER_TIMEOUT_MS);
  }

  // ------------------------------------------------------------ 傳送訊息

  /** 把背包內容傳給本人（背包是私人資料，不放在同步狀態裡） */
  private sendInventory(client: Client, record: CharacterRecord): void {
    const message: InventoryMessage = { items: record.inventory, coins: record.coins };
    client.send(MSG.inventory, message);
  }

  /** 把個人數值傳給本人 */
  private sendSelf(runtime: PlayerRuntime): void {
    const { record, combat } = runtime;
    runtime.selfDirty = false;
    const message: SelfMessage = {
      level: record.level,
      exp: record.exp,
      expNext: expToNext(record.level),
      hp: record.hp,
      maxHp: combat.maxHp,
      sp: record.sp,
      maxSp: combat.maxSp,
      statPoints: record.statPoints,
      stats: { ...record.stats },
    };
    runtime.client.send(MSG.self, message);
  }

  private broadcastCombat(event: CombatEvent): void {
    this.broadcast(MSG.combat, event);
  }

  private sendSystem(text: string, except?: Client): void {
    const message: SystemMessage = { text };
    this.broadcast(MSG.system, message, except ? { except } : undefined);
  }

  private sendSystemTo(client: Client, text: string): void {
    const message: SystemMessage = { text };
    client.send(MSG.system, message);
  }
}
