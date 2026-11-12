-- 003：公會、好友、任務進度、首領重生計時

-- 公會
CREATE TABLE guilds (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT        NOT NULL,
  leader_id  INTEGER     NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 公會名稱不分大小寫，不可重複
CREATE UNIQUE INDEX guilds_name_lower_key ON guilds (lower(name));

-- 公會成員：一個角色只能加入一個公會
CREATE TABLE guild_members (
  character_id INTEGER     PRIMARY KEY REFERENCES characters (id) ON DELETE CASCADE,
  guild_id     INTEGER     NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guild_members_guild_idx ON guild_members (guild_id);

-- 好友：雙向關係存成兩列（甲→乙、乙→甲），查詢「我的好友」只需要看 character_id
CREATE TABLE friends (
  character_id INTEGER     NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  friend_id    INTEGER     NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id, friend_id),
  CHECK (character_id <> friend_id)
);

-- 任務進度：一列是一個角色的一個任務
CREATE TABLE character_quests (
  character_id INTEGER     NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  -- 對應 shared/data/quests.json 的 id
  quest_id     TEXT        NOT NULL,
  status       TEXT        NOT NULL CHECK (status IN ('active', 'done')),
  -- 各目標的累計數量（只有擊殺類會累計）
  progress     INTEGER[]   NOT NULL DEFAULT '{}',
  accepted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (character_id, quest_id)
);

-- 首領重生計時：首領被擊倒後記下重生時間。
-- 地圖房間沒人時會關閉，重開時依這張表決定首領是否已經可以出現，避免「出去再進來」就能重刷。
CREATE TABLE boss_timers (
  map_id     TEXT        NOT NULL,
  -- 地圖 monster_spawns 層中重生區的名稱
  spawn_name TEXT        NOT NULL,
  respawn_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (map_id, spawn_name)
);
