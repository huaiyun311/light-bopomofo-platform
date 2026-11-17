// ② 待審新詞：依熱門度排序、投票
import { Router } from 'express';
import { query } from '../db.js';
import { requireUser } from '../auth.js';
import { handle, HttpError } from '../errors.js';

export const candidates = Router();

const ORDER = {
  devices: 'c.bound_devices DESC, c.devices DESC',
  uses: 'c.uses DESC',
  votes: 'net_votes DESC, c.devices DESC',
  recent: 'c.last_seen DESC',
};

/**
 * 待審列表：系統裡最慢的查詢。bench/candidates.sql 比較了三種寫法：
 *   A. 全部 JOIN 再 GROUP BY：約 9 秒，而且使用次數會被票數乘開，算錯
 *   B. 投稿與票數各自彙總再 JOIN：約 0.9 秒
 *   C. 投稿統計事先算好（materialized view candidate_stats，04_views.sql），其他即時查：約 8 毫秒 ← 採用
 *  - 已綁定帳號與匿名的裝置分開計數，排序以綁定的為主（匿名 UUID 可以亂造）
 *  - 審核狀態即時 JOIN word_reviews，審過的詞馬上從列表消失（R6）
 *  - 票數即時算，停權與刪除帳號的票不算（R2）；只算這一頁的詞，依票數排序時才全部算
 */
const VOTES_PER_ROW = `
  LEFT JOIN LATERAL (SELECT sum(v.value) AS net_votes, count(*) AS votes
                       FROM votes v JOIN users u USING (user_id)
                      WHERE v.word_id = c.word_id AND u.status = 'active') v ON true`;
const VOTES_ALL = `
  LEFT JOIN (SELECT v.word_id, sum(v.value) AS net_votes, count(*) AS votes
               FROM votes v JOIN users u USING (user_id)
              WHERE u.status = 'active' GROUP BY v.word_id) v USING (word_id)`;

export const CANDIDATES_SQL = (sort) => `
  SELECT w.word_id, w.text, r.row_version, c.devices, c.bound_devices, c.uses, c.last_seen,
         coalesce(v.net_votes, 0) AS net_votes, coalesce(v.votes, 0) AS votes, my.value AS my_vote
    FROM candidate_stats c
    JOIN word_reviews r USING (word_id)
    JOIN words w USING (word_id)
    ${sort === 'votes' ? VOTES_ALL : VOTES_PER_ROW}
    LEFT JOIN votes my ON my.word_id = c.word_id AND my.user_id = $1
   WHERE r.status = 'pending'
   ORDER BY ${ORDER[sort]}
   LIMIT $2 OFFSET $3`;

candidates.get('/candidates', handle(async (req, res) => {
  const sort = ORDER[req.query.sort] ? req.query.sort : 'devices';
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const rows = await query(CANDIDATES_SQL(sort), [req.session.userId ?? null, limit, offset]);
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
