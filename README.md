# 星憶旅團

2D 網頁多人線上 RPG。設計文件見 [`docs/GDD.md`](docs/GDD.md)。

## 目前進度

- [x] 階段 0：遊戲設計文件
- [x] 階段 1：monorepo 骨架、單機可玩的地圖原型（點擊移動、碰撞、鏡頭跟隨、佔位美術）
- [x] 階段 2：Colyseus 連線——登入、地圖房間、伺服器驗證移動、其他玩家插值、聊天、傳送點切換地圖
- [x] 階段 3：帳號註冊／登入（bcrypt、JWT）、角色建立與選角、PostgreSQL 資料表與 migration、定時與離線存檔
- [x] 階段 4：魔物 AI 與重生點、普攻與技能、傷害公式、經驗與升級、素質配點、掉落與撿取
- [ ] 之後：裝備與卡片、更多地圖與魔物、Redis、部署……

## 專案結構

```
client/   Phaser 3 + TypeScript + Vite 用戶端
  src/net/        登入與房間連線
  src/scenes/     載入場景、世界場景
  src/entities/   畫面上的玩家、魔物、掉落物、血條
  src/ui/         登入／註冊、選角、聊天、背包、狀態與素質、技能列（HTML）
server/   Node.js + TypeScript + Colyseus 伺服器
  migrations/         資料表 migration（依檔名順序執行的 SQL）
  src/index.ts        進入點：套用 migration、註冊 API 與房間
  src/config.ts       環境變數設定
  src/auth.ts         bcrypt 密碼雜湊、JWT 簽發與驗證
  src/http.ts         註冊、登入、角色列表、建立角色 API
  src/db/             連線池、migration 執行器、帳號與角色的資料存取
  src/online.ts       線上角色登記（一個帳號同時只能有一個角色在線）
  src/maps.ts         載入地圖、碰撞格、傳送點
  src/game/           魔物管理（重生、AI）
  src/rooms/          地圖房間（移動、戰鬥、掉落、存檔）與同步狀態
  scripts/            連線與戰鬥煙霧測試
shared/   用戶端與伺服器共用：通訊協定、資料表、戰鬥公式、經驗與配點、背包、座標換算、Tiled 解析、尋路、移動、插值
  data/   職業、道具、魔物、技能資料表（JSON）
  maps/   Tiled JSON 地圖（可直接用 Tiled 開啟編輯）
tools/    佔位美術與示範地圖的產生腳本
docs/     設計文件
```

## 啟動方式

需要 Node.js 20.12 以上，以及 PostgreSQL 14 以上（或 Docker）。

1. 安裝套件：

```bash
npm install
```

2. 啟動 PostgreSQL。有 Docker 的話直接用附的設定（帳號、密碼、資料庫名稱都是 `starmemory`，5432 埠）：

```bash
npm run db:up
```

   若使用自己的 PostgreSQL，請建立資料庫後把連線字串寫進 `server/.env`（見下方）。

3. 建立伺服器設定檔（可略過，略過時使用預設值）：

```bash
cp server/.env.example server/.env
```

4. 啟動遊戲伺服器（2567 埠）與用戶端開發伺服器（5173 埠）。伺服器啟動時會自動套用尚未執行的 migration：

```bash
npm run dev
```

瀏覽器開啟 <http://localhost:5173>，註冊帳號、建立角色後即可進入。開兩個瀏覽器（或一個一般視窗加一個無痕視窗）用不同帳號登入，就能看到彼此。

其他指令：

| 指令 | 用途 |
|---|---|
| `npm run dev:server`／`npm run dev:client` | 分別啟動伺服器或用戶端 |
| `npm run server` | 啟動伺服器（不自動重載） |
| `npm run migrate` | 只執行資料庫 migration |
| `npm run db:up`／`npm run db:down` | 啟動／停止開發用 PostgreSQL（Docker） |
| `npm run smoke` | 對執行中的伺服器跑連線與戰鬥煙霧測試（戰鬥部分需要開啟 GM 指令） |
| `npm test` | 執行 shared 的單元測試 |
| `npm run typecheck` | 三個套件的型別檢查 |
| `npm run build`／`npm run preview` | 打包用戶端到 `client/dist`／預覽打包結果 |
| `npm run gen:assets` | 重新產生佔位 PNG（加 `-- --force-map` 會連地圖一起重產並覆蓋） |

伺服器環境變數（寫在 `server/.env`，範本見 `server/.env.example`）：

