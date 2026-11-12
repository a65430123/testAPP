// 內容檢查：不必啟動伺服器與資料庫，就能確認資料表與地圖沒有填錯。
// 用法：npm run check:content
// 新增或修改地圖、魔物、道具、技能、NPC、任務之後先跑這個。

import { CLASSES, ITEMS, MONSTERS, NPCS, QUESTS, SKILLS, validateGameData, validateQuests } from '@starmemory/shared';

const errors = [...validateGameData(), ...validateQuests()];
let mapSummary: string[] = [];
try {
  // 載入地圖時會檢查：mapId、出生點、傳送點目的地、重生區的魔物、NPC、任務 NPC 是否在地圖上
  const { allMaps } = await import('../src/maps');
  mapSummary = allMaps().map(
    (m) =>
      `  ${m.id} ${m.displayName}：${m.grid.width}×${m.grid.height}，傳送點 ${m.portals.length}、` +
      `重生區 ${m.monsterSpawns.length}（共 ${m.monsterSpawns.reduce((n, a) => n + a.count, 0)} 隻）、NPC ${m.npcs.length}`,
  );
} catch (err) {
  errors.push(err instanceof Error ? err.message : String(err));
}

console.log(`職業 ${CLASSES.length}、道具 ${ITEMS.length}、魔物 ${MONSTERS.length}、技能 ${SKILLS.length}、NPC ${NPCS.length}、任務 ${QUESTS.length}`);
if (mapSummary.length > 0) {
  console.log(`地圖 ${mapSummary.length} 張：\n${mapSummary.join('\n')}`);
}
if (errors.length > 0) {
  console.error(`\n發現 ${errors.length} 個問題：\n${errors.map((e) => `  ✗ ${e}`).join('\n')}`);
  process.exit(1);
}
console.log('\n內容檢查通過');
