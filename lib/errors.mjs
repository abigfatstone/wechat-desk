export const CODES = Object.freeze({
  BAD_ARGS: "参数无效",
  NO_RUNTIME: "运行时未就绪",
  NO_QUERY_LAYER: "查询层未就绪",
  NO_WECHAT: "没有找到微信数据",
  UNSUPPORTED_WECHAT: "微信版本不在支持范围",
  KEY_INVALID: "密钥无效或库未解密",
  DB_BUSY: "数据库正被占用",
  TIMEOUT: "操作超时",
  IO_ERROR: "读写失败",
});

export class DeskError extends Error {
  constructor(code, detail) {
    super(CODES[code] ?? code);
    this.name = "DeskError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
