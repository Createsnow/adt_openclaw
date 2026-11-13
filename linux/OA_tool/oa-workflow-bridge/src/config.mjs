import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CONFIG_URL = new URL("../bridge-config.json", import.meta.url);
const SYSTEMS_URL = new URL("../systems.json", import.meta.url);

export const TICKET_TYPE_NAMES = Object.freeze(["运维支持", "权限申请", "IT需求"]);
export const DEFAULT_INBOX_TTL_MINUTES = 30;

const jsonCache = new Map();

async function readJsonFile(url) {
  const filePath = fileURLToPath(url);
  const info = await stat(filePath);
  const hit = jsonCache.get(filePath);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.value;
  const value = JSON.parse(await readFile(filePath, "utf8"));
  jsonCache.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, value });
  return value;
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

/** MySQL 连接参数（非机密）。密码只从环境变量 OA_MYSQL_PASSWORD 读。 */
function loadMysqlConfig(raw) {
  const mysql = raw?.mysql && typeof raw.mysql === "object" ? raw.mysql : {};
  const config = {
    host: String(mysql.host || "").trim(),
    port: requirePositiveInteger(mysql.port ?? 3306, "mysql.port"),
    user: String(mysql.user || "").trim(),
    database: String(mysql.database || "").trim(),
  };
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(config.host)) throw new Error("mysql.host is required");
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(config.user)) throw new Error("mysql.user is required");
  if (!/^[A-Za-z0-9_]{1,64}$/.test(config.database)) throw new Error("mysql.database is required");
  return config;
}

function loadIdentityConfig(raw) {
  const adapter = String(raw?.identity?.adapter || "on").trim().toLowerCase();
  if (adapter !== "on" && adapter !== "off") {
    throw new Error("identity.adapter must be on or off");
  }
  return { adapter };
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
    inboxTtlMinutes: requirePositiveInteger(raw.inboxTtlMinutes ?? DEFAULT_INBOX_TTL_MINUTES, "inboxTtlMinutes"),
    maxAttachmentBytes: requirePositiveInteger(raw.maxAttachmentBytes, "maxAttachmentBytes"),
    maxTotalAttachmentBytes: requirePositiveInteger(raw.maxTotalAttachmentBytes, "maxTotalAttachmentBytes"),
    mysql: loadMysqlConfig(raw),
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
  return config;
}

export function resolveInboxTtlMs(config) {
  const minutes = Number(config?.inboxTtlMinutes);
  return (Number.isInteger(minutes) && minutes > 0 ? minutes : DEFAULT_INBOX_TTL_MINUTES) * 60 * 1000;
}

/**
 * systems.json：所属系统 → OA 下拉选项 ID、处理人（clry）、允许的工单类型。
 * 返回三张查找表：options（名→ID）、handlers（名→处理人 ID 串）、typeSystems（类型→允许系统集合）。
 */
export function parseSystems(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid systems.json");
  }
  const options = new Map();
  const handlers = new Map();
  const typeSystems = new Map(TICKET_TYPE_NAMES.map((type) => [type, new Set()]));
  const optionIds = new Set();
  for (const [rawName, entry] of Object.entries(raw)) {
    const name = String(rawName).trim();
    const optionId = requirePositiveInteger(entry?.optionId, `systems.${name}.optionId`);
    const handlerIds = String(entry?.handlers ?? "").trim();
    if (!name || options.has(name) || optionIds.has(optionId)) {
      throw new Error("System names and option IDs must be unique");
    }
    if (!/^[1-9]\d{0,17}(,[1-9]\d{0,17})*$/.test(handlerIds)) {
      throw new Error(`systems.${name}.handlers must be comma-separated OA person IDs`);
    }
    const types = Array.isArray(entry?.types) ? entry.types : [];
    if (!types.length || types.some((type) => !typeSystems.has(type))) {
      throw new Error(`systems.${name}.types must list 运维支持 / 权限申请 / IT需求`);
    }
    options.set(name, optionId);
    optionIds.add(optionId);
    handlers.set(name, handlerIds);
    for (const type of types) typeSystems.get(type).add(name);
  }
  return { options, handlers, typeSystems };
}

export async function loadSystems() {
  return parseSystems(await readJsonFile(SYSTEMS_URL));
}
