import { describe, expect, it } from 'vitest';
import {
  advanceMove,
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
