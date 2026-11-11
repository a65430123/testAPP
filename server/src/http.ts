// HTTP API：註冊、登入、角色列表、建立角色

import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import {
  getClassDef,
  MAX_CHARACTERS_PER_ACCOUNT,
  START_MAP_ID,
  validateName,
  validatePassword,
  validateUsername,
  type AuthResponse,
  type CharacterListResponse,
  type CreateCharacterResponse,
  type ErrorResponse,
} from '@starmemory/shared';
import {
  hashPassword,
  signToken,
  verifyPassword,
  verifyPasswordDummy,
  verifyToken,
  type AuthIdentity,
} from './auth';
import { config } from './config';
import { createAccount, findAccountByUsername, touchLastLogin, UsernameTakenError } from './db/accounts';
import {
  CharacterLimitError,
  CharacterNameTakenError,
  createCharacter,
  listCharacters,
} from './db/characters';
import { getMap } from './maps';

/** 註冊與登入：同一 IP 每分鐘最多嘗試次數（防止暴力猜密碼） */
const AUTH_ATTEMPTS_PER_MINUTE = 20;

function sendError(res: Response, status: number, error: string): void {
  const body: ErrorResponse = { error };
  res.status(status).json(body);
}

/** 簡易的每 IP 頻率限制（存在記憶體中） */
function rateLimit(maxPerMinute: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (entry.resetAt <= now) {
        hits.delete(ip);
      }
    }
  }, 60_000).unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + 60_000 };
      hits.set(ip, entry);
    }
    entry.count++;
    if (entry.count > maxPerMinute) {
      sendError(res, 429, '嘗試次數過多，請稍後再試');
      return;
    }
    next();
  };
}

/** 從 Authorization: Bearer <JWT> 取得身分；失敗時回應 401 */
function requireAuth(req: Request, res: Response): AuthIdentity | null {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const identity = verifyToken(token);
  if (!identity) {
    sendError(res, 401, '登入已失效，請重新登入');
  }
  return identity;
}

export function registerRoutes(app: Application): void {
  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }

  // 用戶端開發伺服器（5173 埠）與遊戲伺服器不同來源，API 需要 CORS 標頭
  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use('/api', express.json({ limit: '2kb' }));

  const authLimiter = rateLimit(AUTH_ATTEMPTS_PER_MINUTE);

  // 註冊
  app.post('/api/register', authLimiter, async (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const invalid = validateUsername(username) ?? validatePassword(password);
    if (invalid) {
      sendError(res, 400, invalid);
      return;
    }
    try {
      const account = await createAccount(username as string, await hashPassword(password as string));
      const body: AuthResponse = {
        token: signToken({ accountId: account.id, username: account.username }),
        username: account.username,
      };
      res.status(201).json(body);
    } catch (err) {
      if (err instanceof UsernameTakenError) {
        sendError(res, 409, '這個帳號已經有人使用');
        return;
      }
      throw err;
    }
  });

  // 登入
  app.post('/api/login', authLimiter, async (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== 'string' || typeof password !== 'string') {
      sendError(res, 400, '請輸入帳號與密碼');
      return;
    }
    const account = await findAccountByUsername(username);
    let ok = false;
    if (account) {
      ok = await verifyPassword(password, account.passwordHash);
    } else {
      await verifyPasswordDummy(password);
    }
    if (!account || !ok) {
      // 不區分「帳號不存在」與「密碼錯誤」
      sendError(res, 401, '帳號或密碼錯誤');
      return;
    }
    await touchLastLogin(account.id);
    const body: AuthResponse = {
      token: signToken({ accountId: account.id, username: account.username }),
      username: account.username,
    };
    res.json(body);
  });

  // 角色列表
  app.get('/api/characters', async (req, res) => {
    const identity = requireAuth(req, res);
    if (!identity) {
      return;
    }
    const body: CharacterListResponse = {
      characters: await listCharacters(identity.accountId),
      maxCharacters: MAX_CHARACTERS_PER_ACCOUNT,
    };
    res.json(body);
  });

  // 建立角色
  app.post('/api/characters', async (req, res) => {
    const identity = requireAuth(req, res);
    if (!identity) {
      return;
    }
    const { name, classId } = (req.body ?? {}) as { name?: unknown; classId?: unknown };
    const invalid = validateName(name);
    if (invalid) {
      sendError(res, 400, invalid);
      return;
    }
    const cls = typeof classId === 'string' ? getClassDef(classId) : undefined;
    if (!cls) {
      sendError(res, 400, '請選擇職業');
      return;
    }
    const startMap = getMap(START_MAP_ID);
    if (!startMap) {
      throw new Error(`找不到起始地圖 ${START_MAP_ID}`);
    }
    try {
      const character = await createCharacter(identity.accountId, (name as string).trim(), cls, {
        mapId: startMap.id,
        x: startMap.spawn.x,
        y: startMap.spawn.y,
      });
      const body: CreateCharacterResponse = { character };
      res.status(201).json(body);
    } catch (err) {
      if (err instanceof CharacterNameTakenError) {
        sendError(res, 409, '這個角色名稱已經有人使用');
        return;
      }
      if (err instanceof CharacterLimitError) {
        sendError(res, 409, `每個帳號最多 ${MAX_CHARACTERS_PER_ACCOUNT} 個角色`);
        return;
      }
      throw err;
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // 未預期的錯誤：記錄在伺服器，不把內部細節回傳給用戶端
  app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (typeof err === 'object' && err !== null && (err as { type?: string }).type?.startsWith('entity.')) {
      sendError(res, 400, '請求內容格式錯誤');
      return;
    }
    console.error('[http] 未預期的錯誤：', err);
    sendError(res, 500, '伺服器發生錯誤，請稍後再試');
  });
}
