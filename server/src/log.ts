// 伺服器日誌：統一的輸出格式，可同時寫到畫面與檔案。
// LOG_FORMAT=json 時每行一個 JSON（方便日誌系統收集）；否則是給人看的文字格式。
// 設定 LOG_DIR 時另外寫入該資料夾，每天一個檔案（server-YYYY-MM-DD.log）。

import { appendFile, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'info' | 'warn' | 'error';

const jsonFormat = process.env.LOG_FORMAT === 'json';
const logDir = process.env.LOG_DIR ?? '';
if (logDir) {
  mkdirSync(logDir, { recursive: true });
}

/** 把任意值轉成可以放進 JSON 的形式（Error 物件預設序列化後是空的，要自己展開） */
function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function write(level: Level, message: string, details: unknown[]): void {
  const time = new Date().toISOString();
  const extra = details.map(serialize);
  let line: string;
  if (jsonFormat) {
    line = JSON.stringify({ time, level, message, ...(extra.length > 0 ? { details: extra } : {}) });
  } else {
    const tail = extra
      .map((d) => (typeof d === 'string' ? d : (d as { stack?: string })?.stack ?? JSON.stringify(d)))
      .join(' ');
    line = `${time} ${level.toUpperCase().padEnd(5)} ${message}${tail ? ` ${tail}` : ''}`;
  }
  (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
  if (logDir) {
    // 寫檔失敗不能影響遊戲運作，所以只在畫面上提示一次
    appendFile(join(logDir, `server-${time.slice(0, 10)}.log`), `${line}\n`, (err) => {
      if (err && !fileErrorShown) {
        fileErrorShown = true;
        process.stderr.write(`日誌檔寫入失敗：${err.message}\n`);
      }
    });
  }
}

let fileErrorShown = false;

export const log = {
  info: (message: string, ...details: unknown[]): void => write('info', message, details),
  warn: (message: string, ...details: unknown[]): void => write('warn', message, details),
  error: (message: string, ...details: unknown[]): void => write('error', message, details),
};
