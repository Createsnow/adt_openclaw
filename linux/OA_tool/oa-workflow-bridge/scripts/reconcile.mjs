#!/usr/bin/env node
/**
 * 与 OA 逐号对账（只读）。
 *   node scripts/reconcile.mjs                    导出小A成功提交的 OA 单号（CSV）
 *   node scripts/reconcile.mjs --oa oa-export.csv 与 OA 导出的单号清单比对
 * OA 导出文件：CSV / 纯文本均可，取每行里第一串 4 位以上的数字当 requestId。
 * 需要 OA_MYSQL_PASSWORD；连接参数取自 bridge-config.json。
 */
import { readFile } from "node:fs/promises";
import { loadBridgeConfig } from "../src/config.mjs";
import { createMysqlDb } from "../src/db.mjs";

const oaArg = process.argv.indexOf("--oa");
const oaFile = oaArg > 0 ? process.argv[oaArg + 1] : "";

const db = await createMysqlDb((await loadBridgeConfig()).mysql);
let rows;
try {
  rows = await db.query(
    `SELECT request_id, external_ticket_id, status, updated_at FROM oa_ticket
      WHERE request_id IS NOT NULL ORDER BY updated_at`,
  );
} finally {
  await db.close();
}

const ours = new Map(rows.map((row) => [String(row.request_id), row]));
if (!oaFile) {
  console.log("requestId,externalTicketId,status,updatedAt");
  for (const row of rows) {
    console.log([row.request_id, row.external_ticket_id, row.status, new Date(Number(row.updated_at)).toISOString()].join(","));
  }
  process.exit(0);
}

const oaIds = new Set();
for (const line of (await readFile(oaFile, "utf8")).split(/\r?\n/)) {
  const match = /\d{4,}/.exec(line);
  if (match) oaIds.add(match[0]);
}
const submitted = [...ours.values()].filter((row) => row.status === "submitted").map((row) => String(row.request_id));
const missingInOa = submitted.filter((id) => !oaIds.has(id));
const unknownWithId = [...ours.values()].filter((row) => row.status !== "submitted").map((row) => ({
  requestId: String(row.request_id),
  status: row.status,
  inOa: oaIds.has(String(row.request_id)),
}));
console.log(JSON.stringify({
  submittedByXa: submitted.length,
  foundInOa: submitted.length - missingInOa.length,
  missingInOa,
  notMarkedSubmitted: unknownWithId,
}, null, 2));
process.exitCode = missingInOa.length ? 1 : 0;
