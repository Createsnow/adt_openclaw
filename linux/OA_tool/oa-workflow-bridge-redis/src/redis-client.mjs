import { MemoryRedis } from "./memory-redis.mjs";

function normalizeKeyPrefix(value) {
  const prefix = String(value || "oa-workflow-bridge").trim().replace(/:+$/, "");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(prefix)) {
    throw new Error("Redis keyPrefix must match /^[A-Za-z0-9._-]{1,64}$/");
  }
  return prefix;
}

export function buildStateStore({ redis, keyPrefix }) {
  return {
    redis,
    keyPrefix: normalizeKeyPrefix(keyPrefix),
  };
}

export async function createRedisStateStore(redisConfig = {}, { onError } = {}) {
  const url = process.env.OA_REDIS_URL?.trim()
    || process.env.REDIS_URL?.trim()
    || String(redisConfig.url || "").trim();
  if (!url) {
    throw new Error("Redis URL is required (OA_REDIS_URL, REDIS_URL, or bridge-config.json redis.url)");
  }
  const database = Number.isInteger(redisConfig.database) ? redisConfig.database : 0;
  const { createClient } = await import("redis");
  const client = createClient({ url, database });
  client.on("error", (error) => {
    onError?.(error);
  });
  await client.connect();
  return buildStateStore({
    redis: client,
    keyPrefix: redisConfig.keyPrefix,
  });
}

export function createMemoryStateStore(keyPrefix = "oa-workflow-bridge") {
  return buildStateStore({ redis: new MemoryRedis(), keyPrefix });
}

export async function pingRedis(store) {
  if (!store?.redis || typeof store.redis.ping !== "function") {
    const error = new Error("Redis client does not support PING");
    error.code = "REDIS_UNAVAILABLE";
    throw error;
  }
  let reply;
  try {
    reply = await store.redis.ping();
  } catch (error) {
    const wrapped = new Error(error?.message || "Redis PING failed");
    wrapped.code = "REDIS_UNAVAILABLE";
    throw wrapped;
  }
  if (String(reply || "").toUpperCase() !== "PONG") {
    const error = new Error("Redis PING failed");
    error.code = "REDIS_UNAVAILABLE";
    throw error;
  }
  return "PONG";
}

export async function closeStateStore(store) {
  if (store?.redis?.quit) await store.redis.quit();
}
