// ① 查詢詞庫：首字注音、完整注音、詞的一部分；詞條詳情與回報
import { Router } from 'express';
import { query, record } from '../db.js';
import { requireUser } from '../auth.js';
import { handle, HttpError } from '../errors.js';

export const lexicon = Router();

// 三種查法各用一個索引（01_schema.sql 最後）。只查上線中的詞條：別人的個人詞、待審的詞不會出現。
const SEARCH = {
  initials: `initials(e.bopomofo) LIKE $1 || '%'`,   // lexicon_entries_initials
  bopomofo: `e.bopomofo LIKE $1 || '%'`,             // lexicon_entries_bopomofo
  text: `w.text LIKE '%' || $1 || '%'`,              // words_text_trgm
};

lexicon.get('/lexicon', handle(async (req, res) => {
  const mode = SEARCH[req.query.mode] ? req.query.mode : 'initials';
  // LIKE 的萬用字元要跳脫，使用者打的 % 和 _ 只當一般字元
  const q = String(req.query.q ?? '').trim().replace(/[\\%_]/g, '\\$&');
  if (!q) return res.json({ results: [] });
  const results = await query(
    `SELECT e.entry_id, w.text, e.bopomofo, e.frequency, s.name AS source, e.row_version
       FROM lexicon_entries e JOIN words w USING (word_id) JOIN sources s USING (source_id)
      WHERE e.status = 'active' AND ${SEARCH[mode]}
      ORDER BY e.frequency DESC LIMIT 50`, [q]);
  record('query_logs', {
    user_id: req.session.userId ?? null, mode, query: req.query.q,
    result_count: results.length, top_entry_ids: results.slice(0, 10).map((r) => Number(r.entry_id)),
  });
  res.json({ results });
}));

lexicon.get('/lexicon/:entryId', handle(async (req, res) => {
  const [entry] = await query(
    `SELECT e.entry_id, e.word_id, w.text, e.bopomofo, e.frequency, e.status, e.row_version, w.corpus_count,
            s.name AS source, e.updated_at, u.display_name AS updated_by
       FROM lexicon_entries e JOIN words w USING (word_id) JOIN sources s USING (source_id)
       LEFT JOIN users u ON u.user_id = e.updated_by
      WHERE e.entry_id = $1`, [req.params.entryId]);
  if (!entry) throw new HttpError(404, '找不到這個詞條');
  // 常接在後面的詞（主鍵）與常出現在前面的詞（word_pairs_next 索引）
  const [next, prev, history] = await Promise.all([
    query(`SELECT w.text, p.pmi FROM word_pairs p JOIN words w ON w.word_id = p.next_word_id
            WHERE p.word_id = $1 ORDER BY p.pmi DESC LIMIT 10`, [entry.word_id]),
    query(`SELECT w.text, p.pmi FROM word_pairs p JOIN words w ON w.word_id = p.word_id
            WHERE p.next_word_id = $1 ORDER BY p.pmi DESC LIMIT 10`, [entry.word_id]),
    query(`SELECT r.version, r.status, r.published_at, c.action, c.old_frequency, c.new_frequency
             FROM release_changes c JOIN releases r USING (release_id)
            WHERE c.entry_id = $1 ORDER BY version_key(r.version)`, [entry.entry_id]),
  ]);
  res.json({ entry, next, prev, history });
}));

lexicon.post('/lexicon/:entryId/reports', requireUser, handle(async (req, res) => {
  const { kind, note } = req.body;
  const [report] = await query(
    `INSERT INTO reports (user_id, entry_id, kind, note) VALUES ($1, $2, $3, NULLIF($4, '')) RETURNING report_id`,
    [req.user.user_id, req.params.entryId, kind, note ?? '']);
  res.json(report);
}));
