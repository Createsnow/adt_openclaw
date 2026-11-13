import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryStateStore, pingRedis } from "../src/redis-client.mjs";
import { runReadonlyPreflight } from "../src/preflight.mjs";

function config() {
  return {
    workflowId: 602,
    redis: { url: "redis://127.0.0.1:6379", keyPrefix: "oa-workflow-bridge", database: 0 },
  };
}

test("PING 内存 Redis 返回 PONG", async () => {
  assert.equal(await pingRedis(createMemoryStateStore("ping-ok")), "PONG");
});

test("客户端没有 ping 时标记 REDIS_UNAVAILABLE", async () => {
  await assert.rejects(
    pingRedis({ redis: {}, keyPrefix: "x" }),
    (error) => error.code === "REDIS_UNAVAILABLE",
  );
});

test("Redis 连不上时预检失败且不调 OA", async () => {
  let oaCalls = 0;
  let closed = 0;
  const result = await runReadonlyPreflight({
    loadConfig: async () => config(),
    createStore: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    closeStore: async () => {
      closed += 1;
    },
    ping: async () => "PONG",
    clientFactory: () => ({
      getCreateWorkflowList: async () => {
        oaCalls += 1;
        return [{ workflowId: 602, workflowName: "IT" }];
      },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "REDIS_UNAVAILABLE");
  assert.equal(result.exitCode, 1);
  assert.equal(oaCalls, 0);
  assert.equal(closed, 0);
});

test("Redis PING 失败时预检失败且关闭连接", async () => {
  const store = createMemoryStateStore("preflight-ping");
  let closed = 0;
  let oaCalls = 0;
  const result = await runReadonlyPreflight({
    loadConfig: async () => config(),
    createStore: async () => store,
    closeStore: async () => {
      closed += 1;
    },
    ping: async () => {
      const error = new Error("Redis PING failed");
      error.code = "REDIS_UNAVAILABLE";
      throw error;
    },
    clientFactory: () => ({
      getCreateWorkflowList: async () => {
        oaCalls += 1;
        return [{ workflowId: 602 }];
      },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "REDIS_UNAVAILABLE");
  assert.equal(result.redisKeyPrefix, "preflight-ping");
  assert.equal(oaCalls, 0);
  assert.equal(closed, 1);
});

test("Redis 与 OA 都通过时预检成功", async () => {
  const store = createMemoryStateStore("preflight-ok");
  let closed = 0;
  const result = await runReadonlyPreflight({
    loadConfig: async () => config(),
    createStore: async () => store,
    closeStore: async () => {
      closed += 1;
    },
    ping: pingRedis,
    clientFactory: () => ({
      getCreateWorkflowList: async () => [{ workflowId: "602", workflowName: "IT服务台" }],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "READ_ONLY_PREFLIGHT_PASSED");
  assert.equal(result.redis, "PONG");
  assert.equal(result.redisKeyPrefix, "preflight-ok");
  assert.equal(result.workflowName, "IT服务台");
  assert.equal(closed, 1);
});
