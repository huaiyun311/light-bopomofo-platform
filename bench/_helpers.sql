-- 量測用的小工具（只存在這次連線，跑完就消失）

-- 執行 runs 次 EXPLAIN ANALYZE，回傳執行時間的中位數（毫秒）
CREATE FUNCTION pg_temp.ms(q text, runs int DEFAULT 7) RETURNS numeric
LANGUAGE plpgsql AS $$
DECLARE plan json; times numeric[] := '{}';
BEGIN
  FOR i IN 1..runs LOOP
    EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || q INTO plan;
    times := times || (plan -> 0 ->> 'Execution Time')::numeric;
  END LOOP;
  RETURN (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY t)::numeric, 3) FROM unnest(times) t);
END $$;

-- 不能 EXPLAIN 的指令（例如 REFRESH）：直接計時
CREATE FUNCTION pg_temp.clock(q text, runs int DEFAULT 3) RETURNS numeric
LANGUAGE plpgsql AS $$
DECLARE t0 timestamptz; times numeric[] := '{}';
BEGIN
  FOR i IN 1..runs LOOP
    t0 := clock_timestamp();
    EXECUTE q;
    times := times || (extract(epoch FROM clock_timestamp() - t0) * 1000)::numeric;
  END LOOP;
  RETURN (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY t)::numeric, 3) FROM unnest(times) t);
END $$;

-- 執行計畫裡讀資料表的方式（Seq Scan、Index Scan…）
CREATE FUNCTION pg_temp.scans(q text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE line text; out text[] := '{}';
BEGIN
  FOR line IN EXECUTE 'EXPLAIN (COSTS OFF) ' || q LOOP
    IF line ~ 'Scan' THEN out := out || btrim(regexp_replace(line, '^\s*->\s*', '')); END IF;
  END LOOP;
  RETURN array_to_string(out, E'\n');
END $$;

CREATE TEMP TABLE results (
  name text, index_name text, with_index numeric, without_index numeric, plan_with text, plan_without text);

-- 比較有、沒有某個索引的速度：在子交易裡 DROP INDEX，量完故意丟錯誤，索引就回來了
CREATE FUNCTION pg_temp.compare(name text, idx text, q text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE w numeric; wo numeric; pw text; pwo text;
BEGIN
  w := pg_temp.ms(q);
  pw := pg_temp.scans(q);
  BEGIN
    EXECUTE format('DROP INDEX %I', idx);
    wo := pg_temp.ms(q, 3);
    pwo := pg_temp.scans(q);
    RAISE EXCEPTION USING ERRCODE = 'BNCH1';
  EXCEPTION WHEN SQLSTATE 'BNCH1' THEN NULL;
  END;
  INSERT INTO results VALUES (name, idx, w, wo, pw, pwo);
END $$;
