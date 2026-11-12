// 產生佔位美術（PNG）與示範地圖（Tiled JSON）。不需要任何第三方套件。
//
// 用法：
//   node tools/gen-placeholders.mjs              只重新產生 PNG；地圖檔不存在時才產生該地圖
//   node tools/gen-placeholders.mjs --force-map  連地圖也重新產生（會覆蓋你在 Tiled 裡的修改）

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TILESET_DIR = resolve(ROOT, 'client/public/assets/tilesets');
const SPRITE_DIR = resolve(ROOT, 'client/public/assets/sprites');
const MAP_DIR = resolve(ROOT, 'shared/maps');

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

// ---------------------------------------------------------------- 地面圖磚集（7 格，每格 64×32 菱形）

const GROUND_TILES = ['grass_a', 'grass_b', 'grass_flower', 'dirt', 'sand', 'water', 'stone'];

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
    stone: [186, 190, 198],
  };
  const speck = {
    grass_a: [[92, 166, 80], [140, 208, 112]],
    grass_b: [[84, 158, 76], [128, 198, 104]],
    grass_flower: [[92, 166, 80], [140, 208, 112]],
    dirt: [[166, 128, 86], [204, 170, 124]],
    sand: [[214, 194, 140], [244, 230, 184]],
    water: [[70, 138, 206], [120, 184, 238]],
    stone: [[166, 170, 180], [204, 208, 214]],
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

// ---------------------------------------------------------------- 物件圖磚集（5 格，每格 64×96，底部對齊地面菱形）

const PROP_TILES = ['tree', 'rock', 'bush', 'house', 'crate'];

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
  // 小屋（佔滿一格：兩面牆 + 四角錐屋頂）
  {
    const ox = TILE_W * 3;
    img.fillPolygon([[ox, 80], [ox + 32, 96], [ox + 32, 68], [ox, 52]], [214, 196, 160]);
    img.fillPolygon([[ox + 32, 96], [ox + 64, 80], [ox + 64, 52], [ox + 32, 68]], [238, 222, 188]);
    img.fillPolygon([[ox + 10, 71], [ox + 20, 76], [ox + 20, 66], [ox + 10, 61]], [150, 204, 232]);
    img.fillPolygon([[ox + 42, 91], [ox + 52, 86], [ox + 52, 70], [ox + 42, 75]], [124, 84, 52]);
    img.fillPolygon([[ox, 52], [ox + 32, 68], [ox + 32, 14]], [178, 74, 66]);
    img.fillPolygon([[ox + 32, 68], [ox + 64, 52], [ox + 32, 14]], [212, 96, 82]);
  }
  // 木箱
  {
    const ox = TILE_W * 4;
    img.fillEllipse(ox + 32, groundY + 4, 22, 8, shadow);
    img.fillPolygon([[ox + 16, 68], [ox + 32, 76], [ox + 32, 92], [ox + 16, 84]], [150, 108, 66]);
    img.fillPolygon([[ox + 32, 76], [ox + 48, 68], [ox + 48, 84], [ox + 32, 92]], [176, 130, 82]);
    img.fillPolygon([[ox + 32, 60], [ox + 48, 68], [ox + 32, 76], [ox + 16, 68]], [204, 160, 106]);
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

// ---------------------------------------------------------------- 魔物佔位圖（每格 48×48，腳底在 y=42）
// 格子順序對應 shared/data/monsters.json 的 sprite 欄位

const MONSTER_SIZE = 48;

function drawMonsterSheet() {
  const img = new Image(MONSTER_SIZE * 6, MONSTER_SIZE);
  const shadow = [20, 30, 40, 80];
  const eye = [30, 34, 50];

  // 0：啵啵露（水滴）
  {
    const ox = 0;
    img.fillEllipse(ox + 24, 42, 13, 4, shadow);
    img.fillPolygon([[ox + 24, 8], [ox + 34, 26], [ox + 14, 26]], [110, 190, 240]);
    img.fillEllipse(ox + 24, 30, 13, 12, [110, 190, 240]);
    img.fillEllipse(ox + 19, 25, 4, 5, [190, 232, 255]);
    img.fillRect(ox + 19, 31, 2, 4, eye);
    img.fillRect(ox + 27, 31, 2, 4, eye);
  }
  // 1：絨尾兔
  {
    const ox = MONSTER_SIZE;
    img.fillEllipse(ox + 24, 42, 13, 4, shadow);
    img.fillEllipse(ox + 18, 12, 3, 9, [250, 244, 236]);
    img.fillEllipse(ox + 28, 12, 3, 9, [250, 244, 236]);
    img.fillEllipse(ox + 18, 13, 1.5, 6, [246, 180, 190]);
    img.fillEllipse(ox + 28, 13, 1.5, 6, [246, 180, 190]);
    img.fillEllipse(ox + 24, 32, 12, 11, [250, 244, 236]);
    img.fillEllipse(ox + 36, 36, 5, 5, [255, 255, 255]);
    img.fillRect(ox + 19, 28, 2, 3, eye);
    img.fillRect(ox + 27, 28, 2, 3, eye);
    img.fillRect(ox + 23, 33, 2, 2, [240, 150, 160]);
  }
  // 2：芽芽菇
  {
    const ox = MONSTER_SIZE * 2;
    img.fillEllipse(ox + 24, 42, 13, 4, shadow);
    img.fillRect(ox + 18, 26, 12, 16, [244, 232, 208]);
    img.fillEllipse(ox + 24, 20, 17, 12, [214, 84, 74]);
    img.fillRect(ox + 7, 22, 34, 6, [214, 84, 74]);
    img.fillEllipse(ox + 16, 16, 3, 3, [255, 240, 230]);
    img.fillEllipse(ox + 30, 13, 4, 3, [255, 240, 230]);
    img.fillEllipse(ox + 24, 6, 2, 4, [112, 190, 110]);
    img.fillRect(ox + 20, 31, 2, 3, eye);
    img.fillRect(ox + 26, 31, 2, 3, eye);
  }
  // 3：竊糧鼠／5：地窖鼠王（同一個造型，鼠王多一頂王冠與金牙；用戶端會把鼠王放大）
  for (const [index, king] of [[3, false], [5, true]]) {
    const ox = MONSTER_SIZE * index;
    const fur = king ? [112, 96, 110] : [150, 146, 156];
    const belly = king ? [150, 132, 146] : [198, 194, 200];
    img.fillEllipse(ox + 24, 42, 14, 4, shadow);
    img.fillRect(ox + 36, 36, 9, 2, [226, 168, 170]); // 尾巴
    img.fillEllipse(ox + 16, 18, 5, 5, fur); // 耳朵
    img.fillEllipse(ox + 32, 18, 5, 5, fur);
    img.fillEllipse(ox + 16, 18, 2.5, 2.5, [226, 168, 170]);
    img.fillEllipse(ox + 32, 18, 2.5, 2.5, [226, 168, 170]);
    img.fillEllipse(ox + 24, 31, 13, 11, fur);
    img.fillEllipse(ox + 24, 35, 8, 6, belly);
    img.fillRect(ox + 19, 27, 2, 3, king ? [220, 60, 60] : eye);
    img.fillRect(ox + 27, 27, 2, 3, king ? [220, 60, 60] : eye);
    img.fillRect(ox + 23, 32, 2, 2, [240, 150, 160]);
    if (king) {
      img.fillRect(ox + 23, 34, 2, 3, [250, 210, 70]); // 金牙
      img.fillRect(ox + 17, 10, 14, 4, [250, 210, 70]); // 王冠
      img.fillPolygon([[ox + 17, 10], [ox + 20, 4], [ox + 22, 10]], [250, 210, 70]);
      img.fillPolygon([[ox + 22, 10], [ox + 24, 3], [ox + 26, 10]], [250, 210, 70]);
      img.fillPolygon([[ox + 26, 10], [ox + 28, 4], [ox + 31, 10]], [250, 210, 70]);
    }
  }
  // 4：蛛網織娘
  {
    const ox = MONSTER_SIZE * 4;
    const body = [70, 58, 96];
    img.fillEllipse(ox + 24, 42, 14, 4, shadow);
    for (const side of [-1, 1]) {
      for (const [dy, reach] of [[-4, 15], [0, 17], [4, 15]]) {
        img.fillPolygon(
          [[ox + 24, 30 + dy], [ox + 24 + side * reach, 24 + dy * 2], [ox + 24 + side * (reach + 1), 40], [ox + 24 + side * (reach - 2), 40], [ox + 24 + side * (reach - 2), 27 + dy * 2]],
          [52, 44, 72],
        );
      }
    }
    img.fillEllipse(ox + 24, 32, 10, 9, body);
    img.fillEllipse(ox + 24, 22, 7, 6, body);
    img.fillEllipse(ox + 24, 33, 4, 4, [170, 96, 200]);
    img.fillRect(ox + 20, 21, 2, 2, [240, 90, 90]);
    img.fillRect(ox + 26, 21, 2, 2, [240, 90, 90]);
  }
  return img;
}

/** 掉落物圖示（24×24 的小袋子） */
function drawDropIcon() {
  const img = new Image(24, 24);
  img.fillEllipse(12, 21, 8, 2.5, [20, 30, 40, 80]);
  img.fillEllipse(12, 15, 8, 7, [196, 150, 92]);
  img.fillRect(9, 6, 6, 4, [196, 150, 92]);
  img.fillRect(8, 9, 8, 2, [120, 80, 50]);
  img.fillEllipse(9, 13, 2, 3, [226, 188, 134]);
  return img;
}

// ---------------------------------------------------------------- 示範地圖

const GID = {
  grassA: 1, grassB: 2, grassFlower: 3, dirt: 4, sand: 5, water: 6, stone: 7,
  tree: 8, rock: 9, bush: 10, house: 11, crate: 12,
};

/** 把地面／物件陣列、出生點與傳送點組成 Tiled JSON */
function makeTiledMap({ mapId, displayName, width, height, ground, props, spawn, portals, monsterSpawns = [], npcs = [] }) {
  let nextObjectId = 1;
  return {
    compressionlevel: -1,
    width,
    height,
    infinite: false,
    orientation: 'isometric',
    renderorder: 'right-down',
    tiledversion: '1.11.0',
    version: '1.10',
    type: 'map',
    tilewidth: TILE_W,
    tileheight: TILE_H,
    nextlayerid: 7,
    nextobjectid: 2 + portals.length + monsterSpawns.length + npcs.length,
    properties: [
      { name: 'displayName', type: 'string', value: displayName },
      { name: 'mapId', type: 'string', value: mapId },
    ],
    layers: [
      { id: 1, name: 'ground', type: 'tilelayer', width, height, x: 0, y: 0, opacity: 1, visible: true, data: ground },
      { id: 2, name: 'props', type: 'tilelayer', width, height, x: 0, y: 0, opacity: 1, visible: true, data: props },
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
            id: nextObjectId++,
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
      {
        id: 4,
        name: 'portals',
        type: 'objectgroup',
        draworder: 'topdown',
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        objects: portals.map((p) => ({
          id: nextObjectId++,
          name: p.name,
          type: 'portal',
          rotation: 0,
          visible: true,
          x: p.x * TILE_H,
          y: p.y * TILE_H,
          width: p.width * TILE_H,
          height: p.height * TILE_H,
          properties: [
            { name: 'targetMap', type: 'string', value: p.targetMap },
            { name: 'targetX', type: 'int', value: p.targetX },
            { name: 'targetY', type: 'int', value: p.targetY },
          ],
        })),
      },
      {
        id: 5,
        name: 'monster_spawns',
        type: 'objectgroup',
        draworder: 'topdown',
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        objects: monsterSpawns.map((m) => ({
          id: nextObjectId++,
          name: m.name,
          type: 'monster_spawn',
          rotation: 0,
          visible: true,
          x: m.x * TILE_H,
          y: m.y * TILE_H,
          width: m.width * TILE_H,
          height: m.height * TILE_H,
          properties: [
            { name: 'count', type: 'int', value: m.count },
            { name: 'monsterId', type: 'string', value: m.monsterId },
          ],
        })),
      },
      {
        id: 6,
        name: 'npcs',
        type: 'objectgroup',
        draworder: 'topdown',
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        objects: npcs.map((n) => ({
          id: nextObjectId++,
          name: n.npcId,
          type: 'npc',
          point: true,
          rotation: 0,
          visible: true,
          x: (n.x + 0.5) * TILE_H,
          y: (n.y + 0.5) * TILE_H,
          width: 0,
          height: 0,
          properties: [{ name: 'npcId', type: 'string', value: n.npcId }],
        })),
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

/** F01 嫩芽草原（40×40）：草原、小路、池塘，北端有通往曦芽鎮的傳送點 */
function buildF01() {
  const W = 40;
  const H = 40;
  const rand = mulberry32(20261111);
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
  // 2. 東西向蜿蜒小路與通往北邊傳送點的小路
  for (let x = 2; x <= 37; x++) {
    const y = Math.round(20 + 4 * Math.sin(x / 5));
    ground[idx(x, y)] = GID.dirt;
    ground[idx(x, y + 1)] = GID.dirt;
  }
  for (let y = 1; y <= 20; y++) {
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

  return makeTiledMap({
    mapId: 'F01',
    displayName: '嫩芽草原',
    width: W,
    height: H,
    ground,
    props,
    spawn,
    portals: [{ name: 'to_C01', x: 20, y: 1, width: 2, height: 1, targetMap: 'C01', targetX: 14, targetY: 26 }],
    // 入口附近與西南是被動的低等魔物，東側道路一帶有會主動攻擊的芽芽菇
    monsterSpawns: [
      { name: 'bobolu_north', monsterId: 'bobolu', count: 6, x: 2, y: 2, width: 16, height: 14 },
      { name: 'bobolu_southwest', monsterId: 'bobolu', count: 8, x: 3, y: 23, width: 15, height: 14 },
      { name: 'fluffytail_southeast', monsterId: 'fluffytail', count: 7, x: 23, y: 24, width: 14, height: 13 },
      { name: 'sproutcap_east', monsterId: 'sproutcap', count: 5, x: 27, y: 15, width: 11, height: 7 },
    ],
  });
}

/** C01 曦芽鎮（30×30）：石板廣場、幾間小屋，南端有通往嫩芽草原的傳送點 */
function buildC01() {
  const W = 30;
  const H = 30;
  const rand = mulberry32(101);
  const spawn = { x: 15, y: 15 };
  const ground = new Array(W * H).fill(0);
  const props = new Array(W * H).fill(0);
  const idx = (x, y) => y * W + x;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = rand();
      ground[idx(x, y)] = r < 0.12 ? GID.grassFlower : r < 0.56 ? GID.grassA : GID.grassB;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) {
        ground[idx(x, y)] = GID.grassB;
        props[idx(x, y)] = GID.tree;
      }
    }
  }
  // 石板廣場
  for (let y = 8; y <= 21; y++) {
    for (let x = 8; x <= 21; x++) ground[idx(x, y)] = GID.stone;
  }
  // 通往南門的泥土路
  for (let y = 22; y <= 28; y++) {
    ground[idx(14, y)] = GID.dirt;
    ground[idx(15, y)] = GID.dirt;
  }
  // 小屋、木箱與行道樹
  for (const [x, y] of [[9, 9], [12, 9], [17, 9], [20, 9], [9, 13], [20, 13], [9, 18], [20, 18]]) {
    props[idx(x, y)] = GID.house;
  }
  for (const [x, y] of [[10, 10], [19, 10], [10, 19], [19, 19], [12, 20]]) {
    props[idx(x, y)] = GID.crate;
  }
  for (const [x, y] of [[12, 23], [17, 23], [12, 26], [17, 26], [5, 5], [24, 5], [5, 24], [24, 24]]) {
    props[idx(x, y)] = GID.tree;
  }
  for (const [x, y] of [[4, 12], [25, 16], [6, 20], [23, 9]]) {
    props[idx(x, y)] = GID.bush;
  }

  return makeTiledMap({
    mapId: 'C01',
    displayName: '曦芽鎮',
    width: W,
    height: H,
    ground,
    props,
    spawn,
    portals: [
      { name: 'to_F01', x: 14, y: 28, width: 2, height: 1, targetMap: 'F01', targetX: 20, targetY: 3 },
      // 廣場東南角：通往鼠尾地窖的入口
      { name: 'to_D01', x: 21, y: 20, width: 1, height: 1, targetMap: 'D01', targetX: 3, targetY: 4 },
    ],
    // 廣場上的 NPC：旅團嚮導、雜貨商、鍛造師、倉庫管理員
    npcs: [
      { npcId: 'c01_guide', x: 17, y: 16 },
      { npcId: 'c01_grocer', x: 12, y: 12 },
      { npcId: 'c01_smith', x: 18, y: 12 },
      { npcId: 'c01_storage', x: 15, y: 11 },
    ],
  });
}

/** D01 鼠尾地窖（24×24）：石板地面的房間與走道，沒有地面的地方就是牆；最深處是鼠王的巢穴 */
function buildD01() {
  const W = 24;
  const H = 24;
  const ground = new Array(W * H).fill(0);
  const props = new Array(W * H).fill(0);
  const idx = (x, y) => y * W + x;
  const floor = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) ground[idx(x, y)] = GID.stone;
    }
  };
  floor(2, 2, 7, 7); // 入口
  floor(8, 4, 11, 5); // 走道
  floor(12, 2, 21, 9); // 鼠窩
  floor(16, 10, 17, 13); // 走道
  floor(10, 14, 21, 21); // 蛛巢
  floor(6, 17, 9, 18); // 走道
  floor(2, 13, 5, 21); // 鼠王的巢穴
  for (const [x, y] of [[6, 6], [13, 3], [20, 8], [14, 8], [11, 15], [20, 20], [15, 19], [2, 21], [5, 13]]) {
    props[idx(x, y)] = GID.crate;
  }
  return makeTiledMap({
    mapId: 'D01',
    displayName: '鼠尾地窖',
    width: W,
    height: H,
    ground,
    props,
    spawn: { x: 3, y: 4 },
    portals: [{ name: 'to_C01', x: 3, y: 2, width: 1, height: 1, targetMap: 'C01', targetX: 20, targetY: 21 }],
    monsterSpawns: [
      { name: 'grainthief_den', monsterId: 'grainthief', count: 7, x: 12, y: 2, width: 10, height: 8 },
      { name: 'webweaver_nest', monsterId: 'webweaver', count: 6, x: 10, y: 14, width: 12, height: 8 },
      { name: 'gru_lair', monsterId: 'cellarking_gru', count: 1, x: 2, y: 15, width: 4, height: 6 },
    ],
  });
}

// ---------------------------------------------------------------- 主程式

writePng(resolve(TILESET_DIR, 'ground.png'), drawGroundTileset());
writePng(resolve(TILESET_DIR, 'props.png'), drawPropsTileset());
writePng(resolve(SPRITE_DIR, 'player.png'), drawPlayerSheet());
writePng(resolve(SPRITE_DIR, 'monsters.png'), drawMonsterSheet());
writePng(resolve(SPRITE_DIR, 'drop.png'), drawDropIcon());

const MAPS = [
  { file: 'f01_sprout_meadow.json', build: buildF01 },
  { file: 'c01_dawnsprout_town.json', build: buildC01 },
  { file: 'd01_rattail_cellar.json', build: buildD01 },
];
mkdirSync(MAP_DIR, { recursive: true });
for (const { file, build } of MAPS) {
  const path = resolve(MAP_DIR, file);
  if (!existsSync(path) || process.argv.includes('--force-map')) {
    writeFileSync(path, JSON.stringify(build()) + '\n');
    console.log(`已產生 ${path}`);
  } else {
    console.log(`地圖已存在，略過（要覆蓋請加 --force-map）：${path}`);
  }
}
