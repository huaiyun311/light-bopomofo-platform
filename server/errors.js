// 把資料庫的錯誤代碼轉成 HTTP 狀態碼，訊息直接用資料庫給的中文（trigger 與函式都寫好了）
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const STATUS = {
  LB001: 409, // 沒有草稿版本
  LB002: 409, // 新詞名額已滿
  LB003: 409, // 已被其他人修改（樂觀鎖）
  LB004: 400, // 輸入不合法
  23514: 400, // CHECK 或 trigger 擋下
  23505: 409, // 重複（UNIQUE）
  23503: 400, // 外鍵：參照的資料不存在
  '22P02': 400, // 格式錯誤，例如 uuid
};

export function errorHandler(err, req, res, _next) {
  const status = err.status ?? STATUS[err.code] ?? 500;
  if (status === 500) console.error(err);
  res.status(status).json({
    error: status === 500 ? '伺服器發生錯誤' : err.message,
    code: err.code,
  });
}

/** 包住 async 路由，讓錯誤交給 errorHandler */
export const handle = (fn) => (req, res, next) => fn(req, res, next).catch(next);
