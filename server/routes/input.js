// 輸入法用的 API：分享新詞（格式與輕注音現有的 /api/words 相同，輸入法不用改）
//   POST /api/words  {"device": "<uuid>", "app": "8.0", "platform": "macos", "words": [{"text", "typed", "count"}]}
import { Router } from 'express';
import { query } from '../db.js';
import { handle, HttpError } from '../errors.js';

export const input = Router();

// 匿名裝置的 UUID 可以隨便造：同一個 IP 每分鐘最多 30 次上傳
const recent = new Map();
function rateLimit(req) {
  const now = Date.now();
  const hits = (recent.get(req.ip) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= 30) throw new HttpError(429, '上傳太頻繁，請稍後再試');
  recent.set(req.ip, [...hits, now]);
}

input.post('/words', handle(async (req, res) => {
  rateLimit(req);
  const { device, app, platform = 'macos', words } = req.body;
  if (!Array.isArray(words) || words.length > 500) throw new HttpError(400, 'words 必須是陣列，最多 500 個');
  if (!['macos', 'windows'].includes(platform)) throw new HttpError(400, 'platform 只能是 macos 或 windows');
  const [{ upload_words: result }] = await query(
    'SELECT upload_words($1, $2, $3, $4)', [device, platform, String(app ?? ''), JSON.stringify(words)]);
  res.json(result);
}));
