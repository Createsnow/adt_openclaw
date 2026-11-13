import { createHash, randomBytes } from "node:crypto";
import { requireIsnextflow } from "./config.mjs";
import { requireRequesterProfile } from "./hrm-profile.mjs";
import { OAClientError } from "./oa-client.mjs";

function fail(code, message) {
  throw new OAClientError(message, { code });
}

function readIsnextflow(config) {
  try {
    return requireIsnextflow(config?.isnextflow);
  } catch (error) {
    fail("INVALID_CONFIGURATION", error.message);
  }
}

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

const TICKET_TYPES = Object.freeze({
  "运维支持": { value: "0", systemField: "wtlx" },
  "权限申请": { value: "1", systemField: "szxt" },
  "IT需求": { value: "2", systemField: "szxtxq" },
});

const DEMAND_TYPES = Object.freeze({
  "流程新建": "0",
  "流程优化": "1",
  "数据处理": "2",
  "集成对接": "3",
});

/** 员工选择的故障园区。不是 OA 人事 `bgdd`，也不是 `systemName` 里「国内 / 越南B部」这类系统后缀。 */
export const FAULT_LOCATIONS = Object.freeze(["智园", "大磡", "深汕", "越南", "光明", "泗洪"]);

/** 问地点时员工回字母（A–F）：插件翻译成园区名。数字只留给确认 / 取消。 */
const LOCATION_LETTERS = Object.freeze({ A: "智园", B: "大磡", C: "深汕", D: "越南", E: "光明", F: "泗洪" });

function locationFromInput(value) {
  const text = String(value ?? "").trim();
  return LOCATION_LETTERS[text.toUpperCase()] || text;
}

const SUMMARY_MAX = 20;

/**
 * 确认卡上的问题预览，由插件从员工原话（problemDescription）截取：全文 ≤20 字原样；
 * 否则取到第一个句读（≤20 字）再加「...」；第一句也太长就硬截 20 字加「...」。
 */
export function summarize(problemDescription) {
  const text = String(problemDescription ?? "").replace(/\s+/g, " ").trim();
  const bare = text.replace(/[。．.！!？?；;，,\s]+$/u, "");
  if ([...bare].length <= SUMMARY_MAX) return bare;
  const first = /^(.+?)[。．！!？?；;，,]/u.exec(text)?.[1]?.trim() || "";
  if (first && [...first].length <= SUMMARY_MAX) return `${first}...`;
  return `${[...bare].slice(0, SUMMARY_MAX).join("")}...`;
}

export function campusFromSystemName(systemName) {
  const match = String(systemName ?? "").trim().match(/（([^）]+)）\s*$/);
  const campus = match?.[1] || "";
  return FAULT_LOCATIONS.includes(campus) ? campus : "";
}

/**
 * 确认卡 / 拦截卡用的故障地点。优先用 draft.location；缺省时从
 * `电脑/打印机/网络问题（智园）` 这类系统名兑底。邮箱（国内）、MES（越南B部）不兑底。
 */
export function normalizeFaultLocation({ location, systemName } = {}) {
  const explicit = locationFromInput(location);
  const fromName = campusFromSystemName(systemName);
  if (explicit) {
    if (!FAULT_LOCATIONS.includes(explicit)) {
      fail("INVALID_LOCATION", "location must be A–F or one of 智园 / 大磡 / 深汕 / 越南 / 光明 / 泗洪");
    }
    if (fromName && fromName !== explicit) {
      fail("LOCATION_MISMATCH", "location does not match systemName");
    }
    return explicit;
  }
  return fromName;
}

/** 回执用的故障地点：draft.location 优先，缺省从 systemName 括号兑底。 */
export function pendingFaultLocation(ticket) {
  try {
    return normalizeFaultLocation({
      location: ticket?.draft?.location,
      systemName: ticket?.draft?.systemName,
    });
  } catch {
    return campusFromSystemName(ticket?.draft?.systemName);
  }
}

function requireText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength) fail("DRAFT_INVALID", `${label} is required and must be <= ${maxLength} characters`);
  return text;
}

function optionalText(value, maxLength) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) fail("DRAFT_INVALID", `Optional text must be <= ${maxLength} characters`);
  return text;
}

function requireHandlerIds(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d{0,17}(,[1-9]\d{0,17})*$/.test(text)) {
    fail("HANDLER_NOT_CONFIGURED", "OA handler IDs are not configured for this system");
  }
  return text;
}

