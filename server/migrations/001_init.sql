-- 001：帳號、角色、背包

-- 帳號
CREATE TABLE accounts (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      TEXT        NOT NULL,
  -- bcrypt 雜湊（含鹽與成本參數），絕不儲存明碼
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
-- 帳號不分大小寫，且不可重複
CREATE UNIQUE INDEX accounts_username_lower_key ON accounts (lower(username));

-- 角色
CREATE TABLE characters (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     INTEGER     NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name           TEXT        NOT NULL,
  -- 對應 shared/data/classes.json 的 id
  class_id       TEXT        NOT NULL,
  level          INTEGER     NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 100),
  exp            BIGINT      NOT NULL DEFAULT 0 CHECK (exp >= 0),
  -- 尚未分配的素質點與六項素質
  stat_points    INTEGER     NOT NULL DEFAULT 0 CHECK (stat_points >= 0),
  stat_pow       INTEGER     NOT NULL DEFAULT 5 CHECK (stat_pow BETWEEN 1 AND 100),
  stat_swf       INTEGER     NOT NULL DEFAULT 5 CHECK (stat_swf BETWEEN 1 AND 100),
  stat_con       INTEGER     NOT NULL DEFAULT 5 CHECK (stat_con BETWEEN 1 AND 100),
  stat_mnd       INTEGER     NOT NULL DEFAULT 5 CHECK (stat_mnd BETWEEN 1 AND 100),
  stat_foc       INTEGER     NOT NULL DEFAULT 5 CHECK (stat_foc BETWEEN 1 AND 100),
  stat_for       INTEGER     NOT NULL DEFAULT 5 CHECK (stat_for BETWEEN 1 AND 100),
  -- 目前 HP／SP（上限由等級、職業、素質即時計算，不存資料庫）
  hp             INTEGER     NOT NULL CHECK (hp >= 0),
  sp             INTEGER     NOT NULL CHECK (sp >= 0),
  coins          BIGINT      NOT NULL DEFAULT 0 CHECK (coins >= 0),
  -- 所在地圖與位置（格座標，浮點數）
  map_id         TEXT        NOT NULL,
  x              DOUBLE PRECISION NOT NULL,
  y              DOUBLE PRECISION NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 最後一次存檔時間
  saved_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 角色名稱不分大小寫，全伺服器不可重複
CREATE UNIQUE INDEX characters_name_lower_key ON characters (lower(name));
CREATE INDEX characters_account_id_idx ON characters (account_id);

-- 背包：一列是一格
CREATE TABLE character_items (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  -- 格子位置（0 起算）
  slot         INTEGER NOT NULL CHECK (slot >= 0),
  -- 對應 shared/data/items.json 的 id
  item_id      TEXT    NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  UNIQUE (character_id, slot)
);
