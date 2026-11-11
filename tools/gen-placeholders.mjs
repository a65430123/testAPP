// 產生佔位美術（PNG）與示範地圖（Tiled JSON）。不需要任何第三方套件。
//
// 用法：
//   node tools/gen-placeholders.mjs              只重新產生 PNG；地圖檔不存在時才產生地圖
//   node tools/gen-placeholders.mjs --force-map  連地圖也重新產生（會覆蓋你在 Tiled 裡的修改）

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TILESET_DIR = resolve(ROOT, 'client/public/assets/tilesets');
const SPRITE_DIR = resolve(ROOT, 'client/public/assets/sprites');
const MAP_PATH = resolve(ROOT, 'shared/maps/f01_sprout_meadow.json');

const TILE_W = 64;
const TILE_H = 32;
const PROP_H = 96;

// ---------------------------------------------------------------- 亂數（固定種子，確保每次產生結果相同）

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 簡易點陣繪圖

class Image {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  /** 畫一個像素（含 alpha 混合） */
  set(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    const srcA = a / 255;
    const dstA = d[i + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA === 0) return;
    d[i] = Math.round((r * srcA + d[i] * dstA * (1 - srcA)) / outA);
    d[i + 1] = Math.round((g * srcA + d[i + 1] * dstA * (1 - srcA)) / outA);
    d[i + 2] = Math.round((b * srcA + d[i + 2] * dstA * (1 - srcA)) / outA);
    d[i + 3] = Math.round(outA * 255);
  }

  alphaAt(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.data[(y * this.width + x) * 4 + 3];
  }

  /** 把已存在的像素調暗（factor < 1）或調亮（factor > 1） */
  shade(x, y, factor) {
    if (this.alphaAt(x, y) === 0) return;
    const i = (y * this.width + x) * 4;
    for (let c = 0; c < 3; c++) {
      this.data[i + c] = Math.max(0, Math.min(255, Math.round(this.data[i + c] * factor)));
    }
  }

  fillRect(x0, y0, w, h, color) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) this.set(x, y, color);
    }
  }

  fillEllipse(cx, cy, rx, ry, color) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const nx = (x + 0.5 - cx) / rx;
        const ny = (y + 0.5 - cy) / ry;
        if (nx * nx + ny * ny <= 1) this.set(x, y, color);
      }
    }
  }

  /** 掃描線填滿多邊形（以像素中心判定） */
  fillPolygon(points, color) {
    const ys = points.map((p) => p[1]);
    const minY = Math.floor(Math.min(...ys));
    const maxY = Math.ceil(Math.max(...ys));
    for (let y = minY; y < maxY; y++) {
      const sy = y + 0.5;
      const xs = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        if ((y1 <= sy && y2 > sy) || (y2 <= sy && y1 > sy)) {
          xs.push(x1 + ((sy - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.ceil(xs[k] - 0.5); x + 0.5 <= xs[k + 1]; x++) this.set(x, y, color);
      }
    }
  }
}

// ---------------------------------------------------------------- PNG 編碼

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(img) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(img.width, 0);
  header.writeUInt32BE(img.height, 4);
  header[8] = 8; // 位元深度
  header[9] = 6; // RGBA
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0; // 每列的濾波方式：None
    Buffer.from(img.data.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function writePng(path, img) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(img));
  console.log(`已產生 ${path}（${img.width}×${img.height}）`);
}

// ---------------------------------------------------------------- 地面圖磚集（6 格，每格 64×32 菱形）

const GROUND_TILES = ['grass_a', 'grass_b', 'grass_flower', 'dirt', 'sand', 'water'];

