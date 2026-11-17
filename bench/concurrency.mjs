// 併行測試：透過網頁 API 同時送出 100 個請求，驗證資料不會錯。跑完會把資料還原。
// 用法：bash bench/run.sh（在 web 容器裡執行，才連得到 API 和資料庫）
//
//   1. 搶最後一個新詞名額：100 個「加入」同時送出 → 只有 1 個成功，其餘收到「名額已滿」，不會超賣
//   2. 兩位編輯同時審同一個詞：20 個決定同時送出 → 只有 1 個生效，其餘收到「已被其他編輯處理」
//   3. 100 人同時投同一個詞：淨票剛好增加 100，不會少算
//   4. 100 台裝置同時上傳同一個新詞：詞和待審紀錄各只建立一筆，投稿 100 筆，沒有任何錯誤
import pg from 'pg';
import { MongoClient } from 'mongodb';

const BASE = 'http://localhost:3000/api';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql, params) => (await db.query(sql, params)).rows;
const started = new Date();

/** 一個登入後的使用者：自己保存 cookie */
async function session(email) {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo1234' }),
  });
  if (!res.ok) throw new Error(`${email} 登入失敗`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (path, body) => fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie },
    body: body && JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
}

const tally = (results) => results.reduce((m, r) => {
  const key = r.status === 200 ? '成功' : `${r.status} ${r.code ?? ''} ${r.error}`;
  m[key] = (m[key] ?? 0) + 1;
  return m;
}, {});
const check = (ok, text) => console.log(`${ok ? '✓' : '✗'} ${text}`);
const timed = async (fn) => { const t = Date.now(); const r = await fn(); return [r, Date.now() - t]; };

const editorA = await session('editor@lightbopomofo.test');
const editorB = await session('editor3@lightbopomofo.test');

// ---------- 1. 搶最後一個名額 ----------
console.log('\n== 1. 100 個「加入」同時搶最後一個新詞名額');
const [draft] = await q(`SELECT release_id, version, max_new_words, used_quota(release_id) AS used FROM releases WHERE status = 'draft'`);
if (draft.max_new_words - draft.used !== 1) {
  console.log(`略過：草稿 ${draft.version} 剩 ${draft.max_new_words - draft.used} 個名額，這個測試需要剛好剩 1 個`);
} else {
  const words = await q(`SELECT word_id, row_version FROM word_reviews WHERE status = 'pending' ORDER BY word_id LIMIT 100`);
  const [results, ms] = await timed(() => Promise.all(words.map((w, i) => (i % 2 ? editorB : editorA)(
    `/review/${w.word_id}/approve`, { row_version: w.row_version, readings: [{ bopomofo: 'ㄘㄜˋ ㄕˋ', frequency: 1 }] }))));
  console.log(tally(results), `${ms} ms`);
  const [after] = await q('SELECT used_quota($1) AS used', [draft.release_id]);
  check(results.filter((r) => r.status === 200).length === 1, '只有 1 個成功');
  check(after.used === draft.max_new_words, `名額 ${after.used}/${draft.max_new_words}，沒有超賣`);
  // 還原：撤回成功的那一個
  const winner = words[results.findIndex((r) => r.status === 200)];
  const [rv] = await q('SELECT row_version FROM word_reviews WHERE word_id = $1', [winner.word_id]);
  await editorA(`/review/${winner.word_id}/withdraw`, { row_version: rv.row_version });
}

// ---------- 2. 同時審同一個詞 ----------
console.log('\n== 2. 兩位編輯同時對同一個詞送出 20 個決定（樂觀鎖）');
const [target] = await q(`SELECT word_id, row_version FROM word_reviews WHERE status = 'pending' ORDER BY word_id DESC LIMIT 1`);
const [decisions, ms2] = await timed(() => Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? editorB : editorA)(
  `/review/${target.word_id}/decide`, { row_version: target.row_version, status: 'rejected' }))));
