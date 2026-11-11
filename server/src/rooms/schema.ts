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
  },
  'PlayerState',
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const MapState = schema(
  {
    mapId: t.string(),
    /** 以連線代號（sessionId）為鍵 */
    players: t.map(PlayerState),
  },
  'MapState',
);
export type MapState = SchemaType<typeof MapState>;
