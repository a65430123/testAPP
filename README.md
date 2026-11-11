# 星憶旅團

2D 網頁多人線上 RPG。設計文件見 [`docs/GDD.md`](docs/GDD.md)。

## 目前進度

- [x] 階段 0：遊戲設計文件
- [x] 階段 1：monorepo 骨架、單機可玩的地圖原型（點擊移動、碰撞、鏡頭跟隨、佔位美術）
- [ ] 階段 2 之後：Colyseus 連線、伺服器權威移動、戰鬥……

## 專案結構

```
client/   Phaser 3 + TypeScript + Vite 用戶端
server/   Node.js + TypeScript 伺服器（本階段只是佔位程式，尚未連線）
shared/   用戶端與伺服器共用的純邏輯：座標換算、Tiled 解析、碰撞格、A* 尋路、移動
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

瀏覽器開啟 <http://localhost:5173>。

其他指令：

| 指令 | 用途 |
|---|---|
| `npm run build` | 型別檢查並打包用戶端到 `client/dist` |
| `npm run preview` | 預覽打包結果 |
| `npm test` | 執行 shared 的單元測試 |
| `npm run typecheck` | 三個套件的型別檢查 |
| `npm run server` | 執行伺服器佔位程式（載入地圖並試算一條路徑） |
| `npm run gen:assets` | 重新產生佔位 PNG（加 `-- --force-map` 會連地圖一起重產並覆蓋） |

## 地圖製作約定（Tiled）

- 方向：Isometric，圖磚 64×32。
- `ground` 圖磚層：地面。圖磚自訂屬性 `blocked`（bool）為 true 的格子不可行走（例如水面）；沒有圖磚的格子也不可行走。
- `props` 圖磚層：樹、石頭等立體物件，使用 64×96 的圖磚集。有圖磚的格子一律不可行走。
- `spawns` 物件層：名稱為 `player_spawn` 的點物件是玩家出生點。
- 圖磚集需內嵌在地圖檔內（Phaser 不支援外部 `.tsx`）。