console.log(tally(decisions), `${ms2} ms`);
check(decisions.filter((r) => r.status === 200).length === 1, '只有 1 個決定生效，其他人收到「已被其他編輯處理」');
const [reviewed] = await q('SELECT status, row_version FROM word_reviews WHERE word_id = $1', [target.word_id]);
check(reviewed.row_version === target.row_version + 1, `row_version 只加 1（${target.row_version} → ${reviewed.row_version}）`);
await editorA(`/review/${target.word_id}/decide`, { row_version: reviewed.row_version, status: 'pending' });

// ---------- 3. 100 人同時投票 ----------
console.log('\n== 3. 100 人同時投同一個詞');
const [hot] = await q(`SELECT word_id FROM word_reviews r JOIN words w USING (word_id) WHERE w.text = '國旅券' AND r.status = 'pending'`);
const voters = await q(`
  SELECT email FROM users u WHERE role = 'user' AND status = 'active'
     AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.user_id = u.user_id AND v.word_id = $1)
   ORDER BY user_id LIMIT 100`, [hot.word_id]);
const sessions = [];
for (let i = 0; i < voters.length; i += 10) {
  sessions.push(...await Promise.all(voters.slice(i, i + 10).map((v) => session(v.email))));
}
const count = async () => (await q('SELECT coalesce(sum(value), 0)::int AS net, count(*)::int AS n FROM votes WHERE word_id = $1', [hot.word_id]))[0];
const before = await count();
const [votes, ms3] = await timed(() => Promise.all(sessions.map((s) => s(`/candidates/${hot.word_id}/vote`, { value: 1 }))));
const afterVotes = await count();
console.log(tally(votes), `${ms3} ms`);
check(afterVotes.net - before.net === sessions.length, `淨票 ${before.net} → ${afterVotes.net}，剛好多 ${sessions.length}`);
await Promise.all(sessions.map((s) => s(`/candidates/${hot.word_id}/vote`, { value: 0 })));
check((await count()).net === before.net, '收回之後回到原本的票數');

// ---------- 4. 100 台裝置同時上傳同一個新詞 ----------
console.log('\n== 4. 100 台裝置同時上傳同一個新詞');
const text = '併行測試新詞';
const devices = Array.from({ length: 100 }, () => crypto.randomUUID());
const [uploads, ms4] = await timed(() => Promise.all(devices.map((device) => fetch(`${BASE}/words`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ device, app: '8.0', words: [{ text, typed: 'ㄅㄒㄘㄕㄒㄘ', count: 1 }] }),
}).then(async (r) => ({ status: r.status, ...(await r.json()) })))));
console.log(tally(uploads), `${ms4} ms`);
const [made] = await q(`
  SELECT (SELECT count(*) FROM words WHERE text = $1)::int AS words,
         (SELECT count(*) FROM word_reviews r JOIN words w USING (word_id) WHERE w.text = $1)::int AS reviews,
         (SELECT count(*) FROM submissions s JOIN words w USING (word_id) WHERE w.text = $1)::int AS submissions`, [text]);
check(uploads.every((r) => r.status === 200), '100 個上傳全部成功，沒有撞到 UNIQUE');
check(made.words === 1 && made.reviews === 1, `詞 ${made.words} 筆、待審紀錄 ${made.reviews} 筆`);
check(made.submissions === 100, `投稿 ${made.submissions} 筆`);
await q(`DELETE FROM submissions WHERE word_id = (SELECT word_id FROM words WHERE text = $1)`, [text]);
await q(`DELETE FROM word_reviews WHERE word_id = (SELECT word_id FROM words WHERE text = $1)`, [text]);
await q(`DELETE FROM words WHERE text = $1`, [text]);
await q(`DELETE FROM devices WHERE device_id = ANY($1::uuid[])`, [devices]);

// 測試留下的審核歷程也清掉
try {
  const mongo = await new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 3000 }).connect();
  await mongo.db('lexicon').collection('review_history').deleteMany({ ts: { $gte: started } });
  await mongo.close();
} catch { /* 沒有 MongoDB 就算了 */ }

console.log('\n資料已還原。');
await db.end();