function drawGroundTileset() {
  const img = new Image(TILE_W * GROUND_TILES.length, TILE_H);
  const rand = mulberry32(1001);
  const base = {
    grass_a: [116, 190, 96],
    grass_b: [104, 180, 90],
    grass_flower: [116, 190, 96],
    dirt: [188, 150, 104],
    sand: [232, 214, 160],
    water: [86, 156, 222],
  };
  const speck = {
    grass_a: [[92, 166, 80], [140, 208, 112]],
    grass_b: [[84, 158, 76], [128, 198, 104]],
    grass_flower: [[92, 166, 80], [140, 208, 112]],
    dirt: [[166, 128, 86], [204, 170, 124]],
    sand: [[214, 194, 140], [244, 230, 184]],
    water: [[70, 138, 206], [120, 184, 238]],
  };

  GROUND_TILES.forEach((name, index) => {
    const ox = index * TILE_W;
    img.fillPolygon(
      [[ox + 32, 0], [ox + 64, 16], [ox + 32, 32], [ox, 16]],
      base[name],
    );
    // 雜點紋理
    for (let i = 0; i < 46; i++) {
      const x = ox + Math.floor(rand() * TILE_W);
      const y = Math.floor(rand() * TILE_H);
      if (img.alphaAt(x, y) === 0) continue;
      const color = speck[name][i % 2];
      img.set(x, y, color);
      if (name === 'water' && img.alphaAt(x + 1, y) !== 0 && img.alphaAt(x + 2, y) !== 0) {
        // 水面用短橫線表現波紋
        img.set(x + 1, y, color);
        img.set(x + 2, y, color);
      }
    }
    if (name === 'grass_flower') {
      const petals = [[250, 236, 120], [250, 170, 190], [255, 255, 255]];
      for (const [fx, fy, c] of [[20, 14, 0], [34, 8, 1], [42, 20, 2], [30, 24, 1], [50, 14, 0]]) {
        img.set(ox + fx, fy, petals[c]);
        img.set(ox + fx + 1, fy, petals[c]);
        img.set(ox + fx, fy + 1, petals[c]);
        img.set(ox + fx + 1, fy + 1, petals[c]);
      }
    }
    // 下緣調暗，讓格線隱約可見
    for (let y = 0; y < TILE_H; y++) {
      for (let x = ox; x < ox + TILE_W; x++) {
        if (img.alphaAt(x, y) !== 0 && (y === TILE_H - 1 || img.alphaAt(x, y + 1) === 0)) {
          img.shade(x, y, 0.9);
        }
      }
    }
  });
  return img;
}

// ---------------------------------------------------------------- 物件圖磚集（3 格，每格 64×96，底部對齊地面菱形）

const PROP_TILES = ['tree', 'rock', 'bush'];

function drawPropsTileset() {
  const img = new Image(TILE_W * PROP_TILES.length, PROP_H);
  const shadow = [20, 40, 30, 70];
  const groundY = PROP_H - TILE_H / 2; // 物件所站菱形的中心 y

  // 樹
  {
    const ox = 0;
    img.fillEllipse(ox + 32, groundY, 22, 9, shadow);
    img.fillRect(ox + 28, 50, 8, 31, [124, 84, 52]);
    img.fillRect(ox + 28, 50, 3, 31, [104, 68, 42]);
    img.fillEllipse(ox + 32, 36, 26, 28, [58, 138, 78]);
    img.fillEllipse(ox + 28, 30, 20, 20, [78, 164, 92]);
    img.fillEllipse(ox + 24, 24, 10, 9, [112, 192, 116]);
  }
  // 石頭
  {
    const ox = TILE_W;
    img.fillEllipse(ox + 32, groundY + 2, 22, 8, shadow);
    img.fillEllipse(ox + 32, 72, 19, 13, [128, 134, 146]);
    img.fillEllipse(ox + 29, 68, 14, 9, [158, 164, 176]);
    img.fillEllipse(ox + 25, 65, 6, 3, [192, 198, 208]);
  }
  // 灌木
  {
    const ox = TILE_W * 2;
    img.fillEllipse(ox + 32, groundY + 2, 22, 8, shadow);
    img.fillEllipse(ox + 24, 72, 13, 11, [66, 150, 84]);
    img.fillEllipse(ox + 40, 73, 13, 10, [66, 150, 84]);
    img.fillEllipse(ox + 32, 66, 14, 12, [88, 172, 98]);
    for (const [bx, by] of [[26, 68], [36, 62], [42, 72], [30, 76]]) {
      img.fillEllipse(ox + bx, by, 2, 2, [222, 78, 96]);
    }
  }
  return img;
}

