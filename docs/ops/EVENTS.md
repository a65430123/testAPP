# 活動排程系統設計

> 狀態：**設計文件，尚未實作。** 目標是讓營運人員在後台排好活動的時間與內容，伺服器到時間自動開始與結束，不必改程式、不必重啟。

## 1. 需要你決定的事

| # | 決定 | 建議 |
|---|---|---|
| 1 | 活動設定放哪裡 | **資料庫**（後台即時新增、修改）；另外支援從 JSON 匯入，方便把整季的活動放進版本庫審閱 |
| 2 | 加成型活動的上限 | 經驗與掉落最高 2 倍、同類型不疊加（取最大值）；避免幾個活動疊起來把經濟打壞 |
| 3 | 是否有「付費玩家限定」的活動 | **不要**，與付費原則一致（見 `MONETIZATION.md`） |
| 4 | 時區 | 一律以 `Asia/Taipei` 顯示與輸入，資料庫存 UTC |

## 2. 活動類型

第一版做六種，都是在現有程式的固定接點上掛「倍率」或「額外行為」：

| 類型 | 效果 | 掛在現有程式的哪裡 | 參數 |
|---|---|---|---|
| `exp_bonus` | 打怪經驗倍率 | `MapRoom.onMonsterKilled` 計算每人經驗時 | `multiplier`、選填 `mapIds`、`levelMin/Max` |
| `drop_bonus` | 掉落機率倍率 | `MapRoom.onMonsterKilled` 判定掉落時（機率上限 100%） | `multiplier`、選填 `monsterIds`、`itemIds` |
| `boss_rush` | 首領重生時間倍率 | `MapRoom.respawnDelayMs`（已有 `BOSS_RESPAWN_SCALE` 的機制） | `scale` |
| `login_reward` | 活動期間每日首次登入發道具 | 角色進入房間時檢查，走 `ItemController` 發放並留紀錄 | `items`、`coins` |
| `event_drop` | 指定魔物額外掉落活動道具 | 掉落判定時附加一份掉落表 | `monsterIds`（或全部）、`itemId`、`rate` |
| `shop_sale` | NPC 商店折扣 | `ItemController.handleShopBuy` 計價時 | `npcIds`、`discount` |

活動道具的兌換（例如「收集 30 個南瓜換一頂帽子」）用現有的任務系統就能做：加一個收集類任務，任務本身設上線與下線時間（見 3.3）。

之後可擴充：世界首領（定時在指定地圖出現的活動首領）、答題、限時副本、公會競賽。

## 3. 資料模型

```sql
CREATE TABLE events (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- exp_bonus / drop_bonus / boss_rush / login_reward / event_drop / shop_sale
  type        TEXT        NOT NULL,
  name        TEXT        NOT NULL,          -- 顯示給玩家的名稱
  description TEXT        NOT NULL DEFAULT '',
  -- 各類型自己的參數，格式見第 2 節
  params      JSONB       NOT NULL,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  -- 重複規則（選填）：{"weekdays":[6,0],"from":"20:00","to":"22:00"} 表示期間內每週六日的 20–22 點才生效
  recurrence  JSONB,
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  created_by  INTEGER     NOT NULL,          -- 建立的管理員
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX events_window_idx ON events (starts_at, ends_at) WHERE enabled;

-- 每日登入獎勵的領取紀錄（避免重複領）
CREATE TABLE event_claims (
  event_id     INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL,
  claim_date   DATE    NOT NULL,             -- 以台北時間的日期為準
  PRIMARY KEY (event_id, character_id, claim_date)
);
```

### 3.1 參數範例

```json
{ "type": "exp_bonus", "name": "週末雙倍經驗", "params": { "multiplier": 2 },
  "starts_at": "2027-01-01T00:00:00+08:00", "ends_at": "2027-03-31T23:59:59+08:00",
  "recurrence": { "weekdays": [6, 0], "from": "20:00", "to": "22:00" } }
```

```json
{ "type": "event_drop", "name": "南瓜收集", "params": { "itemId": "event_pumpkin", "rate": 8 },
  "starts_at": "2027-10-20T12:00:00+08:00", "ends_at": "2027-11-03T12:00:00+08:00" }
```

### 3.2 參數驗證

建立與修改時由伺服器驗證，比照 `npm run check:content` 的精神——填錯就擋下，不要等到活動開始才出事：

- 倍率在允許範圍內（經驗、掉落 1–2 倍；首領重生 0.25–1 倍；商店折扣 0.5–1）。
- 引用的地圖、魔物、道具、NPC 代號都存在。
- 登入獎勵的道具數量有上限，且**不可包含商城付費道具**。
- 同類型、時間重疊的活動要提示（不禁止，因為效果取最大值而不是相乘）。

### 3.3 任務的上下線時間

`quests.json` 的任務加兩個選填欄位 `availableFrom`、`availableUntil`。期間外 NPC 不顯示這個任務、不能接；已經接了的可以在結束後一段寬限期內回報（建議 7 天）。這是活動兌換任務需要的唯一改動。

