// ⑥ 回報處理：只有編輯能用
import { Router } from 'express';
import { query } from '../db.js';
import { requireEditor } from '../auth.js';
import { handle } from '../errors.js';

export const reports = Router();

reports.get('/reports', requireEditor, handle(async (req, res) => {
  const open = req.query.status !== 'handled';
  res.json({ reports: await query(
    `SELECT r.report_id, r.kind, r.note, r.status, r.created_at, r.handled_at,
            u.display_name AS reporter, h.display_name AS handler,
            e.entry_id, e.bopomofo, e.frequency, e.status AS entry_status, e.row_version, w.text, s.name AS source,
            (SELECT count(*) FROM reports o WHERE o.entry_id = r.entry_id AND o.status = 'open') AS open_on_entry
       FROM reports r
       JOIN users u ON u.user_id = r.user_id
       LEFT JOIN users h ON h.user_id = r.handler_id
       JOIN lexicon_entries e USING (entry_id) JOIN words w USING (word_id) JOIN sources s USING (source_id)
      WHERE ${open ? `r.status = 'open'` : `r.status <> 'open'`}
      ORDER BY ${open ? 'r.created_at' : 'r.handled_at DESC'}
      LIMIT 100`) });
}));

// resolution：dismiss 駁回、remove 停用、reweight 調詞頻、fix_reading 修正讀音（停用＋新增，占一個名額）
reports.post('/reports/:id/resolve', requireEditor, handle(async (req, res) => {
  const { resolution, entry_row_version: rv, new_frequency: freq, new_bopomofo: bopomofo } = req.body;
  await query('SELECT resolve_report($1, $2, $3, $4, $5, $6)', [
    req.params.id, req.user.user_id, resolution, rv ?? null, freq ?? null,
    bopomofo ? String(bopomofo).trim().replace(/\s+/g, ' ') : null]);
  res.json({ ok: true });
}));
