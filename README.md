# 星憶旅團

2D 網頁多人線上 RPG。設計文件見 [`docs/GDD.md`](docs/GDD.md)。

## 目前進度

- [x] 階段 0：遊戲設計文件
- [x] 階段 1：monorepo 骨架、單機可玩的地圖原型（點擊移動、碰撞、鏡頭跟隨、佔位美術）
- [x] 階段 2：Colyseus 連線——登入、地圖房間、伺服器驗證移動、其他玩家插值、聊天、傳送點切換地圖
- [ ] 之後：PostgreSQL 帳號與存檔、戰鬥、魔物……

## 專案結構

```
client/   Phaser 3 + TypeScript + Vite 用戶端
  src/net/        登入與房間連線
  src/scenes/     載入場景、世界場景
  src/entities/   畫面上的玩家（角色圖、名牌、對話泡泡）
  src/ui/         登入畫面、聊天視窗（HTML）
server/   Node.js + TypeScript + Colyseus 伺服器
  src/index.ts        進入點：登入 API 與房間註冊
  src/accounts.ts     帳號／角色暫存（記憶體，之後換成 PostgreSQL）
  src/maps.ts         載入地圖、碰撞格、傳送點
  src/rooms/          地圖房間與同步狀態
  scripts/smoke.ts    連線煙霧測試
shared/   用戶端與伺服器共用：通訊協定、座標換算、Tiled 解析、碰撞格、A* 尋路、移動、插值
  maps/   Tiled JSON 地圖（可直接用 Tiled 開啟編輯）
tools/    佔位美術與示範地圖的產生腳本
docs/     設計文件
```

## 啟動方式

需要 Node.js 20 以上。

```bash
npm install
```

```bash
npm run dev
```

這會同時啟動遊戲伺服器（2567 埠）與用戶端開發伺服器（5173 埠）。瀏覽器開啟 <http://localhost:5173>，輸入角色名稱即可進入。開兩個分頁、用不同名稱登入，就能看到彼此。

其他指令：

| 指令 | 用途 |
|---|---|
| `npm run dev:server`／`npm run dev:client` | 分別啟動伺服器或用戶端 |
| `npm run server` | 啟動伺服器（不自動重載） |
| `npm run smoke` | 對執行中的伺服器跑連線煙霧測試（登入、移動驗證、聊天、傳送） |
| `npm test` | 執行 shared 的單元測試 |
| `npm run typecheck` | 三個套件的型別檢查 |
| `npm run build`／`npm run preview` | 打包用戶端到 `client/dist`／預覽打包結果 |
| `npm run gen:assets` | 重新產生佔位 PNG（加 `-- --force-map` 會連地圖一起重產並覆蓋） |

環境變數：

| 變數 | 用於 | 說明 | 預設 |
|---|---|---|---|
| `PORT` | 伺服器 | 連接埠 | `2567` |
| `CORS_ORIGIN` | 伺服器 | 允許呼叫登入 API 的網頁來源 | `*` |
| `VITE_SERVER_URL` | 用戶端 | 遊戲伺服器位址 | 目前網域的 2567 埠 |

## 連線架構

- **登入**：`POST /api/login`，內容 `{ "name": "角色名稱" }`，回傳憑證與角色所在地圖。本階段沒有密碼，名稱相同即視為同一角色；資料存在伺服器記憶體中，重啟即清空。
- **地圖房間**：每張地圖一個 Colyseus 房間（房間類型 `map`，以 `mapId` 區分，滿 80 人自動開分流）。加入時伺服器會驗證憑證，並確認角色真的在那張地圖。
- **移動**：用戶端只送「目標格」。伺服器自行尋路、每 50 毫秒推進位置並同步給房內所有人；目標不可行走、超出地圖或格式錯誤都會被拒絕。
  - 自己的角色先在本機預測移動，再以伺服器位置校正。
  - 其他玩家以延遲 100 毫秒的插值顯示。
- **聊天**：「地圖」頻道只有同房間看得到，並顯示在角色頭上；「世界」頻道會轉送到所有地圖房間。伺服器限制長度與發言頻率。
- **傳送點**：角色走進傳送點時，伺服器把角色的存檔位置改到目標地圖並通知用戶端，用戶端離開舊房間、加入新地圖的房間。

## 地圖製作約定（Tiled）

- 方向：Isometric，圖磚 64×32。
- 地圖自訂屬性：`mapId`（地圖代號，例如 `F01`）、`displayName`（顯示名稱）。
- `ground` 圖磚層：地面。圖磚自訂屬性 `blocked`（bool）為 true 的格子不可行走（例如水面）；沒有圖磚的格子也不可行走。
- `props` 圖磚層：樹、石頭、小屋等立體物件，使用 64×96 的圖磚集。有圖磚的格子一律不可行走。
- `spawns` 物件層：名稱為 `player_spawn` 的點物件是預設出生點。
- `portals` 物件層：矩形物件即傳送點，需要三個自訂屬性 `targetMap`（字串）、`targetX`、`targetY`（整數，目標地圖的格座標）。目的地不可以落在另一個傳送點上。
- 圖磚集需內嵌在地圖檔內（Phaser 不支援外部 `.tsx`）。
- 新增地圖：把 JSON 放進 `shared/maps/`（伺服器會自動載入），並在 `client/src/assets.ts` 的 `MAPS` 加一行。
