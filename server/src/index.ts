// 伺服器進入點：HTTP 登入 API + Colyseus 地圖房間

import express from 'express';
import { Server } from 'colyseus';
import {
  DEFAULT_SERVER_PORT,
  ROOM_MAP,
  validateName,
  type ErrorResponse,
  type LoginResponse,
} from '@starmemory/shared';
import { login } from './accounts';
import { allMaps } from './maps';
import { MapRoom } from './rooms/MapRoom';

const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);
/** 允許呼叫登入 API 的網頁來源；正式環境請設成遊戲網址 */
const corsOrigin = process.env.CORS_ORIGIN ?? '*';

const gameServer = new Server({
  greet: false,
  express: (app) => {
    // 用戶端開發伺服器（5173 埠）與遊戲伺服器不同來源，登入 API 需要 CORS 標頭
    app.use('/api', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });

    app.post('/api/login', express.json({ limit: '1kb' }), (req, res) => {
      const name: unknown = (req.body as { name?: unknown } | undefined)?.name;
      const error = validateName(name);
      if (error) {
        const body: ErrorResponse = { error };
        res.status(400).json(body);
        return;
      }
      const account = login((name as string).trim());
      const body: LoginResponse = { token: account.token, name: account.name, mapId: account.mapId };
      res.json(body);
    });

    app.get('/api/health', (_req, res) => {
      res.json({ ok: true });
    });
  },
});

// 每張地圖一個房間：以 mapId 區分，同一張地圖的玩家會進到同一個房間（滿了才開新的分流）
gameServer.define(ROOM_MAP, MapRoom).filterBy(['mapId']);

await gameServer.listen(port);
console.log(`[server] 已啟動，連接埠 ${port}`);
console.log(`[server] 已載入地圖：${allMaps().map((m) => `${m.id} ${m.displayName}`).join('、')}`);
