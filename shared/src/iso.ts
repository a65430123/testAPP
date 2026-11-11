// 斜視角（菱形 isometric）座標換算
//
// 座標系約定：
// - 「格座標」：浮點數，(tx, ty) 這一格的範圍是 [tx, tx+1) × [ty, ty+1)，格子中心是 (tx+0.5, ty+0.5)。
// - 「世界座標」：畫面上的像素座標，格 (0,0) 的上頂點位於世界原點 (0,0)。

export interface IsoGeometry {
  /** 圖磚寬（像素），例如 64 */
  tileWidth: number;
  /** 圖磚高（像素），例如 32 */
  tileHeight: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 格座標 → 世界座標 */
export function tileToWorld(tx: number, ty: number, geo: IsoGeometry): Point {
  return {
    x: (tx - ty) * (geo.tileWidth / 2),
    y: (tx + ty) * (geo.tileHeight / 2),
  };
}

/** 世界座標 → 格座標（浮點數，取整數格請用 Math.floor） */
export function worldToTile(wx: number, wy: number, geo: IsoGeometry): Point {
  const a = wx / (geo.tileWidth / 2);
  const b = wy / (geo.tileHeight / 2);
  return {
    x: (a + b) / 2,
    y: (b - a) / 2,
  };
}

/** 整數格的中心點世界座標 */
export function tileCenterToWorld(tx: number, ty: number, geo: IsoGeometry): Point {
  return tileToWorld(tx + 0.5, ty + 0.5, geo);
}

/** 整張地圖在世界座標中的外框（不含高出地面的物件） */
export function mapWorldBounds(
  width: number,
  height: number,
  geo: IsoGeometry,
): { x: number; y: number; width: number; height: number } {
  const halfW = geo.tileWidth / 2;
  const halfH = geo.tileHeight / 2;
  return {
    x: -height * halfW,
    y: 0,
    width: (width + height) * halfW,
    height: (width + height) * halfH,
  };
}
