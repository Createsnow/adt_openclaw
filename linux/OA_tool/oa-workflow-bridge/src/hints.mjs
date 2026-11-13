/**
 * 员工可见短句（hintZh）。模型可原样输出；不要给每个 JSON 字段加中文注释。
 * 确认卡 / 拦截卡 / 提交成功（需填处理人）仍由 AGENTS.md 模板拼装。
 */

const IDENTITY_UNMAPPED = `❌ **还不能提交到 OA**
> 原因：账号还没开通提交权限，请联系管理员`;

const PREPARE_FAILED = `❌ **确认准备失败**
> 原因：请稍后重试，或联系管理员`;

const OA_REJECTED = `❌ **确认准备失败**
> 原因：OA 拒绝了这张单，请联系管理员。不要自动再提交`;

const RECONCILE = `⚠️ **OA 需要人工核对**`;

const EXPIRED = `⏳ **这张确认单已过期**

之前的资料已清除，请重新说明问题后再提交。`;

const HINT_BY_CODE = {
  NO_NEW_ATTACHMENT: "没有检测到新文件，请重新发送图片或文档。",
  ATTACHMENT_LIMIT_EXCEEDED: "附件超出限制（单张 10MB / 合计 25MB / 最多 10 个），请精简后再发。原单仍在待确认。",
  OA_IDENTITY_NOT_FOUND: IDENTITY_UNMAPPED,
  OA_IDENTITY_NOT_CONFIGURED: IDENTITY_UNMAPPED,
  OA_IDENTITY_MAPPING_REQUIRED: IDENTITY_UNMAPPED,
  OA_IDENTITY_INACTIVE: IDENTITY_UNMAPPED,
  WECOM_IDENTITY_TOKEN_FAILED: IDENTITY_UNMAPPED,
  WECOM_IDENTITY_OUT_OF_SCOPE: IDENTITY_UNMAPPED,
  WECOM_IDENTITY_ALIGN_MISMATCH: IDENTITY_UNMAPPED,
  WECOM_IDENTITY_INVALID_SENDER: IDENTITY_UNMAPPED,
  OA_IDENTITY_LOOKUP_FAILED: PREPARE_FAILED,
  OA_IDENTITY_AMBIGUOUS: PREPARE_FAILED,
  WECOM_OPENUSERID_INVALID: PREPARE_FAILED,
  OA_PROFILE_INCOMPLETE: PREPARE_FAILED,
  OA_PROFILE_LOOKUP_FAILED: PREPARE_FAILED,
  VALIDATION_ERROR: PREPARE_FAILED,
  DRAFT_INVALID: "工单必填信息不全或超长，请按规则重新整理后再提交，不要原样重试。",
  INVALID_TICKET_TYPE: "工单类型无效，请重新确认是运维支持、权限申请还是 IT 需求。",
  SYSTEM_NOT_ALLOWED: "当前工单类型和所属系统对不上，请重新确认，不要猜测。",
  SYSTEM_UNMAPPED: "这个系统还不能提交到 OA，请联系管理员。",
  INVALID_LOCATION: "故障地点只能是智园、大磡、深汕、越南、光明或泗洪。",
  LOCATION_MISMATCH: "故障地点和所选系统不一致，请重新确认地点。",
  INVALID_DEMAND_TYPE: "IT 需求类型无效，请确认是流程新建、流程优化、数据处理还是集成对接。",
  INVALID_MONTHLY_HOURS: "月节约工时必须是大于等于 0 的数字。",
  HANDLER_NOT_CONFIGURED: "该系统还没有配置处理人，暂时不能建单，请联系管理员。",
  ATTACHMENT_FIELD_NOT_CONFIGURED: "当前流程未配置文档附件字段，请去掉文档后提交，或联系管理员。",
  SUPPLEMENT_TOO_LONG: "补充说明超过 2000 字，请缩短后再确认提交。",
  MISSING_CONFIRMATION_ID: "缺少确认号。请先 status 查询当前待确认，再确认或取消。",
  NOT_CONFIGURED: PREPARE_FAILED,
  INVALID_CONFIGURATION: PREPARE_FAILED,
  TOKEN_NETWORK_ERROR: PREPARE_FAILED,
  TOKEN_REJECTED: PREPARE_FAILED,
  UNTRUSTED_CONTEXT: PREPARE_FAILED,
  DB_UNAVAILABLE: PREPARE_FAILED,
  DB_SCHEMA_MISSING: PREPARE_FAILED,
  WORKFLOW_NOT_CREATEABLE: PREPARE_FAILED,
  PREFLIGHT_FAILED: PREPARE_FAILED,
  STAGING_MISSING: "附件暂存丢失，请重新说明问题并补发文件后再提交。",
  SENDER_MISMATCH: "只有原提交人可以确认或取消这张单。",
  NOT_FOUND: "没有找到这张确认单。有新问题请重新说明。",
  CONFIRMATION_EXPIRED: EXPIRED,
  EXPIRED,
  OA_BRIDGE_INACTIVE: "ℹ️ **已确认，但还不能创建 OA 工单**",
  RECONCILIATION_REQUIRED: RECONCILE,
  NETWORK_OUTCOME_UNKNOWN: RECONCILE,
  SYSTEM_INNER_ERROR: RECONCILE,
  MISSING_REQUEST_ID: RECONCILE,
  INVALID_RESPONSE: RECONCILE,
  UNKNOWN: RECONCILE,
  SUBMITTING: RECONCILE,
  PARAM_ERROR: OA_REJECTED,
  OA_CREATE_REJECTED: OA_REJECTED,
  OA_ERROR: OA_REJECTED,
  FAILED: OA_REJECTED,
};

