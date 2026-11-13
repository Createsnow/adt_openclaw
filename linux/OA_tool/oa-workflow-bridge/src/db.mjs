/**
 * MySQL 连接与表结构。业务代码只通过 `db.query(sql, params)`（返回行数组）和
 * `db.run(sql, params)`（返回 affectedRows）访问数据库，单元测试用 SQLite 实现同一接口。
 *
 * 时间统一存毫秒（BIGINT），不依赖 MySQL 时区。JSON 存 TEXT，由插件自己序列化。
 */

export const ACTIVE_TICKET_STATUSES = Object.freeze(["awaiting_confirmation", "submitting", "unknown"]);

/**
 * oa_ticket：一张确认单一行（待确认 → 提交中 / 待对账 → 已提交 / 已取消 / 已过期 / 被拒）。
 * active_sender：仍占「同一人全局一张待确认」名额（待确认 / 提交中 / 待对账）时等于 sender_code，
 *   结束后置 NULL；唯一索引在库层面兜底「同一人全局一张」。由 store.mjs 随状态一起写。
 * oa_inbox：每人一行，收到但还没进工单的附件（hook 一收到就落盘入库），带去重键与会话码。
 * oa_identity：企微发送人 → OA 人员 id 缓存（命中 24 小时，查不到的负缓存 10 分钟）。
 */
export const MYSQL_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS oa_ticket (
    confirmation_id    VARCHAR(64)  NOT NULL,
    external_ticket_id VARCHAR(32)  NOT NULL,
    sender_code        CHAR(24)     NOT NULL,
    session_code       CHAR(24)     NOT NULL,
    status             VARCHAR(24)  NOT NULL,
    active_sender      CHAR(24)     NULL,
    oa_requester_id    VARCHAR(18)  NULL,
    draft_json         MEDIUMTEXT   NULL,
    staged_json        TEXT         NULL,
    request_id         VARCHAR(32)  NULL,
    error_code         VARCHAR(64)  NULL,
    expires_at         BIGINT       NOT NULL,
    created_at         BIGINT       NOT NULL,
    updated_at         BIGINT       NOT NULL,
    PRIMARY KEY (confirmation_id),
    UNIQUE KEY uk_active_sender (active_sender),
    KEY idx_external_ticket (external_ticket_id, created_at),
    KEY idx_sender_updated (sender_code, updated_at),
    KEY idx_status_expires (status, expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS oa_inbox (
    sender_code   CHAR(24) NOT NULL,
    session_codes TEXT     NOT NULL,
    state_json    TEXT     NOT NULL,
    expires_at    BIGINT   NOT NULL,
    updated_at    BIGINT   NOT NULL,
    PRIMARY KEY (sender_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS oa_identity (
    mapping_code CHAR(24)    NOT NULL,
    oa_user_id   VARCHAR(18) NULL,
    miss_code    VARCHAR(64) NULL,
    expires_at   BIGINT      NOT NULL,
    PRIMARY KEY (mapping_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
]);

export const TABLES = Object.freeze(["oa_ticket", "oa_inbox", "oa_identity"]);

export async function createMysqlDb(mysqlConfig, { password = process.env.OA_MYSQL_PASSWORD } = {}) {
  if (!String(password || "").trim()) {
    const error = new Error("OA_MYSQL_PASSWORD is not configured");
    error.code = "DB_UNAVAILABLE";
    throw error;
  }
  const mysql = await import("mysql2/promise");
  const pool = mysql.createPool({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    user: mysqlConfig.user,
    password: String(password).trim(),
    database: mysqlConfig.database,
    charset: "utf8mb4",
    connectionLimit: 4,
    connectTimeout: 10_000,
    enableKeepAlive: true,
  });
  return {
    async query(sql, params = []) {
      const [rows] = await pool.query(sql, params);
      return rows;
    },
    async run(sql, params = []) {
      const [result] = await pool.query(sql, params);
      return Number(result?.affectedRows || 0);
    },
    async close() {
      await pool.end();
    },
  };
}

export async function ensureSchema(db, schema = MYSQL_SCHEMA) {
  for (const statement of schema) await db.run(statement);
}

/** 只读检查：能连上且三张表都在。不建表、不写数据。 */
export async function checkSchema(db) {
  await db.query("SELECT 1");
  for (const table of TABLES) {
    await db.query(`SELECT 1 FROM ${table} LIMIT 1`);
  }
}
