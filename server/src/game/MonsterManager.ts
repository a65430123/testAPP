// 魔物管理：重生點、AI（閒晃 → 追擊 → 返回）、受傷與死亡。
// 不直接碰玩家資料，需要的資訊透過 MonsterHost 向房間取得。

import {
  advanceMove,
  createMoveState,
  currentTile,
  findPath,
  getMonsterDef,
  isMoving,
  isWalkable,
  monsterCombatant,
  type Combatant,
  type MonsterDef,
  type MonsterSpawnArea,
  type MoveState,
  type Point,
} from '@starmemory/shared';
import type { GameMap } from '../maps';
import { MonsterState } from '../rooms/schema';

/** 追擊時多久重新尋路一次（毫秒） */
const CHASE_REPATH_MS = 400;
/** 閒晃：每次移動的最大距離（格）與兩次移動之間的等待時間範圍（毫秒） */
const WANDER_RADIUS = 3;
const WANDER_WAIT_MS: [number, number] = [3000, 8000];
/** 閒晃與返回時的速度倍率（相對於追擊速度） */
const WANDER_SPEED = 0.5;
const RETURN_SPEED = 1.5;
/** 被打之後至少隔多久才會出手（毫秒），避免一被打就瞬間反擊 */
const REACTION_MS = 300;

type AiState = 'idle' | 'chase' | 'return';

/** 魔物可以攻擊的對象（目前只有玩家） */
export interface AiTarget {
  id: string;
  x: number;
  y: number;
  /** false 表示已被擊倒或正在切換地圖，不能再當成目標 */
  alive: boolean;
}

/** 房間提供給魔物管理器的介面 */
export interface MonsterHost {
  readonly map: GameMap;
  /** 同步狀態中的魔物表 */
  readonly monsterStates: { set(key: string, value: MonsterState): unknown; delete(key: string): unknown };
  targets(): Iterable<AiTarget>;
  getTarget(id: string): AiTarget | undefined;
  /** 魔物對目標出手一次（傷害計算與後續處理由房間負責） */
  onMonsterAttack(monster: Monster, targetId: string): void;
}

export class Monster {
  ai: AiState = 'idle';
  hp: number;
  targetId: string | null = null;
  nextWanderAt = 0;
  nextAttackAt = 0;
  nextRepathAt = 0;
  /** 各攻擊者累積造成的傷害（用來分配經驗） */
  readonly damageBy = new Map<string, number>();
  /** 第一個打到牠的人（掉落物歸屬） */
  firstAttackerId: string | null = null;
  readonly combat: Combatant;

  constructor(
    readonly key: string,
    readonly def: MonsterDef,
    readonly area: MonsterSpawnArea,
    /** 重生點：追太遠會回到這裡 */
    readonly home: Point,
    readonly state: MonsterState,
    readonly move: MoveState,
  ) {
    this.hp = def.hp;
    this.combat = monsterCombatant(def);
  }
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export class MonsterManager {
  private readonly monsters = new Map<string, Monster>();
  /** 等待重生的名額 */
  private respawns: Array<{ at: number; area: MonsterSpawnArea }> = [];
  private nextId = 1;

  constructor(
    private readonly host: MonsterHost,
    private readonly rng: () => number = Math.random,
  ) {}

  /** 開房時依地圖的重生區生出所有魔物 */
  spawnAll(now: number): void {
    for (const area of this.host.map.monsterSpawns) {
      for (let i = 0; i < area.count; i++) {
        this.spawn(area, now);
      }
    }
  }

  get(key: string): Monster | undefined {
    return this.monsters.get(key);
  }

  values(): IterableIterator<Monster> {
    return this.monsters.values();
  }

  /** 以某點為圓心、指定半徑內的所有魔物 */
  inRadius(center: Point, radius: number): Monster[] {
    return [...this.monsters.values()].filter((m) => distance(m.move, center) <= radius);
  }

  // ------------------------------------------------------------ 重生

  private spawn(area: MonsterSpawnArea, now: number): void {
    const def = getMonsterDef(area.monsterId);
    const tile = this.randomWalkableTile(area);
    if (!def || !tile) {
      return; // 重生區內沒有任何可站立的格子
    }
    const home = { x: tile.x + 0.5, y: tile.y + 0.5 };
    const state = new MonsterState();
    state.monsterId = def.id;
    state.x = home.x;
    state.y = home.y;
    state.hp = def.hp;
    state.maxHp = def.hp;

    const key = `m${this.nextId++}`;
    const monster = new Monster(key, def, area, home, state, createMoveState(home.x, home.y));
    monster.nextWanderAt = now + this.randomBetween(...WANDER_WAIT_MS);
    this.monsters.set(key, monster);
    this.host.monsterStates.set(key, state);
  }

  /** 在重生區內隨機找一個可站立的格子 */
  private randomWalkableTile(area: MonsterSpawnArea): Point | null {
    const grid = this.host.map.grid;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = Math.floor(area.x + this.rng() * area.width);
      const y = Math.floor(area.y + this.rng() * area.height);
      if (isWalkable(grid, x, y)) {
        return { x, y };
      }
    }
    // 運氣不好一直抽到障礙物：改成逐格找
    for (let y = Math.floor(area.y); y < area.y + area.height; y++) {
      for (let x = Math.floor(area.x); x < area.x + area.width; x++) {
        if (isWalkable(grid, x, y)) {
          return { x, y };
        }
      }
    }
    return null;
  }

