# 內容製作流程

這份文件說明如何在不改程式的情況下新增遊戲內容：一張地圖、一種魔物、一個任務（以及順帶會用到的道具與 NPC）。

所有內容都是資料檔：

| 內容 | 檔案 |
|---|---|
| 地圖 | `shared/maps/*.json`（Tiled 匯出的 JSON） |
| 魔物 | `shared/data/monsters.json` |
| 道具 | `shared/data/items.json` |
| 技能 | `shared/data/skills.json` |
| NPC | `shared/data/npcs.json` |
| 任務 | `shared/data/quests.json` |
| 職業 | `shared/data/classes.json` |
| 圖片 | `client/public/assets/` |

**每次改完內容，先跑檢查：**

```bash
npm run check:content
```

它不需要啟動伺服器或資料庫，會列出各資料表的筆數與每張地圖的摘要，並指出填錯的地方（例如魔物掉落了不存在的道具、傳送點通往不存在的地圖、任務的 NPC 沒有放在任何地圖上）。伺服器啟動時也會做同樣的檢查，有錯就不啟動。

檢查通過後重啟伺服器與用戶端（`npm run dev`）就能看到新內容。資料檔的變動不需要資料庫 migration。

> 專案裡現有的三張地圖是用 `tools/gen-placeholders.mjs` 以程式產生的佔位內容。你自己做地圖時用 Tiled 編輯即可，不需要動那支腳本；但請注意 `npm run gen:assets -- --force-map` 會重新產生並**覆蓋**那三張地圖，也會重畫佔位圖片。

---

## 一、新增一張地圖

以「蜜風丘陵（F02）」為例，接在嫩芽草原之後。

### 1. 在 Tiled 建立地圖

「檔案 → 新增地圖」：

| 設定 | 值 |
|---|---|
| 方向（Orientation） | Isometric |
| 圖磚圖層格式 | CSV |
| 圖磚繪製順序 | Right Down |
| 地圖大小 | 自訂，例如 40 × 40 |
| 圖磚大小 | 寬 64、高 32 |

最省事的做法是用 Tiled 開啟現有的 `shared/maps/f01_sprout_meadow.json`，「另存新檔」成 `shared/maps/f02_honeywind_hills.json` 再修改，圖磚集與圖層都已經設定好。

### 2. 地圖屬性

「地圖 → 地圖屬性」加入兩個自訂屬性（字串）：

| 屬性 | 範例 | 說明 |
|---|---|---|
| `mapId` | `F02` | 地圖代號，全遊戲不可重複 |
| `displayName` | `蜜風丘陵` | 顯示給玩家看的名稱 |

### 3. 圖磚集

兩個圖磚集，都要**內嵌在地圖檔內**（Tiled 的「內嵌圖磚集」按鈕；Phaser 不支援外部 `.tsx`）：

| 名稱 | 圖片 | 圖磚大小 | 用途 |
|---|---|---|---|
| `ground` | `client/public/assets/tilesets/ground.png` | 64 × 32 | 地面 |
| `props` | `client/public/assets/tilesets/props.png` | 64 × 96 | 樹、石頭、房子等立體物件 |

不可行走的地面圖磚（例如水面）：在圖磚集編輯器選取該圖磚，加入自訂屬性 `blocked`（bool）= true。

所有地圖共用這兩張圖。要加新的地面或物件，請在圖片**右邊**加新的格子（不要改動既有格子的位置，否則舊地圖會錯位），並在每張用到的地圖裡更新圖磚集的圖片大小。

### 4. 圖層

圖層名稱必須完全一致：

| 圖層 | 種類 | 內容 |
|---|---|---|
| `ground` | 圖磚層 | 地面。**沒有圖磚的格子不可行走**（地下城的牆就是留空） |
| `props` | 圖磚層 | 立體物件。**有圖磚的格子一律不可行走** |
| `spawns` | 物件層 | 一個「點」物件，名稱 `player_spawn`：預設出生點 |
| `portals` | 物件層 | 傳送點（見下） |
| `monster_spawns` | 物件層 | 魔物重生區（見下） |
| `npcs` | 物件層 | NPC 的位置（見下） |

後三個圖層沒有內容時可以省略。

