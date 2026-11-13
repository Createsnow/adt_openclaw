import { loadBridgeConfig } from "./config.mjs";
import { checkSchema, createMysqlDb } from "./db.mjs";
import { OAClient } from "./oa-client.mjs";

function fail(code, message, extra = {}) {
  return { ok: false, code, message, exitCode: code === "WORKFLOW_NOT_CREATEABLE" ? 2 : 1, ...extra };
}

/** 只读预检：MySQL 能连且三张表在（不建表、不写数据），OA 流程可创建。 */
export async function runReadonlyPreflight({
  loadConfig = loadBridgeConfig,
  createDb = (mysqlConfig) => createMysqlDb(mysqlConfig),
  clientFactory = (opts) => new OAClient(opts),
} = {}) {
  let config;
  try {
    config = await loadConfig();
  } catch (error) {
    return fail("PREFLIGHT_FAILED", error?.message || "OA preflight failed");
  }

  let db;
  try {
    try {
      db = await createDb(config.mysql);
      await checkSchema(db);
    } catch (error) {
      const code = error?.code === "ER_NO_SUCH_TABLE" ? "DB_SCHEMA_MISSING" : "DB_UNAVAILABLE";
      return fail(code, error?.message || "MySQL is unavailable");
    }
    try {
      const rows = await clientFactory({ config }).getCreateWorkflowList();
      const match = rows.find((row) => String(row?.workflowId ?? row?.workflowid ?? "") === String(config.workflowId));
      if (!match) {
        return fail("WORKFLOW_NOT_CREATEABLE", "OA workflow is not creatable", { workflowId: config.workflowId, db: "OK" });
      }
      return {
        ok: true,
        code: "READ_ONLY_PREFLIGHT_PASSED",
        exitCode: 0,
        workflowId: config.workflowId,
        workflowName: String(match.workflowName ?? match.workflowname ?? ""),
        db: "OK",
      };
    } catch (error) {
      return fail(error?.code || "PREFLIGHT_FAILED", error?.message || "OA preflight failed", { db: "OK" });
    }
  } finally {
    if (db?.close) await db.close();
  }
}