  private randomBetween(min: number, max: number): number {
    return min + this.rng() * (max - min);
  }

  // ------------------------------------------------------------ 受傷與死亡

  /**
   * 對魔物造成傷害。
   * @returns 魔物是否因此死亡（死亡時已從場上移除並排入重生）
   */
  applyDamage(monster: Monster, amount: number, attackerId: string, now: number): boolean {
    monster.hp = Math.max(0, monster.hp - amount);
    monster.state.hp = monster.hp;
    monster.damageBy.set(attackerId, (monster.damageBy.get(attackerId) ?? 0) + amount);
    monster.firstAttackerId ??= attackerId;

    if (monster.hp === 0) {
      this.monsters.delete(monster.key);
      this.host.monsterStates.delete(monster.key);
      this.respawns.push({ at: now + monster.def.respawnSec * 1000, area: monster.area });
      return true;
    }

    // 被打就還手（被動魔物也會）。正在返回途中且已經離家很遠時不理會，避免被風箏拉走。
    const farFromHome = distance(monster.move, monster.home) > monster.def.leashRange * 0.8;
    if (monster.ai === 'idle' || (monster.ai === 'return' && !farFromHome)) {
      monster.ai = 'chase';
      monster.targetId = attackerId;
      monster.nextRepathAt = 0;
      monster.nextAttackAt = Math.max(monster.nextAttackAt, now + REACTION_MS);
    }
    return false;
  }

  /** 玩家離開、死亡或切換地圖時呼叫：正在追他的魔物放棄並返回 */
  forgetTarget(targetId: string): void {
    for (const monster of this.monsters.values()) {
      if (monster.targetId === targetId) {
        this.startReturn(monster);
      }
    }
  }

  // ------------------------------------------------------------ AI

  update(now: number, deltaMs: number): void {
    if (this.respawns.length > 0) {
      const due = this.respawns.filter((r) => r.at <= now);
      if (due.length > 0) {
        this.respawns = this.respawns.filter((r) => r.at > now);
        for (const r of due) {
          this.spawn(r.area, now);
        }
      }
    }

    const dt = deltaMs / 1000;
    for (const monster of this.monsters.values()) {
      switch (monster.ai) {
        case 'idle':
          this.updateIdle(monster, now, dt);
          break;
        case 'chase':
          this.updateChase(monster, now, dt);
          break;
        case 'return':
          this.updateReturn(monster, now, dt);
          break;
      }
    }
  }

