-- 待審列表的三種寫法：系統裡最慢、最常被打開的查詢
-- 用法：bash bench/run.sh（結果存在 bench/results/candidates.txt）
\set QUIET on
\pset footer off
\ir _helpers.sql
\o /dev/null
CREATE TEMP TABLE versions (name text, ms numeric, note text);

-- A. 直覺寫法：全部 JOIN 起來再 GROUP BY
--    一個詞有 2,000 筆投稿、800 張票，JOIN 之後變成 160 萬列：又慢，sum(use_count) 也被票數乘開而算錯
INSERT INTO versions SELECT 'A. 全部 JOIN 再 GROUP BY', pg_temp.ms($q$
  SELECT w.word_id, w.text, count(DISTINCT s.device_id) AS devices,
         count(DISTINCT s.device_id) FILTER (WHERE d.user_id IS NOT NULL) AS bound_devices,
         sum(s.use_count) AS uses, coalesce(sum(v.value), 0) AS net_votes
    FROM word_reviews r JOIN words w USING (word_id)
    JOIN submissions s USING (word_id) JOIN devices d USING (device_id)
    LEFT JOIN votes v ON v.word_id = r.word_id
   WHERE r.status = 'pending'
   GROUP BY w.word_id ORDER BY bound_devices DESC, devices DESC LIMIT 50 $q$, 1), '慢，而且使用次數算錯';

-- B. 先各自彙總再 JOIN：投稿和票數分開算好，每個詞各一列再接起來
INSERT INTO versions SELECT 'B. 各自彙總再 JOIN', pg_temp.ms($q$
  WITH s AS (
    SELECT s.word_id, count(DISTINCT s.device_id) AS devices,
           count(DISTINCT s.device_id) FILTER (WHERE d.user_id IS NOT NULL) AS bound_devices,
           sum(s.use_count) AS uses, max(s.last_seen) AS last_seen
      FROM submissions s JOIN devices d USING (device_id) GROUP BY s.word_id),
  v AS (
    SELECT v.word_id, sum(v.value) AS net_votes, count(*) AS votes
      FROM votes v JOIN users u USING (user_id) WHERE u.status = 'active' GROUP BY v.word_id)
  SELECT w.word_id, w.text, s.devices, s.bound_devices, s.uses, coalesce(v.net_votes, 0) AS net_votes
    FROM word_reviews r JOIN words w USING (word_id) JOIN s USING (word_id) LEFT JOIN v USING (word_id)
   WHERE r.status = 'pending'
   ORDER BY s.bound_devices DESC, s.devices DESC LIMIT 50 $q$, 3), '正確，每次都重算 95 萬筆';

-- C. 投稿統計事先算好（materialized view），審核狀態與票數即時查（目前採用，server/routes/candidates.js）
INSERT INTO versions SELECT 'C. materialized view＋即時狀態與票數', pg_temp.ms($q$
  SELECT w.word_id, w.text, c.devices, c.bound_devices, c.uses, coalesce(v.net_votes, 0) AS net_votes
    FROM candidate_stats c JOIN word_reviews r USING (word_id) JOIN words w USING (word_id)
    LEFT JOIN LATERAL (SELECT sum(v.value) AS net_votes FROM votes v JOIN users u USING (user_id)
                        WHERE v.word_id = c.word_id AND u.status = 'active') v ON true
   WHERE r.status = 'pending'
   ORDER BY c.bound_devices DESC, c.devices DESC LIMIT 50 $q$), '投稿數字最多晚 10 分鐘';

INSERT INTO versions SELECT '（C 的代價）重算 materialized view', pg_temp.clock(
  'REFRESH MATERIALIZED VIEW CONCURRENTLY candidate_stats'), '每 10 分鐘在背景跑一次';
\o

\echo '== 待審列表第一頁（毫秒，中位數）'
SELECT name AS 寫法, ms AS 毫秒,
       CASE WHEN name LIKE '（%' THEN '' ELSE round((SELECT ms FROM versions WHERE name LIKE 'B.%') / ms, 1) || ' 倍' END AS "比 B 快",
       note AS 說明
  FROM versions;

\echo
\echo '== A 為什麼算錯：國旅券的使用次數'
SELECT (SELECT sum(use_count) FROM submissions WHERE word_id = w.word_id) AS 正確,
       (SELECT sum(s.use_count) FROM submissions s LEFT JOIN votes v USING (word_id) WHERE s.word_id = w.word_id) AS "A 的結果",
       (SELECT count(*) FROM votes WHERE word_id = w.word_id) AS 票數
  FROM words w WHERE text = '國旅券';

\echo
\echo '== B 的瓶頸：每次都要把 95 萬筆投稿依詞排好、去掉同一台裝置的重複，再計數'
EXPLAIN (ANALYZE, COSTS OFF)
  SELECT s.word_id, count(DISTINCT s.device_id), sum(s.use_count)
    FROM submissions s JOIN devices d USING (device_id) GROUP BY s.word_id;
