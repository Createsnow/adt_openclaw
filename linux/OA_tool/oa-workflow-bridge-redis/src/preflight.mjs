import { OAClient } from "./oa-client.mjs";
import { loadBridgeConfig } from "./config.mjs";
import { closeStateStore, createRedisStateStore, pingRedis } from "./redis-client.mjs";
import { resolveProtectedValues } from "./secret-resolver.mjs";

function fail(code, message, extra = {}) {
  return { ok: false, code, message, exitCode: code === "WORKFLOW_NOT_CREATEABLE" ? 2 : 1, ...extra };
}

export async function runReadonlyPreflight({
  loadConfig = loadBridgeConfig,
  createStore = (redisConfig) => createRedisStateStore(redisConfig),
  closeStore = closeStateStore,
  ping = pingRedis,
  resolveSecrets = resolveProtectedValues,
  clientFactory = (opts) => new OAClient(opts),
} = {}) {
  let store;
  let config;
  try {
    config = await loadConfig();
  } catch (error) {
    return fail("PREFLIGHT_FAILED", error?.message || "OA preflight failed");
  }

  try {
    try {
      store = await createStore(config.redis);
    } catch (error) {
      return fail("REDIS_UNAVAILABLE", error?.message || "Redis is unavailable");
    }

    let redisReply;
    try {
      redisReply = await ping(store);
    } catch (error) {
      return fail("REDIS_UNAVAILABLE", error?.message || "Redis PING failed", {
        redisKeyPrefix: store.keyPrefix,
      });
    }

    try {
      const client = clientFactory({ config, resolveSecrets });
      const rows = await client.getCreateWorkflowList();
      const match = rows.find((row) => String(row?.workflowId ?? row?.workflowid ?? "") === String(config.workflowId));
      if (!match) {
        return fail("WORKFLOW_NOT_CREATEABLE", "OA workflow is not creatable", {
          workflowId: config.workflowId,
          redis: redisReply,
          redisKeyPrefix: store.keyPrefix,
        });
      }
      return {
        ok: true,
        code: "READ_ONLY_PREFLIGHT_PASSED",
        exitCode: 0,
        workflowId: config.workflowId,
        workflowName: String(match.workflowName ?? match.workflowname ?? ""),
        redis: redisReply,
        redisKeyPrefix: store.keyPrefix,
      };
    } catch (error) {
      return fail(error?.code || "PREFLIGHT_FAILED", error?.message || "OA preflight failed", {
        redis: redisReply,
        redisKeyPrefix: store.keyPrefix,
      });
    }
  } finally {
    if (store) await closeStore(store);
  }
}
