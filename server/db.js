// 資料庫連線：PostgreSQL 放所有交易資料，MongoDB 放選字、查詢紀錄與審核歷程。
import pg from 'pg';
import { MongoClient } from 'mongodb';

// bigint、numeric 轉成 JavaScript 數字（本系統的代號與計數都在安全範圍內）
pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, parseFloat);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://lexicon:lexicon@localhost:5433/lexicon',
  max: 20,
});

/** 執行一句 SQL，回傳所有列。參數一律用 $1、$2 傳，不把使用者輸入接進字串（防 SQL injection）。 */
export async function query(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

// MongoDB 連不上時不讓整個網站掛掉：紀錄寫不進去就算了，分析頁會顯示錯誤
const mongoClient = new MongoClient(process.env.MONGO_URL ?? 'mongodb://localhost:27018', {
  serverSelectionTimeoutMS: 3000,
});
let mongo = null;

export async function mongoDb() {
  if (!mongo) mongo = mongoClient.connect().then((c) => c.db('lexicon'));
  try {
    return await mongo;
  } catch (e) {
    mongo = null;
    throw e;
  }
}

/** 寫一筆紀錄到 MongoDB；失敗只記在 log，不影響主要功能 */
export async function record(collection, doc) {
  try {
    await (await mongoDb()).collection(collection).insertOne({ ...doc, ts: new Date() });
  } catch (e) {
    console.warn(`MongoDB ${collection} 寫入失敗：${e.message}`);
  }
}