// ---------------------------------------------------------------- 玩家佔位圖（3 欄 × 2 列，每格 32×48）
// 第 0 列：正面（待機、走路 A、走路 B）；第 1 列：背面（同上）

const PLAYER_W = 32;
const PLAYER_H = 48;

function drawPlayerSheet() {
  const img = new Image(PLAYER_W * 3, PLAYER_H * 2);
  const skin = [250, 216, 184];
  const hair = [112, 70, 48];
  const tunic = [70, 120, 210];
  const tunicDark = [52, 94, 176];
  const boots = [86, 60, 44];

  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const ox = col * PLAYER_W;
      const oy = row * PLAYER_H;
      const bob = col === 0 ? 0 : -1; // 走路時身體微微上移
      const leftLift = col === 1 ? 3 : 0;
      const rightLift = col === 2 ? 3 : 0;

      img.fillEllipse(ox + 16, oy + 44, 9, 3, [20, 30, 40, 90]); // 影子
      img.fillRect(ox + 11, oy + 36, 4, 8 - leftLift, boots); // 左腳
      img.fillRect(ox + 17, oy + 36, 4, 8 - rightLift, boots); // 右腳
      img.fillEllipse(ox + 16, oy + 30 + bob, 8, 9, tunic); // 身體
      img.fillRect(ox + 9, oy + 33 + bob, 14, 2, tunicDark); // 腰帶
      img.fillEllipse(ox + 16, oy + 15 + bob, 9, 9, skin); // 頭
      if (row === 0) {
        img.fillEllipse(ox + 16, oy + 10 + bob, 10, 6, hair); // 瀏海
        img.fillRect(ox + 12, oy + 16 + bob, 2, 3, [40, 40, 60]); // 左眼
        img.fillRect(ox + 18, oy + 16 + bob, 2, 3, [40, 40, 60]); // 右眼
        img.fillRect(ox + 10, oy + 20 + bob, 2, 1, [244, 160, 160]); // 腮紅
        img.fillRect(ox + 20, oy + 20 + bob, 2, 1, [244, 160, 160]);
      } else {
        img.fillEllipse(ox + 16, oy + 14 + bob, 10, 10, hair); // 背面整顆後腦勺
      }
    }
  }
  return img;
}

// ---------------------------------------------------------------- 示範地圖：F01 嫩芽草原（40×40）

