import { describe, expect, it } from 'vitest';
import {
  addToContainer,
  getQuestDef,
  isQuestReady,
  objectiveCounts,
  partyExpShare,
  questAcceptError,
  QUESTS,
  validateQuests,
  cloneItems,
  computeEquipTotals,
  equipError,
  getItemDef as itemDef,
  itemDisplayName,
  moveBetween,
  REFINE_TABLE,
  refineFee,
  takeByItemId,
  takeFromSlot,
  weaponRefineMultiplier,
  type ItemStack,
  allocateStat,
  applyExp,
  computePlayerCombatStats,
  ELEMENT_TABLE,
  expLevelModifier,
  expToNext,
  findMonsterSpawns,
  getMonsterDef,
  hitRate,
  monsterCombatant,
  MONSTERS,
  rollAttack,
  statCost,
  validateGameData,
  advanceMove,
  CLASSES,
  computeMaxHp,
  computeMaxSp,
  getClassDef,
  getItemDef,
  newStats,
  validatePassword,
  validateUsername,
  type InventoryItem,
  buildCollisionGrid,
  createMoveState,
  findPath,
  findPortals,
  findSpawn,
  isWalkable,
  nearestWalkable,
  portalAt,
  sanitizeChatText,
  SnapshotBuffer,
  tileToWorld,
  validateName,
  worldToTile,
  type CollisionGrid,
  type TiledMap,
} from '../src';

/** 用字串畫出測試用碰撞格：'#' 是障礙、'.' 可行走 */
function gridFrom(rows: string[]): CollisionGrid {
  const height = rows.length;
  const width = rows[0]!.length;
  const blocked = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      blocked[y * width + x] = ch === '#' ? 1 : 0;
    });
  });
  return { width, height, blocked };
}

describe('斜視角座標換算', () => {
  const geo = { tileWidth: 64, tileHeight: 32 };

  it('格座標與世界座標可以來回換算', () => {
    for (const [tx, ty] of [[0, 0], [3.5, 7.25], [20, 1], [0.5, 39.5]] as const) {
      const w = tileToWorld(tx, ty, geo);
      const t = worldToTile(w.x, w.y, geo);
      expect(t.x).toBeCloseTo(tx);
      expect(t.y).toBeCloseTo(ty);
    }
  });

  it('格 (0,0) 的中心在上頂點正下方半格高', () => {
    expect(tileToWorld(0.5, 0.5, geo)).toEqual({ x: 0, y: 16 });
  });
});