| 變數 | 說明 | 預設 |
|---|---|---|
| `PORT` | 連接埠 | `2567` |
| `DATABASE_URL` | PostgreSQL 連線字串 | `postgres://starmemory:starmemory@localhost:5432/starmemory` |
| `JWT_SECRET` | JWT 簽章金鑰。`NODE_ENV=production` 時必填且至少 32 個字元 | 開發用固定金鑰 |
| `JWT_EXPIRES_IN` | JWT 有效期限 | `7d` |
| `BCRYPT_ROUNDS` | bcrypt 成本參數 | `12` |
| `CORS_ORIGIN` | 允許呼叫 API 的網頁來源 | `*` |
| `AUTO_MIGRATE` | 啟動時自動套用 migration | `true` |
| `ENABLE_GM_COMMANDS` | 開啟 GM 聊天指令（僅供開發測試） | `false` |
| `TRUST_PROXY` | 伺服器在反向代理後方時設為 `true` | `false` |

用戶端環境變數：`VITE_SERVER_URL`（遊戲伺服器位址，預設為目前網域的 2567 埠）。

## 帳號、角色與存檔

**API**（除註冊與登入外，都要帶 `Authorization: Bearer <JWT>`）

| 方法與路徑 | 內容 | 說明 |
|---|---|---|
| `POST /api/register` | `{ username, password }` | 帳號 3–20 個英數底線字元（不分大小寫）、密碼 8–72 個字元；回傳 `{ token, username }` |
| `POST /api/login` | `{ username, password }` | 回傳 `{ token, username }`；帳號不存在與密碼錯誤的回應相同 |
| `GET /api/characters` | — | 回傳 `{ characters, maxCharacters }` |
| `POST /api/characters` | `{ name, classId }` | 每個帳號最多 3 個角色，角色名稱全伺服器不可重複 |

註冊與登入對同一 IP 限制每分鐘 20 次。

**資料表**（`server/migrations/001_init.sql`）

| 資料表 | 內容 |
|---|---|
| `accounts` | 帳號、bcrypt 密碼雜湊、建立與最後登入時間 |
| `characters` | 角色名稱、職業、等級、經驗、六項素質與未分配點數、HP／SP、星幣、所在地圖與位置 |
| `character_items` | 背包，一列一格（格子位置、道具代號、數量） |
| `schema_migrations` | 已套用的 migration |

新增 migration：在 `server/migrations/` 加一個檔名排在最後的 `.sql`（例如 `002_xxx.sql`）。已套用過的檔案不要再修改。

**存檔時機**

- 定時存檔：每 30 秒把有變動的線上角色寫入資料庫（背包沒變動時只寫角色本身）。
- 離線存檔：玩家關閉網頁、斷線、被踢下線時立即存檔。
- 切換地圖：先存檔，成功後才通知用戶端換房間。
- 伺服器關機（Ctrl+C 或 SIGTERM）：先讓所有玩家離線並完成存檔，才關閉資料庫連線。
- 伺服器異常終止（當機、`kill -9`）時，最多遺失最近 30 秒的進度。

**GM 指令**（`ENABLE_GM_COMMANDS=true` 時，在聊天視窗輸入；只供開發與測試）

- `/gm level <等級>`：設定等級
- `/gm exp <數值>`：獲得經驗值（會觸發升級）
- `/gm item <道具代號> [數量]`：取得道具，代號見 `shared/data/items.json`
- `/gm hp <數值>`：設定目前 HP

## 戰鬥系統

**操作**：點魔物開始攻擊（伺服器會帶著角色追擊並自動普攻），點地面移動會取消攻擊；選好目標後按下方技能列施放技能；點掉落物撿取；點背包裡的消耗品使用；左上角「素質」可配點。

**資料表**（改 JSON 就能新增內容，伺服器啟動時會檢查參照是否完整）

| 檔案 | 內容 |
|---|---|
| `shared/data/monsters.json` | 魔物：等級、HP、攻防、屬性、種族、體型、經驗、星幣、主動與否、移動與攻擊參數、警戒與牽引範圍、重生時間、掉落物與機率 |
| `shared/data/skills.json` | 技能：類型（傷害／治療）、物理或魔法、屬性、倍率、連擊數、射程、範圍、SP、冷卻、需求等級 |
| `shared/data/classes.json` | 職業：HP／SP 係數、攻擊方式與射程、基礎武器攻擊力、攻擊間隔、體型修正、可用技能、起始道具 |
| `shared/data/items.json` | 道具：類型、堆疊上限、消耗品效果 |

目前有嫩芽草原的 3 種魔物與 9 個技能。新增魔物：在 `monsters.json` 加一筆、在 `items.json` 補上牠的掉落物、在地圖的 `monster_spawns` 層畫重生區；圖片加在 `client/public/assets/sprites/monsters.png`（每格 48×48，`sprite` 欄位是格子編號）。

