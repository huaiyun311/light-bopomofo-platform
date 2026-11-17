// 帳號：註冊、登入、登出、目前的使用者
import { Router } from 'express';
import { query } from '../db.js';
import { checkPassword, currentUser, hashPassword } from '../auth.js';
import { handle, HttpError } from '../errors.js';

export const account = Router();

account.get('/me', handle(async (req, res) => {
  res.json({ user: await currentUser(req) });
}));

account.post('/login', handle(async (req, res) => {
  const { email, password } = req.body;
  const [user] = await query(
    `SELECT user_id, password_hash, status FROM users WHERE email = lower($1)`, [email ?? '']);
  if (!user || !checkPassword(String(password ?? ''), user.password_hash)) {
    throw new HttpError(401, '帳號或密碼錯誤');
  }
  if (user.status !== 'active') throw new HttpError(403, '這個帳號已被停權');
  req.session.userId = user.user_id;
  res.json({ user: await currentUser(req) });
}));

account.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

account.post('/register', handle(async (req, res) => {
  const { email, password, display_name: name } = req.body;
  if (!email || !password || String(password).length < 8) {
    throw new HttpError(400, '請填寫 email，密碼至少 8 個字元');
  }
  const [user] = await query(
    `INSERT INTO users (email, password_hash, display_name) VALUES (lower($1), $2, $3) RETURNING user_id`,
    [email, hashPassword(String(password)), name || String(email).split('@')[0].slice(0, 30)]);
  req.session.userId = user.user_id;
  res.json({ user: await currentUser(req) });
}));