### 5. 傳送點（`portals` 層）

用「矩形」工具畫出範圍，玩家走進去就會被傳送。每個矩形加三個自訂屬性：

| 屬性 | 型別 | 說明 |
|---|---|---|
| `targetMap` | 字串 | 目標地圖的 `mapId` |
| `targetX`、`targetY` | 整數 | 抵達後站的格子（目標地圖的格座標） |

注意：

- **傳送點是單向的。** 要能來回，兩張地圖都要各畫一個。以 F02 為例：在 F01 畫一個通往 F02 的，在 F02 畫一個通往 F01 的。
- 目的地格子必須可以行走，而且**不可以落在另一個傳送點上**（否則會來回彈）。通常設在對方傳送點旁邊一兩格。
- 格座標可以在 Tiled 左下角看到；遊戲畫面左上角也會顯示角色目前的座標。

### 6. 魔物重生區（`monster_spawns` 層）

用「矩形」工具框出範圍。每個矩形：

| 欄位 | 說明 |
|---|---|
| 名稱 | 這一區的名稱，同一張地圖內不要重複（首領的重生計時用它辨識） |
| `monsterId`（字串） | `monsters.json` 裡的 `id` |
| `count`（整數） | 這一區同時存在幾隻 |

魔物會在範圍內的可行走格子隨機出現、在範圍內閒晃，死亡後依該魔物的 `respawnSec` 重生。

### 7. NPC（`npcs` 層）

用「點」工具放在 NPC 要站的格子上，加自訂屬性 `npcId`（字串）= `npcs.json` 裡的 `id`。

### 8. 完成

1. 存檔（JSON 格式，放在 `shared/maps/`）。**不需要在程式裡登記**，伺服器與用戶端都會自動載入這個資料夾裡的所有地圖。
2. 執行 `npm run check:content`。
3. 重啟後，從相鄰地圖的傳送點走進去驗證。

---

## 二、新增一種魔物

以 GDD 的「嗡嗡蜂」為例。

### 1. 在 `shared/data/monsters.json` 加一筆

```json
{
  "id": "buzzlet", "name": "嗡嗡蜂", "level": 7, "tier": "normal",
  "hp": 118, "atk": 26, "def": 6, "mdef": 4,
  "element": "storm", "race": "insect", "size": "small",
  "exp": 35, "coins": [7, 14],
  "aggressive": false, "moveSpeed": 3.4,
  "attackRange": 1.5, "attackIntervalMs": 1200,
  "aggroRange": 5, "leashRange": 10, "respawnSec": 10,
  "sprite": 6,
  "drops": [
    { "itemId": "mat_bee_sting", "rate": 50 },
    { "itemId": "card_buzzlet", "rate": 0.05 }
  ]
}
```

| 欄位 | 說明 |
|---|---|
| `id` | 代號，不可重複；地圖的重生區與任務會用到 |
| `tier` | `normal`、`elite`、`boss` |
| `hp`、`atk`、`def`、`mdef`、`exp`、`coins` | 數值，建議依下方公式計算 |
| `element` | `neutral` 無、`flame` 焰、`tide` 潮、`storm` 嵐、`rock` 岩、`radiant` 輝、`eclipse` 蝕 |
| `race` | `beast` 獸形、`plant` 植靈、`insect` 蟲甲、`aquatic` 水棲、`undead` 亡骸、`spirit` 元靈、`construct` 構裝、`humanoid` 人型、`dragon` 龍裔、`fiend` 魔裔 |
| `size` | `small`、`medium`、`large`（影響武器的體型修正） |
| `aggressive` | true 會主動攻擊靠近的玩家；false 被打才還手 |
| `moveSpeed` | 追擊速度（格／秒）；玩家是 4.5，比這個慢的魔物追不上人 |
| `aggroRange` | 主動魔物發現玩家的距離（格） |
| `leashRange` | 離重生點超過這個距離就放棄追擊、回滿血走回去 |
| `respawnSec` | 死亡後多久重生（秒） |
| `sprite` | `monsters.png` 裡的格子編號（從 0 起算） |
| `scale` | （選填）顯示時的放大倍率，首領常用 1.5–2 |
| `drops` | 掉落物與機率（百分比），每項獨立判定 |

