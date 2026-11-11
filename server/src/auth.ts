// 密碼雜湊（bcrypt）與登入憑證（JWT）

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from './config';

/** JWT 驗證通過後得到的身分 */
export interface AuthIdentity {
  accountId: number;
  username: string;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, config.bcryptRounds);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** 帳號不存在時也拿這個雜湊比對一次，讓回應時間與「密碼錯誤」相近，避免被用來探測帳號是否存在 */
const dummyHash = bcrypt.hashSync('dummy-password-for-timing', config.bcryptRounds);

export async function verifyPasswordDummy(password: string): Promise<void> {
  await bcrypt.compare(password, dummyHash);
}

export function signToken(identity: AuthIdentity): string {
  return jwt.sign({ name: identity.username }, config.jwtSecret, {
    algorithm: 'HS256',
    subject: String(identity.accountId),
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

/** 驗證 JWT；無效或過期時回傳 null */
export function verifyToken(token: unknown): AuthIdentity | null {
  if (typeof token !== 'string' || token.length === 0) {
    return null;
  }
  try {
    // 明確限定演算法，避免被換成其他演算法的偽造憑證
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload === 'string') {
      return null;
    }
    const accountId = Number(payload.sub);
    const username = (payload as { name?: unknown }).name;
    if (!Number.isInteger(accountId) || typeof username !== 'string') {
      return null;
    }
    return { accountId, username };
  } catch {
    return null;
  }
}