describe('A* 尋路', () => {
  it('起點等於終點時回傳空路徑', () => {
    const grid = gridFrom(['...', '...']);
    expect(findPath(grid, { x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([]);
  });

  it('會繞過牆壁，且路徑上每一格都可行走', () => {
    const grid = gridFrom([
      '.....',
      '.###.',
      '...#.',
      '.#...',
    ]);
    const path = findPath(grid, { x: 0, y: 0 }, { x: 4, y: 2 });
    expect(path).not.toBeNull();
    expect(path!.at(-1)).toEqual({ x: 4, y: 2 });
    for (const p of path!) {
      expect(isWalkable(grid, p.x, p.y)).toBe(true);
    }
  });

  it('不會斜向切過障礙物的角', () => {
    const grid = gridFrom([
      '.#',
      '..',
    ]);
    // (0,0) → (1,1) 的斜線被 (1,0) 擋住一側，必須先往下再往右
    expect(findPath(grid, { x: 0, y: 0 }, { x: 1, y: 1 })).toEqual([
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
  });

  it('無法到達時回傳 null', () => {
    const grid = gridFrom([
      '.#.',
      '.#.',
    ]);
    expect(findPath(grid, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeNull();
  });

  it('目標是障礙時可找到最近的可行走格', () => {
    const grid = gridFrom([
      '...',
      '.#.',
      '...',
    ]);
    const near = nearestWalkable(grid, { x: 1, y: 1 });
    expect(near).not.toBeNull();
    expect(isWalkable(grid, near!.x, near!.y)).toBe(true);
  });
});

describe('沿路徑移動', () => {
  it('依速度前進並在抵達後停止', () => {
    const state = createMoveState(0.5, 0.5);
    state.path = [{ x: 1, y: 0 }, { x: 2, y: 0 }];
    expect(advanceMove(state, 0.5, 2)).toBe(true);
    expect(state.x).toBeCloseTo(1.5);
    expect(state.path).toHaveLength(1);
    advanceMove(state, 10, 2);
    expect(state.x).toBeCloseTo(2.5);
    expect(state.y).toBeCloseTo(0.5);
    expect(state.path).toHaveLength(0);
    expect(advanceMove(state, 1, 2)).toBe(false);
  });
});

describe('Tiled 地圖解析', () => {
  const map: TiledMap = {
    type: 'map',
    orientation: 'isometric',
    width: 2,
    height: 2,
    tilewidth: 64,
    tileheight: 32,
    tilesets: [
      {
        firstgid: 1, name: 'ground', image: 'ground.png', imagewidth: 128, imageheight: 32,
        tilewidth: 64, tileheight: 32, tilecount: 2, columns: 2, margin: 0, spacing: 0,
        tiles: [{ id: 1, properties: [{ name: 'blocked', type: 'bool', value: true }] }],
      },
      {
        firstgid: 3, name: 'props', image: 'props.png', imagewidth: 64, imageheight: 96,
        tilewidth: 64, tileheight: 96, tilecount: 1, columns: 1, margin: 0, spacing: 0,
      },
    ],
    layers: [
      { type: 'tilelayer', id: 1, name: 'ground', width: 2, height: 2, data: [1, 2, 1, 1], visible: true, opacity: 1, x: 0, y: 0 },
      { type: 'tilelayer', id: 2, name: 'props', width: 2, height: 2, data: [0, 0, 3, 0], visible: true, opacity: 1, x: 0, y: 0 },
      {
        type: 'objectgroup', id: 3, name: 'spawns', visible: true, opacity: 1, x: 0, y: 0,
        objects: [{ id: 1, name: 'player_spawn', x: 48, y: 48, width: 0, height: 0, point: true }],
      },
    ],
  };

  it('blocked 圖磚與 props 圖磚都會變成障礙', () => {
    const grid = buildCollisionGrid(map);
    expect([...grid.blocked]).toEqual([0, 1, 1, 0]);
  });

  it('出生點換算成格座標', () => {
    expect(findSpawn(map, 'player_spawn')).toEqual({ x: 1.5, y: 1.5 });
  });
});

describe('傳送點', () => {
  const map: TiledMap = {
    type: 'map', orientation: 'isometric', width: 4, height: 4, tilewidth: 64, tileheight: 32,
    tilesets: [],
    layers: [
      {
        type: 'objectgroup', id: 1, name: 'portals', visible: true, opacity: 1, x: 0, y: 0,
        objects: [{
          id: 1, name: 'to_C01', x: 32, y: 0, width: 64, height: 32,
          properties: [
            { name: 'targetMap', type: 'string', value: 'C01' },
            { name: 'targetX', type: 'int', value: 14 },
            { name: 'targetY', type: 'int', value: 26 },
          ],
        }],
      },
    ],
  };

  it('解析成格座標並可依格子查詢', () => {
    const portals = findPortals(map);
    expect(portals).toEqual([
      { name: 'to_C01', x: 1, y: 0, width: 2, height: 1, targetMap: 'C01', targetX: 14, targetY: 26 },
    ]);
    expect(portalAt(portals, 1, 0)?.targetMap).toBe('C01');
    expect(portalAt(portals, 2, 0)?.targetMap).toBe('C01');
    expect(portalAt(portals, 3, 0)).toBeUndefined();
    expect(portalAt(portals, 1, 1)).toBeUndefined();
  });
});

describe('插值緩衝', () => {
  it('在兩筆資料之間線性內插，超過最後一筆時停在最後位置', () => {
    const buf = new SnapshotBuffer(50);
    expect(buf.sample(0)).toBeNull();
    buf.push(1000, 0, 0);
    buf.push(1050, 1, 2);
    expect(buf.sample(1025)).toEqual({ x: 0.5, y: 1 });
    expect(buf.sample(900)).toEqual({ x: 0, y: 0 });
    expect(buf.sample(2000)).toEqual({ x: 1, y: 2 });
  });

  it('靜止一段時間後再出發，不會從很久以前開始內插', () => {
    const buf = new SnapshotBuffer(50);
    buf.push(1000, 0, 0);
    buf.push(5000, 1, 0);
    // 出發前一刻（4950）仍應在原地
    expect(buf.sample(4900)).toEqual({ x: 0, y: 0 });
    expect(buf.sample(4975)!.x).toBeCloseTo(0.5);
  });
});

describe('名稱與聊天內容檢查', () => {
  it('角色名稱', () => {
    expect(validateName('小星')).toBeNull();
    expect(validateName('a')).not.toBeNull();
    expect(validateName('有 空白')).not.toBeNull();
    expect(validateName('這個名字實在是太長太長太長了')).not.toBeNull();
    expect(validateName(123)).not.toBeNull();
  });

  it('聊天內容會去除控制字元並截斷', () => {
    expect(sanitizeChatText('  你好\n世界  ')).toBe('你好 世界');
    expect(sanitizeChatText('   ')).toBe('');
    expect([...sanitizeChatText('啊'.repeat(500))]).toHaveLength(120);
    expect(sanitizeChatText(null)).toBe('');
  });
});

describe('帳號與密碼檢查', () => {
  it('帳號', () => {
    expect(validateUsername('star_01')).toBeNull();
    expect(validateUsername('ab')).not.toBeNull();
    expect(validateUsername('有中文')).not.toBeNull();
    expect(validateUsername('a'.repeat(21))).not.toBeNull();
  });

  it('密碼', () => {
    expect(validatePassword('12345678')).toBeNull();
    expect(validatePassword('1234567')).not.toBeNull();
    expect(validatePassword('a'.repeat(73))).not.toBeNull();
    // 中文字每個佔 3 個位元組，25 個字就超過 bcrypt 的 72 位元組上限
    expect(validatePassword('密'.repeat(25))).not.toBeNull();
  });
});

describe('職業與衍生能力值', () => {
  it('資料表有 6 個初始職業，起始道具都存在', () => {
    expect(CLASSES).toHaveLength(6);
    for (const cls of CLASSES) {
      for (const item of cls.startItems) {
        expect(getItemDef(item.itemId)).toBeDefined();
      }
    }
  });

  it('依 GDD 公式計算 MaxHP／MaxSP', () => {
    const cls = getClassDef('bladeguard')!;
    // (100 + 1×30) × 1.05 = 136.5 → 136；(30 + 1×4) × 1.05 = 35.7 → 35
    expect(computeMaxHp(cls, 1, newStats())).toBe(136);
    expect(computeMaxSp(cls, 1, newStats())).toBe(35);
  });
});

/** 測試用的編號產生器：u1、u2… */
function uidGen(): () => string {
  let n = 0;
  return () => `u${++n}`;
}

function stack(itemId: string, extra: Partial<ItemStack> = {}): ItemStack {
  return { uid: `s-${itemId}`, itemId, quantity: 1, refine: 0, cardSlots: 0, cards: [], ...extra };
}

describe('容器（背包、倉庫）', () => {
  it('先堆疊再放空格，並依格子排序', () => {
    const inv: InventoryItem[] = [{ ...stack('potion_hp_s', { uid: 'a', quantity: 95 }), slot: 1 }];
    expect(addToContainer(inv, 40, { itemId: 'potion_hp_s', quantity: 10 }, uidGen())).toBe(true);
    expect(inv.map((i) => [i.slot, i.quantity, i.uid])).toEqual([
      [0, 6, 'u1'],
      [1, 99, 'a'],
    ]);
  });

  it('不可堆疊的道具各佔一格、各有編號', () => {
    const inv: InventoryItem[] = [];
    expect(addToContainer(inv, 40, { itemId: 'novice_sword', quantity: 2 }, uidGen())).toBe(true);
    expect(inv.map((i) => [i.slot, i.uid])).toEqual([[0, 'u1'], [1, 'u2']]);
  });

  it('放不下時完全不變動；不存在的道具或不合法的數量會失敗', () => {
    const inv: InventoryItem[] = [{ ...stack('novice_sword'), slot: 0 }];
    const before = cloneItems(inv);
    expect(addToContainer(inv, 2, { itemId: 'novice_sword', quantity: 2 }, uidGen())).toBe(false);
    expect(addToContainer(inv, 40, { itemId: 'no_such_item', quantity: 1 }, uidGen())).toBe(false);
    expect(addToContainer(inv, 40, { itemId: 'potion_hp_s', quantity: -3 }, uidGen())).toBe(false);
    expect(inv).toEqual(before);
  });

  it('取出：數量不足或格子不存在時不變動', () => {
    const inv: InventoryItem[] = [{ ...stack('potion_hp_s', { uid: 'a', quantity: 5 }), slot: 3 }];
    expect(takeFromSlot(inv, 3, 6)).toBeNull();
    expect(takeFromSlot(inv, 9, 1)).toBeNull();
    expect(takeFromSlot(inv, 3, 2)?.quantity).toBe(2);
    expect(inv[0]!.quantity).toBe(3);
    expect(takeFromSlot(inv, 3, 3)?.uid).toBe('a');
    expect(inv).toHaveLength(0);
  });

  it('依道具代號跨格扣除', () => {
    const inv: InventoryItem[] = [
      { ...stack('sand_starsteel', { uid: 'a', quantity: 2 }), slot: 0 },
      { ...stack('sand_starsteel', { uid: 'b', quantity: 3 }), slot: 1 },
    ];
    expect(takeByItemId(inv, 'sand_starsteel', 6)).toBe(false);
    expect(takeByItemId(inv, 'sand_starsteel', 4)).toBe(true);
    expect(inv.map((i) => [i.uid, i.quantity])).toEqual([['b', 1]]);
  });

  it('搬移整疊到空格時編號跟著走；目的地放不下時兩邊都不變', () => {
    const bag: InventoryItem[] = [{ ...stack('novice_sword', { uid: 'sword', refine: 4 }), slot: 2 }];
    const storage: InventoryItem[] = [];
    expect(moveBetween(bag, storage, 60, 2, 1, uidGen())?.uid).toBe('sword');
    expect(bag).toHaveLength(0);
    expect(storage).toEqual([{ ...stack('novice_sword', { uid: 'sword', refine: 4 }), slot: 0 }]);
    expect(moveBetween(storage, bag, 0, 0, 1, uidGen())).toBeNull();
    expect(storage).toHaveLength(1);
  });
});

describe('裝備、精煉與卡片', () => {
  const bladeguard = getClassDef('bladeguard')!;

  it('職業與等級限制', () => {
    expect(equipError(itemDef('novice_sword'), bladeguard, 1)).toBeNull();
    expect(equipError(itemDef('novice_staff'), bladeguard, 1)).not.toBeNull();
    expect(equipError(itemDef('wooden_dagger'), bladeguard, 4)).not.toBeNull();
    expect(equipError(itemDef('potion_hp_s'), bladeguard, 99)).not.toBeNull();
  });

  it('精煉表與費用符合 GDD', () => {
    expect(REFINE_TABLE).toHaveLength(10);
    expect(REFINE_TABLE[3]!.rate).toBe(100);
    expect(REFINE_TABLE[6]).toEqual({ rate: 50, feePerLevel: 250, downgrade: true });
    expect(refineFee(itemDef('wooden_dagger')!.equip!, 4)).toBe(500);
    expect(weaponRefineMultiplier(6)).toBeCloseTo(1.24);
    expect(weaponRefineMultiplier(10)).toBeCloseTo(1.48);
  });

  it('武器精煉、防具精煉與卡片都會反映在加成上', () => {
    const totals = computeEquipTotals([
      stack('novice_sword', { refine: 5 }),
      stack('novice_tunic', { refine: 4, cardSlots: 1, cards: ['card_bobolu'] }),
      stack('charm_fluffytail', { cardSlots: 1, cards: ['card_fluffytail'] }),
    ]);
    expect(totals.weaponAtk).toBe(Math.floor(12 * 1.2));
    expect(totals.def).toBe(Math.floor(4 * 1.12));
    expect(totals.maxHp).toBe(20 + 60);
    expect(totals.maxHpPct).toBeCloseTo(0.02);
    expect(totals.stats.for).toBe(3);
    expect(totals.maxSp).toBe(10);
  });

  it('沒有武器時攻擊力大幅下降；裝備的素質加成會代入公式', () => {
    const bare = computePlayerCombatStats(bladeguard, 1, newStats());
    const armed = computePlayerCombatStats(bladeguard, 1, newStats(), [stack('novice_sword')]);
    expect(bare.atk).toBe(3 + 10 + 2);
    expect(armed.atk).toBe(24);
    const lucky = computePlayerCombatStats(bladeguard, 1, newStats(), [stack('charm_fluffytail')]);
    expect(lucky.totalStats.for).toBe(6);
    expect(lucky.crit).toBeCloseTo(1 + 6 * 0.3);
  });

  it('顯示名稱包含精煉等級與卡槽', () => {
    expect(itemDisplayName(stack('novice_sword', { refine: 4, cardSlots: 2, cards: ['card_bobolu'] }))).toBe('+4 見習長劍 [1/2]');
    expect(itemDisplayName(stack('potion_hp_s'))).toBe('小瓶療傷露');
  });
});

describe('資料表完整性', () => {
  it('魔物掉落、職業技能與起始道具的參照都存在', () => {
    expect(validateGameData()).toEqual([]);
    expect(MONSTERS.length).toBeGreaterThanOrEqual(3);
  });
});

describe('經驗值與素質配點', () => {
  it('升級所需經驗符合 GDD 公式', () => {
    expect(expToNext(1)).toBe(100);
    expect(expToNext(10)).toBe(10647);
  });

  it('可連升多級，剩餘經驗保留', () => {
    // 1→2 需 100，2→3 需 331
    expect(applyExp(1, 0, 100 + 331 + 5)).toEqual({ level: 3, exp: 5, levelsGained: 2 });
    expect(applyExp(1, 90, 5)).toEqual({ level: 1, exp: 95, levelsGained: 0 });
    expect(applyExp(100, 0, 999999)).toEqual({ level: 100, exp: 0, levelsGained: 0 });
  });

  it('等級差經驗倍率', () => {
    expect(expLevelModifier(1, 6)).toBe(1.1);
    expect(expLevelModifier(5, 5)).toBe(1);
    expect(expLevelModifier(10, 3)).toBe(0.7);
    expect(expLevelModifier(30, 1)).toBe(0.1);
  });

  it('素質花費遞增，點數不足或已達上限時不變動', () => {
    expect(statCost(5)).toBe(1);
    expect(statCost(10)).toBe(2);
    expect(statCost(99)).toBe(10);
    const stats = newStats();
    expect(allocateStat(stats, 10, 'pow')).toBe(1);
    expect(stats.pow).toBe(6);
    stats.pow = 20;
    expect(allocateStat(stats, 2, 'pow')).toBeNull();
    expect(stats.pow).toBe(20);
    stats.con = 100;
    expect(allocateStat(stats, 999, 'con')).toBeNull();
  });
});

describe('傷害公式', () => {
  const bladeguard = getClassDef('bladeguard')!;
  const starcaller = getClassDef('starcaller')!;
  const sword = [stack('novice_sword')];
  const staff = [stack('novice_staff')];
  const bobolu = monsterCombatant(getMonsterDef('bobolu')!);
  /** 依序回傳指定數值的假亂數 */
  const seq = (...values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length]!;
  };

  it('玩家戰鬥數值符合 GDD 公式', () => {
    const s = computePlayerCombatStats(bladeguard, 1, newStats(), sword);
    // 12 + 5×2 + 0 + 2 + 0 = 24
    expect(s.atk).toBe(24);
    expect(s.hit).toBe(11);
    expect(s.eva).toBe(11);
    expect(s.crit).toBeCloseTo(2.5);
    expect(s.maxHp).toBe(136);
    // 750 × (1 − (5×0.004 + 5×0.001)) = 731.25 → 731
    expect(s.attackIntervalMs).toBe(731);
  });

  it('命中率介於 5%–95%', () => {
    const player = computePlayerCombatStats(bladeguard, 1, newStats(), sword);
    expect(hitRate(player, bobolu)).toBeCloseTo(89.5);
    expect(hitRate({ ...player, hit: 0 }, { ...bobolu, eva: 999 })).toBe(5);
    expect(hitRate({ ...player, hit: 999 }, bobolu)).toBe(95);
  });

  it('物理攻擊：未暴擊、命中、無浮動時的傷害', () => {
    const player = computePlayerCombatStats(bladeguard, 1, newStats(), sword);
    // 亂數依序用於：暴擊（0.99 不暴擊）、命中（0 命中）、浮動（0.5 即 ×1）
    const result = rollAttack(player, bobolu, { kind: 'physical', element: 'neutral', power: 1 }, seq(0.99, 0, 0.5));
    // 24 × 1 × 體型修正 0.85 × 100/101 = 20.19 → 20
    expect(result).toEqual({ miss: false, crit: false, damage: 20 });
  });

  it('暴擊必定命中且傷害 ×1.5；未命中時傷害為 0', () => {
    const player = computePlayerCombatStats(bladeguard, 1, newStats(), sword);
    const crit = rollAttack(player, bobolu, { kind: 'physical', element: 'neutral', power: 1 }, seq(0, 0.5));
    expect(crit).toEqual({ miss: false, crit: true, damage: 30 });
    const miss = rollAttack(player, bobolu, { kind: 'physical', element: 'neutral', power: 1 }, seq(0.99, 0.99));
    expect(miss).toEqual({ miss: true, crit: false, damage: 0 });
  });

  it('魔法必中、不暴擊，並套用屬性相剋', () => {
    const player = computePlayerCombatStats(starcaller, 1, newStats(), staff);
    // 魔攻 12 + 10 = 22；啵啵露是潮屬性
    const flame = rollAttack(player, bobolu, { kind: 'magical', element: 'flame', power: 1.6 }, seq(0.5));
    expect(flame).toEqual({ miss: false, crit: false, damage: Math.floor(22 * 1.6 * 0.5) });
    const storm = rollAttack(player, bobolu, { kind: 'magical', element: 'storm', power: 1 }, seq(0.5));
    expect(storm.damage).toBe(22);
    expect(ELEMENT_TABLE.rock.tide).toBe(1.5);
    expect(ELEMENT_TABLE.radiant.eclipse).toBe(1.5);
    expect(ELEMENT_TABLE.tide.tide).toBe(0.25);
  });

  it('傷害至少為 1', () => {
    const player = computePlayerCombatStats(bladeguard, 1, newStats(), sword);
    const tank = { ...bobolu, def: 100000 };
    expect(rollAttack(player, tank, { kind: 'physical', element: 'neutral', power: 1 }, seq(0.99, 0, 0.5)).damage).toBe(1);
  });
});

describe('魔物重生區', () => {
  it('解析 monster_spawns 物件層', () => {
    const map: TiledMap = {
      type: 'map', orientation: 'isometric', width: 10, height: 10, tilewidth: 64, tileheight: 32,
      tilesets: [],
      layers: [{
        type: 'objectgroup', id: 1, name: 'monster_spawns', visible: true, opacity: 1, x: 0, y: 0,
        objects: [{
          id: 1, name: 'bobolu_a', x: 64, y: 96, width: 160, height: 128,
          properties: [
            { name: 'count', type: 'int', value: 4 },
            { name: 'monsterId', type: 'string', value: 'bobolu' },
          ],
        }],
      }],
    };
    expect(findMonsterSpawns(map)).toEqual([
      { name: 'bobolu_a', x: 2, y: 3, width: 5, height: 4, monsterId: 'bobolu', count: 4 },
    ]);
  });
});

describe('組隊經驗', () => {
  it('每多 1 人總量 +10%，再平分', () => {
    expect(partyExpShare(100, 1)).toBe(100);
    expect(partyExpShare(100, 2)).toBeCloseTo(55);
    expect(partyExpShare(100, 6)).toBeCloseTo(25);
  });
});

describe('任務', () => {
  it('任務資料的參照都存在', () => {
    expect(validateQuests()).toEqual([]);
    expect(QUESTS.length).toBeGreaterThanOrEqual(4);
  });

  it('接任務的條件：等級、前置任務、不可重複', () => {
    const first = getQuestDef('q_first_steps')!;
    const second = getQuestDef('q_sticky_business')!;
    const mushroom = getQuestDef('q_mushroom_menace')!;
    expect(questAcceptError(first, 1, new Set(), new Set())).toBeNull();
    expect(questAcceptError(first, 1, new Set(['q_first_steps']), new Set())).not.toBeNull();
    expect(questAcceptError(first, 1, new Set(), new Set(['q_first_steps']))).not.toBeNull();
    expect(questAcceptError(second, 1, new Set(), new Set())).not.toBeNull();
    expect(questAcceptError(second, 1, new Set(), new Set(['q_first_steps']))).toBeNull();
    expect(questAcceptError(mushroom, 2, new Set(), new Set())).not.toBeNull();
  });

  it('擊殺目標看進度，收集目標看背包數量', () => {
    const kill = getQuestDef('q_first_steps')!;
    expect(objectiveCounts(kill, [3], () => 0)).toEqual([3]);
    expect(isQuestReady(kill, [4], () => 0)).toBe(false);
    expect(isQuestReady(kill, [5], () => 0)).toBe(true);
    const collect = getQuestDef('q_sticky_business')!;
    expect(objectiveCounts(collect, [], () => 9)).toEqual([5]);
    expect(isQuestReady(collect, [], (id) => (id === 'mat_sticky_dew' ? 4 : 99))).toBe(false);
    expect(isQuestReady(collect, [], () => 5)).toBe(true);
  });
});
