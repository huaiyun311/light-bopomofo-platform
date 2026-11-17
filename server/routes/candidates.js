// ② 待審新詞：依熱門度排序、投票
import { Router } from 'express';
import { query } from '../db.js';
import { requireUser } from '../auth.js';
import { handle, HttpError } from '../errors.js';

export const candidates = Router();

const ORDER = {
  devices: 'bound_devices DESC, devices DESC',
  uses: 'uses DESC',
  votes: 'net_votes DESC, devices DESC',
  recent: 'last_seen DESC',
};

/**
 * 待審列表：系統裡最慢的查詢（合併 95 萬筆投稿與 15 萬筆投票）。
 * 寫法是「先各自依詞彙總，再 JOIN」；bench/ 會比較其他寫法。
 *  - 已綁定帳號與匿名的裝置分開計數，排序以綁定的為主（匿名 UUID 可以亂造）
 *  - 停權與刪除帳號的票不算（R2）
 *  - 審核狀態即時 JOIN word_reviews，審過的詞馬上從列表消失（R6）
 */
export const CANDIDATES_SQL = (order) => `
  WITH s AS (
    SELECT s.word_id,
           count(DISTINCT s.device_id) AS devices,
           count(DISTINCT s.device_id) FILTER (WHERE d.user_id IS NOT NULL) AS bound_devices,
           sum(s.use_count) AS uses,
           max(s.last_seen) AS last_seen
      FROM submissions s JOIN devices d USING (device_id)
     GROUP BY s.word_id
  ), v AS (
    SELECT v.word_id, sum(v.value) AS net_votes, count(*) AS votes
      FROM votes v JOIN users u USING (user_id)
     WHERE u.status = 'active'
     GROUP BY v.word_id
  )
  SELECT w.word_id, w.text, r.row_version, s.devices, s.bound_devices, s.uses, s.last_seen,
         coalesce(v.net_votes, 0) AS net_votes, coalesce(v.votes, 0) AS votes,
         my.value AS my_vote
    FROM word_reviews r
    JOIN words w USING (word_id)
    JOIN s USING (word_id)
    LEFT JOIN v USING (word_id)
    LEFT JOIN votes my ON my.word_id = r.word_id AND my.user_id = $1
   WHERE r.status = 'pending'
   ORDER BY ${order}
   LIMIT $2 OFFSET $3`;

candidates.get('/candidates', handle(async (req, res) => {
  const order = ORDER[req.query.sort] ?? ORDER.devices;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const rows = await query(CANDIDATES_SQL(order), [req.session.userId ?? null, limit, offset]);
  res.json({ candidates: rows });
}));

// 投票：value = 1 讚、-1 倒讚、0 收回。只能投待審中的詞，由 trigger 檢查（R8）
candidates.post('/candidates/:wordId/vote', requireUser, handle(async (req, res) => {
  const value = Number(req.body.value);
  if (![1, -1, 0].includes(value)) throw new HttpError(400, 'value 只能是 1、-1 或 0');
  if (value === 0) {
    await query('DELETE FROM votes WHERE user_id = $1 AND word_id = $2', [req.user.user_id, req.params.wordId]);
  } else {
    await query(
      `INSERT INTO votes (user_id, word_id, value) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, word_id) DO UPDATE SET value = EXCLUDED.value, voted_at = now()`,
      [req.user.user_id, req.params.wordId, value]);
  }
  const [counts] = await query(
    `SELECT coalesce(sum(v.value), 0) AS net_votes, count(*) AS votes
       FROM votes v JOIN users u USING (user_id) WHERE v.word_id = $1 AND u.status = 'active'`,
    [req.params.wordId]);
  res.json({ ...counts, my_vote: value || null });
}));
