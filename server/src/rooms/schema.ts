// 房間的同步狀態：這裡的欄位會自動同步給房間內所有用戶端（所以只放公開資訊）

import { schema, t, type SchemaType } from '@colyseus/schema';

export const PlayerState = schema(
  {
    name: t.string(),
    classId: t.string(),
    level: t.number(),
    /** 位置（格座標，浮點數） */
    x: t.number(),
    y: t.number(),
    /** HP 為 0 表示已被擊倒 */
    hp: t.number(),
    maxHp: t.number(),
  },
  'PlayerState',
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const MonsterState = schema(
  {
    /** 對應 shared/data/monsters.json 的 id */
    monsterId: t.string(),
    x: t.number(),
    y: t.number(),
    hp: t.number(),
    maxHp: t.number(),
  },
  'MonsterState',
);
export type MonsterState = SchemaType<typeof MonsterState>;

export const DropState = schema(
  {
    itemId: t.string(),
    quantity: t.number(),
    x: t.number(),
    y: t.number(),
    /** 保護期間內只有這位玩家（連線代號）能撿；空字串表示任何人都能撿 */
    owner: t.string(),
  },
  'DropState',
);
export type DropState = SchemaType<typeof DropState>;

export const MapState = schema(
  {
    mapId: t.string(),
    /** 以連線代號（sessionId）為鍵 */
    players: t.map(PlayerState),
    /** 以伺服器配發的編號為鍵，例如 m12 */
    monsters: t.map(MonsterState),
    /** 地上的掉落物，例如 d7 */
    drops: t.map(DropState),
  },
  'MapState',
);
export type MapState = SchemaType<typeof MapState>;
