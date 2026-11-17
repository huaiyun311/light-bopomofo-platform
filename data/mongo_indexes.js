// MongoDB 的索引：配合三項用到 MongoDB 的分析
db.selection_events.createIndex({ entry_id: 1, ts: 1 });   // 某詞條被選了幾次、在第幾名
db.selection_events.createIndex({ app_version: 1 });        // 各版新詞發布後被選用的次數
db.query_logs.createIndex({ ts: -1 });                      // 最近的查詢
db.review_history.createIndex({ word_id: 1, ts: 1 });       // 某個詞的審核歷程

for (const c of ["selection_events", "query_logs", "review_history"]) {
  print(`   ${c.padEnd(17)} ${db[c].countDocuments().toLocaleString()} 筆`);
}
