import { DatabaseSync } from "node:sqlite";
import { MYSQL_SCHEMA } from "../src/db.mjs";
import { createStore, updateTicket } from "../src/store.mjs";

/** 把生产 MySQL 建表语句改写成 SQLite 能执行的形式（列与唯一约束保持一致，只去掉普通索引与表选项）。 */
export function toSqliteDdl(ddl) {
  return ddl
    .replace(/\)\s*ENGINE=[^)]*$/s, ")")
    .replace(/UNIQUE KEY \w+ \(/g, "UNIQUE (")
    .replace(/,\s*KEY \w+ \([^)]*\)/g, "");
}

/** 与 db.mjs 同一接口的内存库：单元测试不依赖外部 MySQL。 */
export function createSqliteDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const ddl of MYSQL_SCHEMA) sqlite.exec(toSqliteDdl(ddl));
  return {
    sqlite,
    async query(sql, params = []) {
      return sqlite.prepare(sql).all(...params);
    },
    async run(sql, params = []) {
      return Number(sqlite.prepare(sql).run(...params).changes);
    },
    async close() {
      sqlite.close();
    },
  };
}

export function createTestStore(options) {
  return createStore(createSqliteDb(), options);
}

/** 把一张单的确认窗口改成已到期（模拟 24 小时过去）。 */
export async function expireNow(store, confirmationId) {
  await store.db.run("UPDATE oa_ticket SET expires_at = ? WHERE confirmation_id = ?", [Date.now() - 1000, confirmationId]);
}

export async function setStatus(store, confirmationId, status) {
  await updateTicket(store, confirmationId, { status });
}

/** 模拟企微 hook 收到附件：直接落进 inbox（与 index.mjs 的 hook 同一条路径）。 */
export async function hookCapture(store, stateDir, source, attachments, config = { maxAttachmentBytes: 1024 * 1024, maxTotalAttachmentBytes: 2 * 1024 * 1024, inboxTtlMinutes: 30 }) {
  const { captureInbound } = await import("../src/inbox.mjs");
  return captureInbound({ store, stateDir, config, source, attachments });
}