export function validateExternalTicketId(value) {
  const text = String(value ?? "").trim();
  if (!/^IT-\d{8}-\d{6}-[A-Z0-9]{4}$/.test(text)) throw new Error("Invalid external ticket ID");
  return text;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function bangkokStampFromUtcMs(utcMs) {
  const date = new Date(utcMs + BANGKOK_OFFSET_MS);
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}`;
}

function stampFromReceivedAt(value, now) {
  const text = String(value ?? "").trim();
  if (!text) return bangkokStampFromUtcMs(now);
  const wall = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (wall && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    return `${wall[1]}${wall[2]}${wall[3]}${wall[4]}${wall[5]}${wall[6]}`;
  }
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return bangkokStampFromUtcMs(parsed);
  return bangkokStampFromUtcMs(now);
}

function messageIdSuffix(messageId, fallbackSeed) {
  const raw = String(messageId ?? "").replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
  if (raw.length >= 4) return raw.slice(0, 4);
  const hash = createHash("sha256")
    .update(String(fallbackSeed))
    .update(randomBytes(16))
    .digest("hex")
    .toUpperCase();
  return `${raw}${hash}`.slice(0, 4);
}

function ctxMessageId(ctx) {
  return ctx?.messageId || ctx?.MessageId || ctx?.message_id || "";
}

function ctxReceivedAt(ctx) {
  return ctx?.WeComReceivedAt || ctx?.wecomReceivedAt || ctx?.receivedAt || "";
}

/**
 * xA 内部幂等号。模型传入的 draft.externalTicketId 一律忽略。
 * 时间用 WeComReceivedAt（无则当前时间，Asia/Bangkok）；XXXX 用 message_id 前 4 位。
 * 无 message_id 时后缀混入随机熵，避免同秒第二次 prepare 撞上上一张 unknown 单的 ledger。
 */
export function allocateExternalTicketId(ctx = {}, now = Date.now()) {
  const stamp = stampFromReceivedAt(ctxReceivedAt(ctx), now);
  const seed = `${ctx?.requesterSenderId || ""}|${ctx?.sessionKey || ctx?.sessionId || ""}|${now}`;
  return validateExternalTicketId(`IT-${stamp.slice(0, 8)}-${stamp.slice(8)}-${messageIdSuffix(ctxMessageId(ctx), seed)}`);
}

/** 规则未命中时的兜底：类型未命中按运维支持；类型已定但系统未命中按「其他」。 */
export const FALLBACK_TICKET_TYPE = "运维支持";
export const FALLBACK_SYSTEM_NAME = "其他";

export function normalizeDraft(raw, { options, typeSystems, handlers, names }) {
  const ticketType = String(raw?.ticketType ?? "").trim() || FALLBACK_TICKET_TYPE;
  const typeConfig = TICKET_TYPES[ticketType];
  if (!typeConfig) fail("INVALID_TICKET_TYPE", "Unsupported ticket type");
  const systemName = String(raw?.systemName ?? "").trim() || FALLBACK_SYSTEM_NAME;
  if (systemName.length > 80) fail("DRAFT_INVALID", "systemName must be <= 80 characters");
  if (!typeSystems.get(ticketType)?.has(systemName)) {
    fail("SYSTEM_NOT_ALLOWED", "System name is not allowed for this ticket type");
  }
  const systemOptionId = options.get(systemName);
  if (!systemOptionId) fail("SYSTEM_UNMAPPED", "System name is not mapped to an OA option ID");
  const normalized = {
    externalTicketId: validateExternalTicketId(raw?.externalTicketId),
    ticketType,
    ticketTypeValue: typeConfig.value,
    systemName,
    location: normalizeFaultLocation({ location: raw?.location, systemName }),
    systemField: typeConfig.systemField,
    systemOptionId,
    problemDescription: requireText(raw?.problemDescription, "problemDescription", 6000),
    impactScope: optionalText(raw?.impactScope, 200),
    occurredAt: optionalText(raw?.occurredAt, 200),
    attemptedMeasures: optionalText(raw?.attemptedMeasures, 1000),
    demandType: "",
    demandTypeValue: "",
    monthlyHours: "",
    handlerIds: requireHandlerIds(handlers.get(systemName)),
    handlerNames: names?.get(systemName) || "",
  };
  normalized.summary = summarize(normalized.problemDescription);
  if (ticketType === "IT需求") {
    normalized.demandType = requireText(raw?.demandType, "demandType", 16);
    normalized.demandTypeValue = DEMAND_TYPES[normalized.demandType];
    if (normalized.demandTypeValue === undefined) fail("INVALID_DEMAND_TYPE", "Unsupported demand type");
    const hours = Number(raw?.monthlyHours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 100000) fail("INVALID_MONTHLY_HOURS", "monthlyHours must be a non-negative number");
    normalized.monthlyHours = String(hours);
  }
  return normalized;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function metaLines(draft, supplement) {
  return [
    draft.impactScope ? `影响范围：${draft.impactScope}` : "",
    draft.occurredAt ? `发生时间：${draft.occurredAt}` : "",
    draft.attemptedMeasures ? `已尝试措施：${draft.attemptedMeasures}` : "",
    supplement ? `最终补充：${supplement}` : "",
  ].filter(Boolean);
}

/**
 * `wtxqmskftp` 按 HTML 渲染（图片就是靠内嵌 `<img>` 显示的），所以员工原文一律转义，
 * 换行也必须写成 `<br/>`，否则 HTML 会把 `\n` 折叠掉。无图时 imgHtml 为空串被滤除。
 */
export function buildDescription(draft, supplement = "", images = []) {
  const imgHtml = images
    .map((image) => `<img src="${image.dataUri}" alt="${escapeHtml(image.fileName)}" />`)
    .join("<br/>");
  return [
    escapeHtml(draft.problemDescription).replace(/\n/g, "<br/>"),
    imgHtml,
    ...metaLines(draft, supplement).map((line) => escapeHtml(line)),
  ].filter(Boolean).join("<br/>");
}

export function buildCreatePayload({ config, draft, oaRequesterId, profile, attachments = [], images = [], supplement = "" } = {}) {
  const requesterProfile = requireRequesterProfile(profile);
  const handlerIds = requireHandlerIds(draft.handlerIds);
  const mainData = [
    { fieldName: "xqsqr", fieldValue: String(oaRequesterId) },
    { fieldName: "xqsqbm", fieldValue: requesterProfile.departmentId },
    { fieldName: "gw", fieldValue: requesterProfile.jobTitleId },
    { fieldName: "bgdd", fieldValue: requesterProfile.locationId },
    { fieldName: "sqlx", fieldValue: draft.ticketTypeValue },
    { fieldName: draft.systemField, fieldValue: String(draft.systemOptionId) },
    { fieldName: "wtxqmskftp", fieldValue: buildDescription(draft, supplement, images) },
    { fieldName: "clry", fieldValue: handlerIds },
  ];
  if (draft.ticketType === "IT需求") {
    mainData.push(
      { fieldName: "xqlx1", fieldValue: draft.demandTypeValue },
      { fieldName: "yjygsh", fieldValue: draft.monthlyHours },
    );
  }
  if (attachments.length) {
    if (!config.attachmentFieldName) fail("ATTACHMENT_FIELD_NOT_CONFIGURED", "OA attachment field is not configured");
    // OA：scfj 内容是 [{ filePath, fileName }] 数组；HTTP 上 fieldValue 必须是该数组的 JSON 字符串。
    // filePath 用 Ecology 附件约定 `base64:<裸base64>`，不要发 native 数组或裸 base64（现网都会 PARAM_ERROR）。
    mainData.push({ fieldName: config.attachmentFieldName, fieldValue: JSON.stringify(attachments) });
  }
  const requestName = `[${draft.externalTicketId}] ${draft.summary}`.slice(0, 120);
  return {
    workflowId: config.workflowId,
    requestName,
    // isnextflow 来自 bridge-config.json；"1" 建单后自动流转，"0" 停在申请人节点。
    // delReqFlowFaild / isVerifyPer 是 Ecology 协议常量，不做成可配项。
    otherParams: {
      isnextflow: readIsnextflow(config),
      delReqFlowFaild: "1",
      isVerifyPer: "1",
    },
    mainData,
  };
}

export function sanitizeSupplement(value) {
  const text = String(value ?? "").trim();
  if (text.length > 2000) fail("SUPPLEMENT_TOO_LONG", "Final supplement must be <= 2000 characters");
  return text;
}
