import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CONFIG_URL = new URL("../bridge-config.json", import.meta.url);
const OPTIONS_URL = new URL("../system-options.json", import.meta.url);
const HANDLERS_URL = new URL("../system-handlers.json", import.meta.url);
const TICKET_TYPE_SYSTEMS_URL = new URL("../ticket-type-systems.json", import.meta.url);

const jsonCache = new Map();

export function resetConfigCaches() {
  jsonCache.clear();
}

async function readJsonFile(url) {
  const filePath = fileURLToPath(url);
  const info = await stat(filePath);
  const hit = jsonCache.get(filePath);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.value;
  const value = JSON.parse(await readFile(filePath, "utf8"));
  jsonCache.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, value });
  return value;
}

export const DEFAULT_INBOX_TTL_MINUTES = 30;

function loadInboxTtl(raw) {
  const hasMinutes = raw.inboxTtlMinutes !== undefined && raw.inboxTtlMinutes !== null && raw.inboxTtlMinutes !== "";
  const hasHours = raw.inboxTtlHours !== undefined && raw.inboxTtlHours !== null && raw.inboxTtlHours !== "";
  if (hasMinutes && hasHours) {
    throw new Error("Use inboxTtlMinutes or inboxTtlHours, not both");
  }
  if (hasMinutes) {
    return { inboxTtlMinutes: requirePositiveInteger(raw.inboxTtlMinutes, "inboxTtlMinutes") };
  }
  if (hasHours) {
    const hours = requirePositiveInteger(raw.inboxTtlHours, "inboxTtlHours");
    return { inboxTtlMinutes: hours * 60 };
  }
  return { inboxTtlMinutes: DEFAULT_INBOX_TTL_MINUTES };
}

/** 建单前 inbox 存活时长。优先 inboxTtlMinutes，兼容测试里仍传 inboxTtlHours。默认 30 分钟，对齐 OpenClaw 空闲新会话。 */
export function resolveInboxTtlMs(config) {
  const minutes = Number(config?.inboxTtlMinutes);
  if (Number.isInteger(minutes) && minutes > 0) return minutes * 60 * 1000;
  const hours = Number(config?.inboxTtlHours);
  if (Number.isInteger(hours) && hours > 0) return hours * 60 * 60 * 1000;
  return DEFAULT_INBOX_TTL_MINUTES * 60 * 1000;
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

/** Ecology otherParams.isnextflow：只允许字符串 "0" / "1"，缺字段或乱填拒绝加载。 */
export function requireIsnextflow(value) {
  const text = String(value ?? "").trim();
  if (text !== "0" && text !== "1") {
    throw new Error('isnextflow must be "0" or "1"');
  }
  return text;
}

function validateBaseUrl(value) {
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

function loadIdentityConfig(raw) {
  const identity = raw?.identity && typeof raw.identity === "object" ? raw.identity : {};
  const adapter = String(identity.adapter || "on").trim().toLowerCase();
  if (adapter !== "on" && adapter !== "off") {
    throw new Error("identity.adapter must be on or off");
  }
  const store = String(identity.store || "redis").trim().toLowerCase();
  if (store !== "redis") {
    throw new Error("identity.store must be redis");
  }
  return { adapter, store };
}

function loadRedisConfig(raw) {
  const redisRaw = raw?.redis && typeof raw.redis === "object" ? raw.redis : {};
  const database = Number(redisRaw.database);
  return {
    url: String(redisRaw.url || "").trim(),
    keyPrefix: String(redisRaw.keyPrefix || "oa-workflow-bridge").trim(),
    database: Number.isInteger(database) && database >= 0 ? database : 0,
  };
}

export async function loadBridgeConfig() {
  const raw = await readJsonFile(CONFIG_URL);
  const config = {
    active: raw.active === true,
    baseUrl: validateBaseUrl(raw.baseUrl),
    appId: String(raw.appId || "").trim(),
    workflowId: requirePositiveInteger(raw.workflowId, "workflowId"),
    isnextflow: requireIsnextflow(raw.isnextflow),
    publicKeySpkiBase64: String(raw.publicKeySpkiBase64 || "").replace(/\s+/g, ""),
    attachmentFieldName: String(raw.attachmentFieldName || "").trim(),
    pendingTtlHours: requirePositiveInteger(raw.pendingTtlHours, "pendingTtlHours"),
    // 建单前附件缓冲，对齐 OpenClaw 空闲 30 分钟开新会话；`/new` / session_end 会立刻清掉。
    ...loadInboxTtl(raw),
    maxAttachmentBytes: requirePositiveInteger(raw.maxAttachmentBytes, "maxAttachmentBytes"),
    maxTotalAttachmentBytes: requirePositiveInteger(raw.maxTotalAttachmentBytes, "maxTotalAttachmentBytes"),
    redis: loadRedisConfig(raw),
    identity: loadIdentityConfig(raw),
  };
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(config.appId)) {
    throw new Error("Invalid OA appId");
  }
  if (!/^[A-Za-z0-9+/=]{300,800}$/.test(config.publicKeySpkiBase64)) {
    throw new Error("Invalid OA RSA public key");
  }
  if (config.attachmentFieldName && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(config.attachmentFieldName)) {
    throw new Error("Invalid OA attachment field name");
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(config.redis.keyPrefix.replace(/:+$/, ""))) {
    throw new Error("Invalid Redis keyPrefix");
  }
  return config;
}

export async function loadSystemOptions() {
  const raw = await readJsonFile(OPTIONS_URL);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid OA system option mapping");
  }
  const result = new Map();
  const ids = new Set();
  for (const [name, value] of Object.entries(raw)) {
    const normalizedName = String(name).trim();
    const id = requirePositiveInteger(value, `system option ${normalizedName}`);
    if (!normalizedName || result.has(normalizedName) || ids.has(id)) {
      throw new Error("OA system option names and IDs must be unique");
    }
    result.set(normalizedName, id);
    ids.add(id);
  }
  return result;
}

function requireHandlerIds(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d{0,17}(,[1-9]\d{0,17})*$/.test(text)) {
    throw new Error(`${label} must be comma-separated OA person IDs`);
  }
  return text;
}

export async function loadSystemHandlers() {
  const raw = await readJsonFile(HANDLERS_URL);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid OA system handler mapping");
  }
  const result = new Map();
  for (const [name, value] of Object.entries(raw)) {
    const normalizedName = String(name).trim();
    if (!normalizedName || result.has(normalizedName)) {
      throw new Error("OA system handler names must be unique");
    }
    result.set(normalizedName, requireHandlerIds(value, `system handler ${normalizedName}`));
  }
  return result;
}

export async function loadTicketTypeSystems() {
  const raw = await readJsonFile(TICKET_TYPE_SYSTEMS_URL);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid ticket type system allowlist");
  }
  const result = new Map();
  for (const [ticketType, names] of Object.entries(raw)) {
    const typeName = String(ticketType).trim();
    if (!typeName || !Array.isArray(names) || names.length === 0) {
      throw new Error("Ticket type system allowlist entries must be non-empty arrays");
    }
    const allowed = new Set();
    for (const name of names) {
      const systemName = String(name).trim();
      if (!systemName || allowed.has(systemName)) {
        throw new Error("Ticket type system names must be unique within each type");
      }
      allowed.add(systemName);
    }
    result.set(typeName, allowed);
  }
  return result;
}
