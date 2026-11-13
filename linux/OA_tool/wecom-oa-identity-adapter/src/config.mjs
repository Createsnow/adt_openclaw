import { readFile } from "node:fs/promises";

const CONFIG_URL = new URL("../adapter-config.json", import.meta.url);

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function validateWecomBaseUrl(value) {
  const parsed = new URL(String(value));
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "qyapi.weixin.qq.com" ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("WeCom base URL must be exactly https://qyapi.weixin.qq.com");
  }
  return "https://qyapi.weixin.qq.com";
}

function validateOaBaseUrl(value) {
  const parsed = new URL(String(value));
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "adtekoa.com" ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("OA base URL must be exactly https://adtekoa.com");
  }
  return "https://adtekoa.com";
}

export async function loadAdapterConfig() {
  const raw = JSON.parse(await readFile(CONFIG_URL, "utf8"));
  const cacheRaw = raw?.cache && typeof raw.cache === "object" ? raw.cache : {};
  const config = {
    alignMode: String(raw.alignMode || "userid_equals_workcode").trim(),
    wecomBaseUrl: validateWecomBaseUrl(raw.wecomBaseUrl || "https://qyapi.weixin.qq.com"),
    oaBaseUrl: validateOaBaseUrl(raw.oaBaseUrl || "https://adtekoa.com"),
    wecomTokenCacheMs: requirePositiveInteger(raw.wecomTokenCacheMs || 5_400_000, "wecomTokenCacheMs"),
    cache: {
      store: String(cacheRaw.store || "redis").trim(),
      keyPrefix: String(cacheRaw.keyPrefix || "oa-workflow-bridge").trim(),
      ttlHours: requirePositiveInteger(cacheRaw.ttlHours || 24, "cache.ttlHours"),
      missTtlSeconds: requirePositiveInteger(cacheRaw.missTtlSeconds || 600, "cache.missTtlSeconds"),
    },
  };
  if (config.alignMode !== "userid_equals_workcode") {
    throw new Error("Unsupported alignMode");
  }
  if (config.cache.store !== "redis") {
    throw new Error("identity cache.store must be redis");
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(config.cache.keyPrefix.replace(/:+$/, ""))) {
    throw new Error("Invalid Redis keyPrefix");
  }
  return config;
}
