-- 004：管理員角色、封鎖、GM 操作紀錄、安全事件

-- 帳號角色：player 一般玩家、gm 可查詢／封鎖／公告、admin 另可發放道具
ALTER TABLE accounts
  ADD COLUMN role         TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'gm', 'admin')),
  -- 封鎖到什麼時候；NULL 或已過期表示沒有被封鎖
  ADD COLUMN banned_until TIMESTAMPTZ,
  ADD COLUMN ban_reason   TEXT;

-- GM 操作紀錄：誰在什麼時候對誰做了什麼。只會新增，不會修改或刪除。
CREATE TABLE admin_log (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  admin_account_id    INTEGER     NOT NULL,
  admin_username      TEXT        NOT NULL,
  -- ban、unban、grant、announce
  action              TEXT        NOT NULL,
  target_account_id   INTEGER,
  target_character_id INTEGER,
  detail              JSONB
);
CREATE INDEX admin_log_created_idx ON admin_log (created_at DESC);

-- 安全事件：防外掛偵測、登入異常、經濟異常、伺服器錯誤
CREATE TABLE security_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- info 紀錄、warn 值得留意、alert 需要處理（會另外發送警示）
  level        TEXT        NOT NULL CHECK (level IN ('info', 'warn', 'alert')),
  -- 事件種類，例如 cheat_kick、cheat_warn、login_failures、coin_rate、server_error
  kind         TEXT        NOT NULL,
  account_id   INTEGER,
  character_id INTEGER,
  message      TEXT        NOT NULL,
  detail       JSONB
);
CREATE INDEX security_events_created_idx ON security_events (created_at DESC);
CREATE INDEX security_events_character_idx ON security_events (character_id) WHERE character_id IS NOT NULL;
