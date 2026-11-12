// 設定帳號的角色（第一位管理員只能用這個指令產生，不能從網頁上取得）。
// 用法：npm run admin:grant -- <帳號> [admin|gm|player]
//   admin  可使用後台所有功能（含發放道具）
//   gm     可查詢、封鎖、公告、看事件
//   player 一般玩家（用來撤銷權限）

import { setAccountRole, type AccountRole } from '../src/db/admin';
import { pool } from '../src/db/pool';

const [username, role = 'admin'] = process.argv.slice(2);
if (!username || !['admin', 'gm', 'player'].includes(role)) {
  console.error('用法：npm run admin:grant -- <帳號> [admin|gm|player]');
  process.exit(1);
}
const ok = await setAccountRole(username, role as AccountRole);
console.log(ok ? `帳號「${username}」的角色已設為 ${role}` : `找不到帳號「${username}」（請先在遊戲中註冊）`);
await pool.end();
process.exit(ok ? 0 : 1);
