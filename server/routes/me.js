// ③ 我的：裝置、回報、個人詞、詞庫包訂閱；以及輸入法同步個人詞用的 API
import { Router } from 'express';
import { query } from '../db.js';
import { requireUser } from '../auth.js';
import { handle, HttpError } from '../errors.js';

export const me = Router();

// ---------- 輸入法同步個人詞（不用登入，用已綁定的裝置識別） ----------
// GET /api/devices/<uuid>/personal-words?since=<時間>：只回傳那之後有變動的（含刪除標記，R19）
me.get('/devices/:deviceId/personal-words', handle(async (req, res) => {
  const [device] = await query('SELECT user_id FROM devices WHERE device_id = $1', [req.params.deviceId]);
  if (!device?.user_id) throw new HttpError(404, '這台裝置還沒綁定帳號');
  const since = req.query.since ? new Date(String(req.query.since)) : new Date(0);
  const words = await query(
    `SELECT w.text, p.bopomofo, p.status, p.updated_at
       FROM personal_words p JOIN words w USING (word_id)
      WHERE p.user_id = $1 AND p.updated_at > $2
      ORDER BY p.updated_at`, [device.user_id, since]);   // personal_words_sync 索引
  // 多取一段時間：同步期間別的裝置剛好在改，下次還會拿到，由裝置端依主鍵去重
  res.json({ words, next_since: new Date(Date.now() - 60_000) });
}));

me.use('/me', requireUser);

// ---------- 裝置 ----------
me.get('/me/devices', handle(async (req, res) => {
  res.json({ devices: await query(
    `SELECT d.device_id, d.platform, d.app_version, d.first_seen, d.last_synced_at,
            (SELECT count(*) FROM submissions s WHERE s.device_id = d.device_id) AS submissions
       FROM devices d WHERE d.user_id = $1 ORDER BY d.last_synced_at DESC`, [req.user.user_id]) });
}));

// 綁定：把匿名裝置歸到這個帳號（R3：一台裝置最多綁一個帳號）
me.post('/me/devices', handle(async (req, res) => {
  const rows = await query(
    `UPDATE devices SET user_id = $1 WHERE device_id = $2 AND user_id IS NULL AND platform <> 'web' RETURNING device_id`,
    [req.user.user_id, String(req.body.device_id ?? '').trim()]);
  if (rows.length === 0) throw new HttpError(404, '找不到這台裝置，或它已經綁定其他帳號');
  res.json({ ok: true });
}));

me.delete('/me/devices/:deviceId', handle(async (req, res) => {
  await query(`UPDATE devices SET user_id = NULL WHERE device_id = $1 AND user_id = $2 AND platform <> 'web'`,
    [req.params.deviceId, req.user.user_id]);
  res.json({ ok: true });
}));

// ---------- 我的回報 ----------
me.get('/me/reports', handle(async (req, res) => {
  res.json({ reports: await query(
    `SELECT r.report_id, r.kind, r.note, r.status, r.created_at, r.handled_at, w.text, e.bopomofo, e.status AS entry_status
       FROM reports r JOIN lexicon_entries e USING (entry_id) JOIN words w USING (word_id)
      WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [req.user.user_id]) });
}));

// ---------- 個人詞 ----------
me.get('/me/personal-words', handle(async (req, res) => {
  res.json({ words: await query(
    `SELECT w.word_id, w.text, p.bopomofo, p.updated_at,
            EXISTS (SELECT 1 FROM lexicon_entries e WHERE e.word_id = p.word_id AND e.status = 'active') AS in_lexicon
       FROM personal_words p JOIN words w USING (word_id)
      WHERE p.user_id = $1 AND p.status = 'active' ORDER BY p.updated_at DESC`, [req.user.user_id]) });
}));

me.post('/me/personal-words', handle(async (req, res) => {
  const text = String(req.body.text ?? '').trim();
  const bopomofo = String(req.body.bopomofo ?? '').trim().replace(/\s+/g, ' ');
  await query('INSERT INTO words (text) VALUES ($1) ON CONFLICT DO NOTHING', [text]);
  // 刪掉過再加回來：同一筆改回 active（R19：以使用者、詞、讀音為單位不重複）
  await query(
    `INSERT INTO personal_words (user_id, word_id, bopomofo)
     SELECT $1, word_id, $3 FROM words WHERE text = $2
     ON CONFLICT (user_id, word_id, bopomofo) DO UPDATE SET status = 'active', updated_at = now()`,
    [req.user.user_id, text, bopomofo]);
  res.json({ ok: true });
}));

me.delete('/me/personal-words/:wordId', handle(async (req, res) => {
  await query(
    `UPDATE personal_words SET status = 'deleted', updated_at = now()
      WHERE user_id = $1 AND word_id = $2 AND bopomofo = $3`,
    [req.user.user_id, req.params.wordId, String(req.query.bopomofo ?? '')]);
  res.json({ ok: true });
}));

// ---------- 詞庫包 ----------
me.get('/me/packs', handle(async (req, res) => {
  res.json({ packs: await query(
    `SELECT p.pack_id, p.name, p.description,
            (SELECT count(*) FROM pack_entries pe WHERE pe.pack_id = p.pack_id) AS entries,
            (SELECT count(*) FROM subscriptions s WHERE s.pack_id = p.pack_id AND s.status = 'active') AS subscribers,
            coalesce(my.status = 'active', false) AS subscribed
       FROM packs p LEFT JOIN subscriptions my ON my.pack_id = p.pack_id AND my.user_id = $1
      WHERE p.status = 'published' OR my.status = 'active'
      ORDER BY subscribers DESC`, [req.user.user_id]) });
}));

me.post('/me/packs/:packId', handle(async (req, res) => {
  const status = req.body.subscribe ? 'active' : 'cancelled';
  // 重新訂閱時更新原本那一筆；只能訂上架中的詞庫包，由 trigger 檢查（R20）
  await query(
    `INSERT INTO subscriptions (user_id, pack_id, status) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, pack_id) DO UPDATE SET status = EXCLUDED.status, subscribed_at = now()`,
    [req.user.user_id, req.params.packId, status]);
  res.json({ ok: true });
}));
