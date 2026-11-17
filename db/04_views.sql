-- 待審列表的統計：materialized view（事先算好存起來的查詢結果）
--
-- 待審列表要合併 95 萬筆投稿，每次即時算要將近 1 秒（bench/candidates.sql）。
-- 投稿數字晚一點更新沒關係，所以先算好存在這裡，網頁伺服器每 10 分鐘 REFRESH 一次。
-- 會即時變動、而且一定要正確的部分不放進來，查詢時另外 JOIN：
--   - 審核狀態（word_reviews）：審完的詞要馬上從列表消失（R6）
--   - 票數（votes）：使用者投完票要馬上看到
-- 這是刻意的冗餘：以「最多晚 10 分鐘」換取查詢速度。
CREATE MATERIALIZED VIEW candidate_stats AS
SELECT s.word_id,
       count(DISTINCT s.device_id) AS devices,
       count(DISTINCT s.device_id) FILTER (WHERE d.user_id IS NOT NULL) AS bound_devices,
       sum(s.use_count) AS uses,
       max(s.last_seen) AS last_seen
  FROM submissions s JOIN devices d USING (device_id)
 GROUP BY s.word_id;

-- REFRESH ... CONCURRENTLY 需要唯一索引：重新計算時不擋住正在讀的人
CREATE UNIQUE INDEX candidate_stats_word ON candidate_stats (word_id);
-- 四種排序各一個索引：依序往下讀，遇到待審的詞就收，湊滿一頁就停
CREATE INDEX candidate_stats_devices ON candidate_stats (bound_devices DESC, devices DESC);
CREATE INDEX candidate_stats_uses ON candidate_stats (uses DESC);
CREATE INDEX candidate_stats_recent ON candidate_stats (last_seen DESC);
