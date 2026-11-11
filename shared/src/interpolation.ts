// 其他玩家位置的插值緩衝：把伺服器斷續送來的位置，還原成平滑的移動

export interface Snapshot {
  /** 收到的時間（毫秒） */
  t: number;
  x: number;
  y: number;
}

/**
 * 用法：每次收到伺服器位置就 push，每一幀用「現在時間 − 延遲」取樣。
 * 延遲建議為伺服器同步間隔的 2 倍，這樣取樣點前後通常都有資料可以內插。
 */
export class SnapshotBuffer {
  private readonly snaps: Snapshot[] = [];

  /**
   * @param intervalMs 伺服器同步間隔（毫秒）
   * @param maxSize 最多保留的筆數
   */
  constructor(
    private readonly intervalMs: number,
    private readonly maxSize = 30,
  ) {}

  push(t: number, x: number, y: number): void {
    const last = this.snaps[this.snaps.length - 1];
    // 靜止時伺服器不會送資料。停了一陣子後再出發時，補一筆「出發前一刻仍在原地」的資料，
    // 否則會從很久以前的那一筆開始內插，造成瞬間滑動。
    if (last && t - last.t > this.intervalMs * 2) {
      this.snaps.push({ t: t - this.intervalMs, x: last.x, y: last.y });
    }
    this.snaps.push({ t, x, y });
    while (this.snaps.length > this.maxSize) {
      this.snaps.shift();
    }
  }

  /** 清空並直接設定位置（例如剛進入視野時） */
  reset(t: number, x: number, y: number): void {
    this.snaps.length = 0;
    this.snaps.push({ t, x, y });
  }

  /** 取得指定時間點的位置；沒有任何資料時回傳 null */
  sample(renderTime: number): { x: number; y: number } | null {
    const snaps = this.snaps;
    const first = snaps[0];
    if (!first) {
      return null;
    }
    // 丟掉已經用不到的舊資料（保留取樣點之前最近的一筆）
    while (snaps.length >= 2 && snaps[1]!.t <= renderTime) {
      snaps.shift();
    }
    const a = snaps[0]!;
    const b = snaps[1];
    if (!b || renderTime <= a.t) {
      return { x: a.x, y: a.y };
    }
    const k = (renderTime - a.t) / (b.t - a.t);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }
}
