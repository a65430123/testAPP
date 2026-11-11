# 星憶旅團

2D 網頁多人線上 RPG。設計文件見 [`docs/GDD.md`](docs/GDD.md)。

## 目前進度

- [x] 階段 0：遊戲設計文件
- [x] 階段 1：monorepo 骨架、單機可玩的地圖原型（點擊移動、碰撞、鏡頭跟隨、佔位美術）
- [x] 階段 2：Colyseus 連線——登入、地圖房間、伺服器驗證移動、其他玩家插值、聊天、傳送點切換地圖
- [x] 階段 3：帳號註冊／登入（bcrypt、JWT）、角色建立與選角、PostgreSQL 資料表與 migration、定時與離線存檔
- [ ] 之後：戰鬥、魔物、Redis、部署……

## 專案結構

```
client/   Phaser 3 + TypeScript + Vite 用戶端
  src/net/        登入與房間連線
  src/scenes/     載入場景、世界場景
  src/entities/   畫面上的玩家（角色圖、名牌、對話泡泡）
  src/ui/         登入／註冊、選角、聊天、背包（HTML）
server/   Node.js + TypeScript + Colyseus 伺服器
  migrations/         資料表 migration（依檔名順序執行的 SQL）
  src/index.ts        進入點：套用 migration、註冊 API 與房間
  src/config.ts       環境變數設定
  src/auth.ts         bcrypt 密碼雜湊、JWT 簽發與驗證
  src/http.ts         註冊、登入、角色列表、建立角色 API
  src/db/             連線池、migration 執行器、帳號與角色的資料存取
  src/online.ts       線上角色登記（一個帳號同時只能有一個角色在線）
  src/maps.ts         載入地圖、碰撞格、傳送點
  src/rooms/          地圖房間與同步狀態
  scripts/smoke.ts    連線煙霧測試
shared/   用戶端與伺服器共用：通訊協定、資料表、角色與背包邏輯、座標換算、Tiled 解析、尋路、移動、插值
  data/   職業、道具資料表（JSON）
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
| `npm run smoke` | 對執行中的伺服器跑連線煙霧測試 |
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

**GM 指令**（`ENABLE_GM_COMMANDS=true` 時，在聊天視窗輸入；戰鬥系統完成前用來驗證等級與背包存檔）

- `/gm level <等級>`：設定等級
- `/gm item <道具代號> [數量]`：取得道具，代號見 `shared/data/items.json`，例如 `/gm item mat_sticky_dew 25`

## 連線架構

- **地圖房間**：每張地圖一個 Colyseus 房間（房間類型 `map`，以 `mapId` 區分，滿 80 人自動開分流）。加入時伺服器會驗證 JWT、從資料庫載入角色，並確認角色屬於該帳號、且真的在那張地圖。一個帳號同一時間只能有一個角色在線上，重複登入會把舊連線踢下線。
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
- `portals` 物件層：矩形物件即傳送點，需要三個自訂屬性 `targetMap`（字串）、`targetX`、`targetY`（整數，目標地圖的格座標）。目的地不可以落在另一個傳送點上。
- 圖磚集需內嵌在地圖檔內（Phaser 不支援外部 `.tsx`）。
- 新增地圖：把 JSON 放進 `shared/maps/`（伺服器會自動載入），並在 `client/src/assets.ts` 的 `MAPS` 加一行。