**魔物 AI**（`server/src/game/MonsterManager.ts`）

- 閒晃：在自己的重生區內隨機走動。
- 被動魔物被打才還手；主動魔物（名稱為紅色）會攻擊進入警戒範圍的玩家。
- 追擊：朝目標移動，進入攻擊距離後依攻擊間隔出手。
- 返回：離重生點超過牽引範圍、目標倒地或離開時，放棄追擊、回滿 HP 並走回重生點。
- 死亡後依 `respawnSec` 在重生區內隨機位置重生。

**規則**（公式在 `shared/src/combat.ts` 與 `shared/src/progression.ts`，對應 GDD 第 4、5 章）

- 傷害：暴擊 → 命中 → 基礎傷害（含浮動）→ 體型修正 → 屬性相剋 → 防禦與固定減傷 → 暴擊倍率，至少 1 點。魔法必中、不暴擊。
- 經驗：依各玩家造成的傷害比例分配，並套用等級差倍率。升級時獲得 6 點素質點，HP／SP 回滿。
- 素質配點：把素質從 v 提升到 v+1 需要 `1 + floor(v / 10)` 點，單項上限 100。
- 掉落：每項獨立判定，掉在魔物倒下的位置；前 10 秒只有第一個打到魔物的人能撿，60 秒沒人撿就消失。星幣直接給第一個打到的人。
- 倒地：HP 歸零後 5 秒在曦芽鎮復活並回滿 HP；等級 11 以上會損失升級所需經驗的 1%。
- HP／SP 每 6 秒自然回復一次。

**尚未實作**：裝備與卡片的數值（目前防禦為 0、武器攻擊力取職業的基礎值）、種族與首領加成、異常狀態、需要狀態系統的技能（挑釁、鐵壁、潛行、淬毒、祝福等）、組隊經驗加成、技能點數。

## 連線架構

- **地圖房間**：每張地圖一個 Colyseus 房間（房間類型 `map`，以 `mapId` 區分，滿 80 人自動開分流）。加入時伺服器會驗證 JWT、從資料庫載入角色，並確認角色屬於該帳號、且真的在那張地圖。一個帳號同一時間只能有一個角色在線上，重複登入會把舊連線踢下線。
- **戰鬥**：用戶端只送「攻擊哪一隻」「用哪個技能」「撿哪個掉落物」；命中、傷害、經驗、掉落全部由伺服器計算，魔物與掉落物放在房間的同步狀態裡。
- **移動**：用戶端只送「目標格」。伺服器自行尋路、每 50 毫秒推進位置並同步給房內所有人；目標不可行走、超出地圖或格式錯誤都會被拒絕。
  - 自己的角色先在本機預測移動，再以伺服器位置校正。
  - 其他玩家以延遲 100 毫秒的插值顯示。
- **聊天**：「地圖」頻道只有同房間看得到，並顯示在角色頭上；「世界」頻道會轉送到所有地圖房間。伺服器限制長度與發言頻率。
- **背包**：屬於私人資料，不放在房間的同步狀態裡，只傳給本人。
- **傳送點**：角色走進傳送點時，伺服器把角色的位置改到目標地圖並存檔，再通知用戶端離開舊房間、加入新地圖的房間。

## 地圖製作約定（Tiled）

- 方向：Isometric，圖磚 64×32。
- 地圖自訂屬性：`mapId`（地圖代號，例如 `F01`）、`displayName`（顯示名稱）。
- `ground` 圖磚層：地面。圖磚自訂屬性 `blocked`（bool）為 true 的格子不可行走（例如水面）；沒有圖磚的格子也不可行走。
- `props` 圖磚層：樹、石頭、小屋等立體物件，使用 64×96 的圖磚集。有圖磚的格子一律不可行走。
- `spawns` 物件層：名稱為 `player_spawn` 的點物件是預設出生點。
- `monster_spawns` 物件層：矩形物件即魔物重生區，需要兩個自訂屬性 `monsterId`（字串，對應 `monsters.json`）、`count`（整數，這一區同時存在的數量）。
- `portals` 物件層：矩形物件即傳送點，需要三個自訂屬性 `targetMap`（字串）、`targetX`、`targetY`（整數，目標地圖的格座標）。目的地不可以落在另一個傳送點上。
- 圖磚集需內嵌在地圖檔內（Phaser 不支援外部 `.tsx`）。
- 新增地圖：把 JSON 放進 `shared/maps/`（伺服器會自動載入），並在 `client/src/assets.ts` 的 `MAPS` 加一行。
