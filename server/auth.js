// 登入與權限。密碼以 scrypt 雜湊，格式「scrypt:鹽:雜湊」（十六進位），與匯入腳本相同。
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { query } from './db.js';
import { HttpError } from './errors.js';

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function checkPassword(password, stored) {
  const [kind, salt, hash] = stored.split(':');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

/** 目前登入的人（每次都重新查，被停權就立刻失效：規則 R2） */
export async function currentUser(req) {
  if (!req.session.userId) return null;
  const [user] = await query(
    `SELECT user_id, email, display_name, role FROM users WHERE user_id = $1 AND status = 'active'`,
    [req.session.userId],
  );
  return user ?? null;
}

export function requireUser(req, res, next) {
  currentUser(req).then((user) => {
    if (!user) return next(new HttpError(401, '請先登入'));
    req.user = user;
    next();
  }, next);
}

export function requireEditor(req, res, next) {
  requireUser(req, res, (err) => {
    if (err) return next(err);
    if (req.user.role !== 'editor') return next(new HttpError(403, '只有編輯可以使用'));
    next();
  });
}