function buildMap() {
  const W = 40;
  const H = 40;
  const rand = mulberry32(20261111);
  const GID = { grassA: 1, grassB: 2, grassFlower: 3, dirt: 4, sand: 5, water: 6, tree: 7, rock: 8, bush: 9 };
  const spawn = { x: 20, y: 20 };

  const ground = new Array(W * H).fill(0);
  const props = new Array(W * H).fill(0);
  const idx = (x, y) => y * W + x;

  // 1. 草地
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = rand();
      ground[idx(x, y)] = r < 0.08 ? GID.grassFlower : r < 0.54 ? GID.grassA : GID.grassB;
    }
  }
  // 2. 東西向蜿蜒小路與通往北邊的小路
  for (let x = 2; x <= 37; x++) {
    const y = Math.round(20 + 4 * Math.sin(x / 5));
    ground[idx(x, y)] = GID.dirt;
    ground[idx(x, y + 1)] = GID.dirt;
  }
  for (let y = 2; y <= 20; y++) {
    ground[idx(20, y)] = GID.dirt;
    ground[idx(21, y)] = GID.dirt;
  }
  // 3. 池塘（水面不可行走）與沙岸
  const pond = { x: 30, y: 9 };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - pond.x, (y - pond.y) * 1.15);
      if (d <= 3.6) ground[idx(x, y)] = GID.water;
      else if (d <= 5) ground[idx(x, y)] = GID.sand;
    }
  }
  // 4. 物件：外圈樹牆、小樹林、零星的樹／石頭／灌木
  const isGrass = (x, y) => ground[idx(x, y)] <= GID.grassFlower;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      if (border) {
        ground[idx(x, y)] = GID.grassB;
        props[idx(x, y)] = GID.tree;
        continue;
      }
      if (!isGrass(x, y)) continue;
      if (Math.hypot(x - spawn.x, y - spawn.y) < 3.5) continue;
      const inGrove = x >= 7 && x <= 13 && y >= 7 && y <= 13;
      const r = rand();
      if (inGrove) {
        if (r < 0.4) props[idx(x, y)] = GID.tree;
      } else if (r < 0.05) props[idx(x, y)] = GID.tree;
      else if (r < 0.07) props[idx(x, y)] = GID.rock;
      else if (r < 0.1) props[idx(x, y)] = GID.bush;
    }
  }

  return {
    compressionlevel: -1,
    width: W,
    height: H,
    infinite: false,
    orientation: 'isometric',
    renderorder: 'right-down',
    tiledversion: '1.11.0',
    version: '1.10',
    type: 'map',
    tilewidth: TILE_W,
    tileheight: TILE_H,
    nextlayerid: 4,
    nextobjectid: 2,
    properties: [
      { name: 'mapId', type: 'string', value: 'F01' },
      { name: 'displayName', type: 'string', value: '嫩芽草原' },
    ],
    layers: [
      { id: 1, name: 'ground', type: 'tilelayer', width: W, height: H, x: 0, y: 0, opacity: 1, visible: true, data: ground },
      { id: 2, name: 'props', type: 'tilelayer', width: W, height: H, x: 0, y: 0, opacity: 1, visible: true, data: props },
      {
        id: 3,
        name: 'spawns',
        type: 'objectgroup',
        draworder: 'topdown',
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        objects: [
          {
            id: 1,
            name: 'player_spawn',
            type: 'spawn',
            point: true,
            rotation: 0,
            visible: true,
            // 斜視角地圖的物件座標以 tileheight 像素為 1 格
            x: (spawn.x + 0.5) * TILE_H,
            y: (spawn.y + 0.5) * TILE_H,
            width: 0,
            height: 0,
          },
        ],
      },
    ],
    tilesets: [
      {
        firstgid: 1,
        name: 'ground',
        image: '../../client/public/assets/tilesets/ground.png',
        imagewidth: TILE_W * GROUND_TILES.length,
        imageheight: TILE_H,
        tilewidth: TILE_W,
        tileheight: TILE_H,
        tilecount: GROUND_TILES.length,
        columns: GROUND_TILES.length,
        margin: 0,
        spacing: 0,
        tiles: [{ id: GID.water - 1, properties: [{ name: 'blocked', type: 'bool', value: true }] }],
      },
      {
        firstgid: 1 + GROUND_TILES.length,
        name: 'props',
        image: '../../client/public/assets/tilesets/props.png',
        imagewidth: TILE_W * PROP_TILES.length,
        imageheight: PROP_H,
        tilewidth: TILE_W,
        tileheight: PROP_H,
        tilecount: PROP_TILES.length,
        columns: PROP_TILES.length,
        margin: 0,
        spacing: 0,
      },
    ],
  };
}

// ---------------------------------------------------------------- 主程式

writePng(resolve(TILESET_DIR, 'ground.png'), drawGroundTileset());
writePng(resolve(TILESET_DIR, 'props.png'), drawPropsTileset());
writePng(resolve(SPRITE_DIR, 'player.png'), drawPlayerSheet());

if (!existsSync(MAP_PATH) || process.argv.includes('--force-map')) {
  mkdirSync(dirname(MAP_PATH), { recursive: true });
  writeFileSync(MAP_PATH, JSON.stringify(buildMap()) + '\n');
  console.log(`已產生 ${MAP_PATH}`);
} else {
  console.log(`地圖已存在，略過（要覆蓋請加 --force-map）：${MAP_PATH}`);
}
