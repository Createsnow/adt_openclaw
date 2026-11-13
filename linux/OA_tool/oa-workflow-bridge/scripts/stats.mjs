#!/usr/bin/env node
/**
 * 只读使用统计：直接查 oa_ticket，不解析会话库。
 *   node scripts/stats.mjs [--days 30]
 * 需要 OA_MYSQL_PASSWORD；连接参数取自 bridge-config.json。输出 JSON（不含任何员工身份）。
 */
import { loadBridgeConfig } from "../src/config.mjs";
import { createMysqlDb } from "../src/db.mjs";

const daysArg = process.argv.indexOf("--days");
const days = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 30;
const since = Date.now() - days * 24 * 60 * 60 * 1000;

const db = await createMysqlDb((await loadBridgeConfig()).mysql);
try {
  const byStatus = await db.query(
    "SELECT status, COUNT(*) AS n FROM oa_ticket WHERE created_at >= ? GROUP BY status ORDER BY n DESC",
    [since],
  );
  const people = await db.query(
    `SELECT COUNT(DISTINCT sender_code) AS users,
            COUNT(DISTINCT CASE WHEN status = 'submitted' THEN sender_code END) AS submitters
       FROM oa_ticket WHERE created_at >= ?`,
    [since],
  );
  const perDay = await db.query(
    `SELECT DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d') AS day,
            COUNT(*) AS prepared,
            SUM(status = 'submitted') AS submitted
       FROM oa_ticket WHERE created_at >= ? GROUP BY day ORDER BY day`,
    [since],
  );
  const perSystem = await db.query(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(draft_json, '$.systemName')) AS systemName, COUNT(*) AS n
       FROM oa_ticket WHERE created_at >= ? AND draft_json IS NOT NULL GROUP BY systemName ORDER BY n DESC`,
    [since],
  );
  const pendingReconcile = await db.query(
    "SELECT COUNT(*) AS n FROM oa_ticket WHERE status IN ('unknown', 'submitting')",
  );
  console.log(JSON.stringify({
    windowDays: days,
    tickets: Object.fromEntries(byStatus.map((row) => [row.status, Number(row.n)])),
    users: Number(people[0]?.users || 0),
    usersWithSubmitted: Number(people[0]?.submitters || 0),
    perDay: perDay.map((row) => ({ day: row.day, prepared: Number(row.prepared), submitted: Number(row.submitted) })),
    activeBySystem: perSystem.map((row) => ({ systemName: row.systemName, count: Number(row.n) })),
    awaitingReconciliation: Number(pendingReconcile[0]?.n || 0),
  }, null, 2));
} finally {
  await db.close();
}