export const SUBMITTED_PREVIEW_LIMIT = 5;

function isDigitRequestId(value) {
  return /^\d+$/.test(String(value || ""));
}

export function submittedPreview(recent = []) {
  const submitted = (Array.isArray(recent) ? recent : []).filter(
    (item) => String(item?.status || "").toLowerCase() === "submitted" && isDigitRequestId(item.requestId),
  );
  return {
    submittedCount: submitted.length,
    submitted: submitted.slice(0, SUBMITTED_PREVIEW_LIMIT).map((item) => ({
      requestId: String(item.requestId),
    })),
  };
}

export function personStatusHintZh({ pending, submittedCount = 0, submitted = [] } = {}) {
  if (pending) return "";
  if (!submittedCount) {
    return `🔍 目前没有待确认或已提交的记录。
有新问题直接发给我。`;
  }
  const listed = submitted.map((item) => `🎫 工单号：${item.requestId}`).join("\n");
  const heading = submittedCount > submitted.length
    ? `已提交 ${submittedCount} 条，最近 ${submitted.length} 条：`
    : `已提交 ${submittedCount} 条：`;
  return `🔍 目前没有待确认的记录。
${heading}
${listed}`;
}

export function attachmentReceiptHint({ imageCount = 0, documentCount = 0 } = {}) {
  const parts = [];
  if (Number(imageCount) > 0) parts.push(`${Number(imageCount)}份图片`);
  if (Number(documentCount) > 0) parts.push(`${Number(documentCount)}份文档`);
  if (!parts.length) return "";
  return `📎 已收到 ${parts.join("、")}`;
}

function alreadySubmittedHint(payload = {}) {
  const requestId = String(payload.requestId || "").trim();
  if (isDigitRequestId(requestId)) {
    return `✅ **这张单已经提交过**
🎫 工单号：${requestId}
请勿重复提交。`;
  }
  return `✅ **这张单已经提交过**
请勿重复提交。`;
}

export function hintZhFor(payload = {}) {
  const code = String(payload.code || "").toUpperCase();
  if (code === "ATTACHED" || code === "BUFFERED") {
    return attachmentReceiptHint(payload);
  }
  if (code === "PERSON_STATUS") {
    return personStatusHintZh(payload);
  }
  if (code === "ALREADY_SUBMITTED") {
    return alreadySubmittedHint(payload);
  }
  if (/^HTTP_5\d\d$/.test(code)) return RECONCILE;
  if (/^HTTP_\d+$/.test(code)) return OA_REJECTED;
  return HINT_BY_CODE[code] || "";
}

export function withHintZh(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (payload.hintZh) return payload;
  const hintZh = hintZhFor(payload);
  return hintZh ? { ...payload, hintZh } : payload;
}
