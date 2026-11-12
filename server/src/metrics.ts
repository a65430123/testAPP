// 伺服器自身的健康指標：事件迴圈延遲。
// Node.js 是單執行緒，所有房間的模擬都排在同一個事件迴圈裡；延遲變大代表伺服器忙不過來，
// 玩家會感覺到卡頓。壓力測試與監控都看這個數字。

const SAMPLE_MS = 100;
const WINDOW_MS = 10_000;

let expected = Date.now() + SAMPLE_MS;
let samples: Array<{ at: number; lag: number }> = [];

setInterval(() => {
  const now = Date.now();
  // 計時器本來應該在 expected 這一刻觸發；晚了多少就是事件迴圈被佔用了多久
  samples.push({ at: now, lag: Math.max(0, now - expected) });
  expected = now + SAMPLE_MS;
  if (samples.length > WINDOW_MS / SAMPLE_MS) {
    samples = samples.filter((s) => now - s.at <= WINDOW_MS);
  }
}, SAMPLE_MS).unref();

/** 最近 10 秒內事件迴圈延遲的平均值與最大值（毫秒） */
export function loopLag(): { avgMs: number; maxMs: number } {
  if (samples.length === 0) {
    return { avgMs: 0, maxMs: 0 };
  }
  const total = samples.reduce((sum, s) => sum + s.lag, 0);
  return {
    avgMs: Math.round((total / samples.length) * 10) / 10,
    maxMs: Math.max(...samples.map((s) => s.lag)),
  };
}