## 4. 伺服器運作方式

```
server/src/events/
  schedule.ts     從資料庫載入活動，每 30 秒重新整理一次；提供查詢函式
  effects.ts      expMultiplier(mapId, level)、dropMultiplier(monsterId, itemId)… 給各接點呼叫
  loginReward.ts  登入獎勵的發放
```

- **載入**：伺服器啟動時載入「已啟用、尚未結束」的活動，之後每 30 秒重新查一次。後台修改後最慢 30 秒生效，不需要重啟。多台伺服器時每台各自查詢，結果一致。
- **判斷是否生效**：純函式 `isActive(event, now)`，考慮起訖時間與重複規則。放在 `shared` 並寫單元測試（跨日、跨週、時區邊界）。
- **取值**：各接點呼叫 `effects.ts` 的函式，回傳目前所有生效活動中的最大倍率；沒有活動時回傳 1，所以**沒有活動時行為與現在完全相同**。
- **開始與結束的公告**：排程偵測到活動由未生效變成生效（或反過來）時，用現有的全伺服器公告機制（`announce:world`）廣播「【活動】週末雙倍經驗開始了！」。
- **用戶端顯示**：新增一個訊息把目前生效的活動清單傳給用戶端，畫面上方顯示小圖示與剩餘時間；進入房間時與清單變動時傳送。
- **登入獎勵**：角色進入房間時，若有生效的登入獎勵活動且今天（台北時間）還沒領，就在同一個資料庫交易內寫入 `event_claims` 並發放道具（主鍵保證不會重複領），`item_log` 記 `event_reward`。背包滿了就不發、不寫領取紀錄，提示玩家清出空間後重新登入。

## 5. 後台

在管理後台加「活動」分頁（GM 可看，管理員可改）：

- 清單：進行中、即將開始、已結束；顯示類型、時間、參數摘要。
- 新增與編輯：依類型顯示對應的表單欄位，時間以台北時間輸入；送出前顯示「這個活動的效果」的白話說明供確認。
- 立即結束、停用、複製成新活動。
- 所有操作寫入 `admin_log`（動作 `event_create`、`event_update`、`event_end`）。
- 匯入 JSON：把一整季排好的活動檔案一次匯入。

## 6. 對經濟的保護

活動是最容易把經濟打壞的地方，設幾道保險：

- **倍率上限寫死在程式裡**，後台填超過會被拒絕；要更高必須改程式並經過審閱。
- **同類型取最大值、不相乘**：雙倍經驗週末 + 新手雙倍，結果是 2 倍不是 4 倍。
- **卡片與首領專屬裝備不受掉落倍率影響**（可設定排除清單，預設排除所有卡片與 `tier = boss` 的專屬掉落），避免稀有物貶值。
- **星幣收入監控的門檻要跟著活動調整**：`security.ts` 的預期收入乘上當下的倍率，否則活動期間會大量誤報。
- **活動結束後檢討**：比較活動前後一週的全服星幣總量、主要素材的 NPC 賣出量、卡片產出數；異常時下次調降。

## 7. 年度活動行事曆（範例）

以台灣玩家的作息與節慶安排，實際日期每年調整：

| 時間 | 活動 | 類型 |
|---|---|---|
| 每週六、日 20:00–22:00 | 週末雙倍經驗 | `exp_bonus` |
| 每週三 | 首領日（重生時間減半） | `boss_rush` |
| 農曆新年（約 1–2 月，連假期間） | 新春登入禮、紅包掉落與兌換 | `login_reward`、`event_drop` + 任務 |
| 4 月初（兒童節、清明連假） | 春季祭：掉落加成、踏青任務 | `drop_bonus` + 任務 |
| 端午（約 6 月） | 粽子收集兌換 | `event_drop` + 任務 |
| 7–8 月暑假 | 暑期登入活動（每日禮）、新地圖開放 | `login_reward` |
| 中秋（約 9 月） | 月餅收集、商店折扣 | `event_drop`、`shop_sale` |
| 10 月底 | 南瓜收集兌換時裝 | `event_drop` + 任務 |
| 12 月下旬–元旦 | 冬季祭：登入禮、雙倍經驗週 | `login_reward`、`exp_bonus` |
| 開服週年 | 週年慶：全部類型小幅開放 | 多種 |

暑假與寒假是學生玩家上線高峰，也是未成年儲值爭議的高峰，客服人力要跟著排（見 `SUPPORT.md`）。

## 8. 實作順序

1. `events`、`event_claims` 資料表；`isActive` 純函式與測試。
2. `schedule.ts`、`effects.ts`，先接 `exp_bonus` 與 `drop_bonus` 兩個接點。
3. 開始與結束的公告、用戶端的活動顯示。
4. 後台的活動分頁與參數驗證。
5. `login_reward`、`event_drop`、`boss_rush`、`shop_sale`。
6. 任務的上下線時間。
7. 煙霧測試：建立一個立即生效的雙倍經驗活動，確認擊殺經驗加倍、結束後恢復。