**數值公式**（GDD 7.1），`Lv` 為等級：

| 項目 | 一般 | 菁英 | 首領 |
|---|---|---|---|
| HP：`30 + 10×Lv + 0.8×Lv²` | ×1（小型 ×0.85、大型 ×1.2） | ×8 | ×60 |
| 攻擊：`8 + 2.4×Lv + 0.02×Lv²` | ×1 | ×1.5 | ×2.2 |
| 物防 `0.8×Lv`、魔防 `0.5×Lv` | ×1 | ×1.3 | ×1.6 |
| 經驗：`上面的 HP 基準 × 0.25` | ×1（含體型修正） | ×6 | ×40 |
| 星幣 | `[Lv, 2×Lv]` | ×5 | ×30 |
| 卡片掉率 | 0.05% | 0.5% | 2% |

嗡嗡蜂 Lv7 小型：HP = (30 + 70 + 39.2) × 0.85 ≈ 118，攻擊 = 8 + 16.8 + 0.98 ≈ 26，經驗 = 139.2 × 0.25 × 0.85 ≈ 30（範例取 35 也可以，公式是基準不是硬性規定）。

### 2. 在 `shared/data/items.json` 補上掉落物

掉落物必須先存在於道具表。每筆至少要有 `id`、`name`、`type`、`maxStack`、`description`、`sellPrice`：

```json
{ "id": "mat_bee_sting", "name": "蜂刺", "type": "material", "maxStack": 999, "description": "嗡嗡蜂的尾刺。", "sellPrice": 13 },
{ "id": "card_buzzlet", "name": "嗡嗡蜂卡", "type": "card", "maxStack": 99, "description": "鑲嵌於武器：命中 +3。", "sellPrice": 500,
  "card": { "type": "weapon", "bonus": { "hit": 3 } } }
```

| `type` | 額外欄位 |
|---|---|
| `material` | 無 |
| `consumable` | `effect`：`{ "hp": 60 }` 或 `{ "sp": 30 }` |
| `equipment` | `equip`：`type`（`weapon`、`offhand`、`head`、`body`、`hands`、`feet`、`cloak`、`accessory`）、`reqLevel`、選填 `classes`（限定職業）與各種加成 |
| `card` | `card`：`type`（可鑲嵌的裝備種類）與 `bonus` |

可用的加成：`atk`、`matk`、`def`、`mdef`、`maxHp`、`maxSp`、`hit`、`eva`、`crit`（%）、`hpRegenPct`（%）、`stats`（`pow`、`swf`、`con`、`mnd`、`foc`、`for`）。

商店要賣的道具另外加 `buyPrice`（必須不低於 `sellPrice`，否則可以無限套利，檢查會擋下來），並把道具代號加進 `npcs.json` 裡該商人的 `sells`。

### 3. 圖片

`client/public/assets/sprites/monsters.png` 是一排 48 × 48 的格子，腳底對齊每格的 y = 42。在最右邊加一格畫上新魔物，`sprite` 填那一格的編號。

還沒有圖時可以先填既有的編號，魔物會借用別人的外觀，功能不受影響。

### 4. 放到地圖上

在地圖的 `monster_spawns` 層畫一個重生區，`monsterId` 填 `buzzlet`（見第一部分第 6 點）。

### 5. 首領

`tier` 設為 `boss` 就是首領，另外有這些行為：

- 被擊倒與重生時會向全伺服器公告。
- 重生時間（`respawnSec`，例如 1800 = 30 分鐘）存在資料庫，地圖沒人、伺服器重啟都不會重置。
- 星幣與掉落物歸造成最多傷害的人（一般魔物是歸第一個打到的人）。
- 血條較寬、名稱是金色。

首領的重生區 `count` 填 1。測試時可以在 `server/.env` 設 `BOSS_RESPAWN_SCALE=0.006`，30 分鐘會變成約 11 秒。

---

## 三、新增一個任務

### 1. 在 `shared/data/quests.json` 加一筆

