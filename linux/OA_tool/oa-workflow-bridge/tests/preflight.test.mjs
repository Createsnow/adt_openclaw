import assert from "node:assert/strict";
import test from "node:test";
import { runReadonlyPreflight } from "../src/preflight.mjs";
import { createSqliteDb } from "./helpers.mjs";

function config() {
  return { workflowId: 602, mysql: { host: "db", port: 3306, user: "xa_oa", database: "xa_oa" } };
}

function oaClient(counter, rows = [{ workflowId: 602, workflowName: "IT" }]) {
  return () => ({
    getCreateWorkflowList: async () => {
      counter.calls += 1;
      return rows;
    },
  });
}

test("MySQL 连不上时预检失败且不调 OA", async () => {
  const oa = { calls: 0 };
  const result = await runReadonlyPreflight({
    loadConfig: async () => config(),
    createDb: async () => {
      const error = new Error("connect ECONNREFUSED");
      error.code = "ECONNREFUSED";
      throw error;
    },
    clientFactory: oaClient(oa),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DB_UNAVAILABLE");
  assert.equal(result.exitCode, 1);
  assert.equal(oa.calls, 0);
});

test("表还没建时报 DB_SCHEMA_MISSING，预检不建表并关闭连接", async () => {
  const oa = { calls: 0 };
  let closed = 0;
  const result = await runReadonlyPreflight({
    loadConfig: async () => config(),
    createDb: async () => ({
      query: async (sql) => {
        if (sql === "SELECT 1") return [{ 1: 1 }];
        const error = new Error("Table 'xa_oa.oa_ticket' doesn't exist");
        error.code = "ER_NO_SUCH_TABLE";
        throw error;
      },
      run: async () => { throw new Error("preflight must not write"); },
      close: async () => { closed += 1; },
    }),
    clientFactory: oaClient(oa),
  });
  assert.equal(result.code, "DB_SCHEMA_MISSING");
  assert.equal(oa.calls, 0);
  assert.equal(closed, 1);
});

test("MySQL 与 OA 都通过时预检成功", async () => {
  const oa = { calls: 0 };
  const result = await runReadonlyPreflight({
    loadConfig: async () => config(),
    createDb: async () => createSqliteDb(),
    clientFactory: oaClient(oa, [{ workflowId: "602", workflowName: "IT服务台" }]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "READ_ONLY_PREFLIGHT_PASSED");
  assert.equal(result.db, "OK");
  assert.equal(result.workflowName, "IT服务台");
});

test("流程不可创建时退出码 2", async () => {
  const result = await runReadonlyPreflight({
    loadConfig: async () => config(),
    createDb: async () => createSqliteDb(),
    clientFactory: oaClient({ calls: 0 }, [{ workflowId: 1 }]),
  });
  assert.equal(result.code, "WORKFLOW_NOT_CREATEABLE");
  assert.equal(result.exitCode, 2);
});
