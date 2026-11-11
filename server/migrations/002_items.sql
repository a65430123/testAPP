-- 002：道具實體（唯一編號）、裝備欄、倉庫、道具異動紀錄

-- 道具實體：背包、身上的裝備、倉庫裡的每一格（每一疊）都是一列。
-- uid 是主鍵，同一個道具實體在整個資料庫只能存在一筆，任何程式錯誤都無法寫入複製品。
CREATE TABLE items (
  uid          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 擁有者：背包與裝備屬於角色，倉庫屬於帳號（同帳號的角色共用）
  character_id INTEGER REFERENCES characters (id) ON DELETE CASCADE,
  account_id   INTEGER REFERENCES accounts (id) ON DELETE CASCADE,
  location     TEXT    NOT NULL CHECK (location IN ('bag', 'equip', 'storage')),
  -- 背包／倉庫的格子位置，或裝備欄位編號（0 武器 … 8 飾品 2）
  slot         INTEGER NOT NULL CHECK (slot >= 0),
  -- 對應 shared/data/items.json 的 id
  item_id      TEXT    NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  refine       INTEGER NOT NULL DEFAULT 0 CHECK (refine BETWEEN 0 AND 10),
  card_slots   INTEGER NOT NULL DEFAULT 0 CHECK (card_slots BETWEEN 0 AND 3),
  -- 已鑲嵌的卡片（道具代號）
  cards        TEXT[]  NOT NULL DEFAULT '{}',
  CHECK (cardinality(cards) <= card_slots),
  CHECK (
    (location = 'storage' AND account_id IS NOT NULL AND character_id IS NULL)
    OR (location <> 'storage' AND character_id IS NOT NULL AND account_id IS NULL)
  )
);
-- 同一個容器的同一格只能有一個道具
CREATE UNIQUE INDEX items_character_slot_key ON items (character_id, location, slot) WHERE character_id IS NOT NULL;
CREATE UNIQUE INDEX items_storage_slot_key ON items (account_id, slot) WHERE account_id IS NOT NULL;

-- 把舊的背包資料搬進新資料表
INSERT INTO items (character_id, location, slot, item_id, quantity)
SELECT character_id, 'bag', slot, item_id, quantity FROM character_items;
DROP TABLE character_items;

-- 道具異動紀錄：每一次道具或星幣的產生、消耗、轉移都留下一列，與異動本身在同一個交易內寫入。
-- 只會新增，不會修改或刪除；也不設外鍵，角色刪除後紀錄仍然保留。
CREATE TABLE item_log (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- 同一次操作產生的多列紀錄共用同一個 tx（例如一次交易的每個道具各一列）
  tx                 UUID        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 操作種類：create、pickup、use、gm、shop_buy、shop_sell、refine、card_insert、
  -- storage_in、storage_out、trade_out、trade_in
  action             TEXT        NOT NULL,
  character_id       INTEGER     NOT NULL,
  -- 交易的對方
  other_character_id INTEGER,
  item_uid           UUID,
  item_id            TEXT,
  -- 這個角色的道具數量變化（正數取得、負數失去）
  quantity           INTEGER     NOT NULL DEFAULT 0,
  -- 這個角色的星幣變化
  coins              BIGINT      NOT NULL DEFAULT 0,
  -- 其他細節（精煉前後等級、成功與否、稅額…）
  detail             JSONB
);
CREATE INDEX item_log_character_idx ON item_log (character_id, created_at);
CREATE INDEX item_log_item_uid_idx ON item_log (item_uid) WHERE item_uid IS NOT NULL;
CREATE INDEX item_log_tx_idx ON item_log (tx);
