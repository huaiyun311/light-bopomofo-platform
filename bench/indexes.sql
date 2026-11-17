-- 每個索引的效果：同一句查詢，有索引與暫時拿掉索引各量幾次，取中位數。
-- 用法：bash bench/run.sh（結果存在 bench/results/indexes.txt）
\set QUIET on
\pset footer off
\ir _helpers.sql
\o /dev/null

-- ① 查詢詞庫：首字注音「ㄍㄌㄑ」（運算式索引 initials(bopomofo)）
SELECT pg_temp.compare('首字注音 ㄍㄌㄑ', 'lexicon_entries_initials', $q$
  SELECT e.entry_id FROM lexicon_entries e JOIN words w USING (word_id)
   WHERE e.status = 'active' AND initials(e.bopomofo) LIKE 'ㄍㄌㄑ%' ORDER BY e.frequency DESC LIMIT 50 $q$);

-- ① 查詢詞庫：完整注音前綴（text_pattern_ops：資料庫的排序規則不是 C，一般的 B-tree 不能做 LIKE 前綴）
SELECT pg_temp.compare('完整注音 ㄋㄧˇ ㄏ…', 'lexicon_entries_bopomofo', $q$
  SELECT e.entry_id FROM lexicon_entries e JOIN words w USING (word_id)
   WHERE e.status = 'active' AND e.bopomofo LIKE 'ㄋㄧˇ ㄏ%' ORDER BY e.frequency DESC LIMIT 50 $q$);

-- ① 查詢詞庫：詞的一部分（trigram）。三個字以上才拆得出三字組，一兩個字索引幫不上
SELECT pg_temp.compare('詞的一部分 %旅行社%', 'words_text_trgm', $q$
  SELECT w.word_id FROM words w WHERE w.text LIKE '%旅行社%' $q$);
SELECT pg_temp.compare('詞的一部分 %旅%（單字）', 'words_text_trgm', $q$
  SELECT w.word_id FROM words w WHERE w.text LIKE '%旅%' $q$);

-- ① 詞條詳情：常出現在「前面」的詞（主鍵是 (前詞, 後詞)，反過來查要另一個索引）
SELECT pg_temp.compare('前面常接的詞（200 萬詞組）', 'word_pairs_next', $q$
  SELECT p.word_id FROM word_pairs p
   WHERE p.next_word_id = (SELECT word_id FROM words WHERE text = '你好') ORDER BY p.pmi DESC LIMIT 10 $q$);

-- ④ 審核台：國旅券的各種打法（95 萬筆投稿）
SELECT pg_temp.compare('一個詞的各種打法', 'submissions_word', $q$
  SELECT typed, count(*), sum(use_count) FROM submissions
   WHERE word_id = (SELECT word_id FROM words WHERE text = '國旅券') GROUP BY typed $q$);

-- ② 待審列表：一個詞的票數（15 萬票）
SELECT pg_temp.compare('一個詞的票數', 'votes_word', $q$
  SELECT sum(value), count(*) FROM votes WHERE word_id = (SELECT word_id FROM words WHERE text = '國旅券') $q$);

-- 輸入法同步：某人上次同步之後變動的個人詞
SELECT pg_temp.compare('同步個人詞', 'personal_words_sync', $q$
  SELECT word_id, bopomofo, status FROM personal_words
   WHERE user_id = 21 AND updated_at > '2026-11-15' ORDER BY updated_at $q$);

-- ② 待審列表：materialized view 依排序讀，湊滿 50 個待審詞就停
SELECT pg_temp.compare('待審列表第一頁（materialized view）', 'candidate_stats_devices', $q$
  SELECT c.word_id FROM candidate_stats c JOIN word_reviews r USING (word_id)
   WHERE r.status = 'pending' ORDER BY c.bound_devices DESC, c.devices DESC LIMIT 50 $q$);

\o
\echo
\echo '== 有無索引的查詢時間（毫秒，中位數）'
SELECT name AS 查詢, index_name AS 索引, with_index AS 有索引, without_index AS 沒有索引,
       round(without_index / nullif(with_index, 0), 1) || ' 倍' AS 差距
  FROM results;

\echo
\echo '== 執行計畫怎麼讀資料'
SELECT name AS 查詢, plan_with AS 有索引, plan_without AS 沒有索引 FROM results;