```json
{
  "id": "q_bee_trouble",
  "name": "蜂擁而上",
  "description": "蜜風丘陵的嗡嗡蜂越來越多了。擊倒 8 隻，並帶回 3 根蜂刺。",
  "giver": "c01_guide",
  "turnIn": "c01_grocer",
  "requiredLevel": 6,
  "prerequisite": "q_first_steps",
  "objectives": [
    { "type": "kill", "monsterId": "buzzlet", "count": 8 },
    { "type": "collect", "itemId": "mat_bee_sting", "count": 3 }
  ],
  "rewards": {
    "exp": 400,
    "coins": 250,
    "items": [{ "itemId": "potion_hp_s", "quantity": 10 }]
  },
  "dialogue": {
    "offer": ["丘陵那邊的嗡嗡蜂多到商隊不敢走了。", "幫忙趕走 8 隻，順便帶 3 根蜂刺給雜貨商。"],
    "progress": ["蜂刺要交給雜貨商米露。"],
    "complete": ["這些蜂刺品質不錯，辛苦了！"]
  }
}
```

| 欄位 | 說明 |
|---|---|
| `id` | 代號，不可重複。**上線後不要改**，玩家的進度是用它記錄的 |
| `giver`、`turnIn` | 發布與回報的 NPC（可以是同一位）；兩位都必須放在某張地圖上 |
| `requiredLevel` | 接任務的最低等級 |
| `prerequisite` | （選填）要先完成的任務；沒完成前這個任務不會出現在 NPC 的清單裡 |
| `objectives` | 一個以上的目標，全部達成才能回報 |
| `rewards` | 經驗、星幣、道具（`items` 可以是空陣列） |
| `dialogue` | NPC 在三個階段說的話，每個階段至少一句；一個元素顯示成一行 |

目標有兩種：

| 種類 | 寫法 | 行為 |
|---|---|---|
| 擊殺 | `{ "type": "kill", "monsterId": "...", "count": 8 }` | 參與擊殺（有分到經驗）就累計，組隊時隊友打的也算 |
| 收集 | `{ "type": "collect", "itemId": "...", "count": 3 }` | 以回報當下背包裡的數量為準，回報時會收走 |

每個任務每個角色只能完成一次。

### 2. 需要新的 NPC 時

在 `shared/data/npcs.json` 加一筆，再到地圖的 `npcs` 層放一個點物件（第一部分第 7 點）：

```json
{ "id": "f02_beekeeper", "name": "養蜂人 蜜拉", "type": "talk", "dialogue": ["小心別被螫到了。", "今年的花蜜特別香。"] }
```

`type`：`talk`（只有對話與任務）、`shop`（另外要有 `sells`）、`refine`、`storage`。任何種類的 NPC 都可以發布與回報任務。`dialogue` 是打招呼時隨機說的話，至少一句。

### 3. 驗證

1. `npm run check:content`。
2. 重啟後找發布任務的 NPC：應該看到「！ 任務名稱」與「接受任務」按鈕（等級或前置任務不符時會顯示原因）。
3. 開啟 GM 指令可以加速測試：`/gm level 10` 調等級、`/gm item mat_bee_sting 3` 拿道具；攻擊魔物後輸入 `/gm slay` 直接擊倒。
4. 回到回報的 NPC，按「回報任務」，確認獎勵入帳。

---

## 常見錯誤

| 檢查訊息 | 原因 |
|---|---|
| 地圖 … 缺少 mapId 屬性 | 沒有設定地圖的自訂屬性 |
| 地圖 … 缺少圖磚層：ground | 圖層名稱打錯（大小寫也要一致） |
| 傳送點 … 目的地不可行走 | `targetX`／`targetY` 落在牆、樹或水上 |
| 重生區 … 指定了不存在的魔物 | `monsterId` 打錯，或還沒加進 `monsters.json` |
| 魔物 … 的掉落物 … 不存在 | 掉落物還沒加進 `items.json` |
| 任務 … 的 NPC … 沒有放在任何地圖上 | `npcs.json` 有這位 NPC，但沒有在任何地圖的 `npcs` 層放他 |
| 道具 … 的賣價高於買價 | `sellPrice` 大於 `buyPrice` |
| 進遊戲後地圖一片黑或圖磚錯位 | 圖磚集沒有內嵌，或圖磚集名稱不是 `ground`／`props` |