  /** 閒晃；主動魔物同時留意附近的玩家 */
  private updateIdle(monster: Monster, now: number, dt: number): void {
    const { def, move } = monster;
    if (def.aggressive) {
      const target = this.findAggroTarget(monster);
      if (target) {
        monster.ai = 'chase';
        monster.targetId = target.id;
        monster.nextRepathAt = 0;
        monster.nextAttackAt = Math.max(monster.nextAttackAt, now + REACTION_MS);
        return;
      }
    }
    if (!isMoving(move) && now >= monster.nextWanderAt) {
      monster.nextWanderAt = now + this.randomBetween(...WANDER_WAIT_MS);
      const tile = currentTile(move);
      const goal = {
        x: tile.x + Math.round(this.randomBetween(-WANDER_RADIUS, WANDER_RADIUS)),
        y: tile.y + Math.round(this.randomBetween(-WANDER_RADIUS, WANDER_RADIUS)),
      };
      // 只在自己的重生區內閒晃
      const { area } = monster;
      const inside =
        goal.x >= area.x && goal.x < area.x + area.width && goal.y >= area.y && goal.y < area.y + area.height;
      if (inside) {
        move.path = findPath(this.host.map.grid, tile, goal) ?? [];
      }
    }
    this.advance(monster, dt, def.moveSpeed * WANDER_SPEED);
  }

  /** 找出警戒範圍內最近的玩家（玩家必須在牽引範圍內，否則追過去也會馬上折返） */
  private findAggroTarget(monster: Monster): AiTarget | null {
    let best: AiTarget | null = null;
    let bestDist = monster.def.aggroRange;
    for (const target of this.host.targets()) {
      if (!target.alive || distance(target, monster.home) > monster.def.leashRange) {
        continue;
      }
      const d = distance(target, monster.move);
      if (d <= bestDist) {
        best = target;
        bestDist = d;
      }
    }
    return best;
  }

  /** 追擊目標；進入攻擊距離就停下來打；離家太遠或目標消失就返回 */
  private updateChase(monster: Monster, now: number, dt: number): void {
    const { def, move } = monster;
    const target = monster.targetId ? this.host.getTarget(monster.targetId) : undefined;
    if (!target || !target.alive || distance(move, monster.home) > def.leashRange) {
      this.startReturn(monster);
      return;
    }

    if (distance(move, target) <= def.attackRange) {
      move.path = [];
      if (now >= monster.nextAttackAt) {
        monster.nextAttackAt = now + def.attackIntervalMs;
        this.host.onMonsterAttack(monster, target.id);
      }
      return;
    }

    if (now >= monster.nextRepathAt) {
      monster.nextRepathAt = now + CHASE_REPATH_MS;
      const path = findPath(this.host.map.grid, currentTile(move), {
        x: Math.floor(target.x),
        y: Math.floor(target.y),
      });
      if (!path) {
        this.startReturn(monster); // 走不到目標
        return;
      }
      move.path = path;
    }
    this.advance(monster, dt, def.moveSpeed);
  }

  /** 放棄目標、回滿 HP、走回重生點 */
  private startReturn(monster: Monster): void {
    monster.ai = 'return';
    monster.targetId = null;
    monster.damageBy.clear();
    monster.firstAttackerId = null;
    monster.hp = monster.def.hp;
    monster.state.hp = monster.hp;
    const path = findPath(this.host.map.grid, currentTile(monster.move), {
      x: Math.floor(monster.home.x),
      y: Math.floor(monster.home.y),
    });
    if (path) {
      monster.move.path = path;
    } else {
      // 理論上不會發生；真的走不回去就直接放回重生點
      monster.move.path = [];
      monster.move.x = monster.home.x;
      monster.move.y = monster.home.y;
      monster.state.x = monster.home.x;
      monster.state.y = monster.home.y;
    }
  }

  private updateReturn(monster: Monster, now: number, dt: number): void {
    if (!isMoving(monster.move)) {
      monster.ai = 'idle';
      monster.nextWanderAt = now + this.randomBetween(...WANDER_WAIT_MS);
      return;
    }
    this.advance(monster, dt, monster.def.moveSpeed * RETURN_SPEED);
  }

  private advance(monster: Monster, dt: number, speed: number): void {
    if (advanceMove(monster.move, dt, speed)) {
      monster.state.x = monster.move.x;
      monster.state.y = monster.move.y;
    }
  }
}
