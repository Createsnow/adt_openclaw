import { attach } from "./actions/attach.mjs";
import { cancel } from "./actions/cancel.mjs";
import { prepare } from "./actions/prepare.mjs";
import { status } from "./actions/status.mjs";
import { submitConfirmed } from "./actions/submit.mjs";
import { loadBridgeConfig, loadSystems } from "./config.mjs";
import { withHintZh } from "./hints.mjs";
import { lookupRequesterProfile } from "./hrm-profile.mjs";
import { getSharedOAClient, OAClientError } from "./oa-client.mjs";
import { removeStagingDirectory } from "./store.mjs";
import { requireTrustedContext } from "./trust.mjs";

const ACTIONS = {
  prepare,
  attach,
  status,
  cancel,
  submit_confirmed: submitConfirmed,
};

/** 需要 confirmationId 的动作。 */
const NEEDS_CONFIRMATION_ID = new Set(["cancel", "submit_confirmed"]);

const DB_ERROR_CODES = new Set([
  "DB_UNAVAILABLE", "ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH",
  "PROTOCOL_CONNECTION_LOST", "ER_ACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR", "ER_NO_SUCH_TABLE", "ER_CON_COUNT_ERROR",
]);

/** 每个回执都带 replyZh（员工可见整段回复）：动作没拼专门卡片时用 hintZh 兜底。 */
function textResult(data) {
  const withHint = withHintZh(data);
  const replyZh = withHint.replyZh || withHint.hintZh;
  return { content: [{ type: "text", text: JSON.stringify(replyZh ? { ...withHint, replyZh } : withHint, null, 2) }] };
}

function errorCodeFor(error) {
  if (error instanceof OAClientError) return error.code;
  if (DB_ERROR_CODES.has(String(error?.code || "")) || error?.sqlState || error?.fatal) return "DB_UNAVAILABLE";
  return "VALIDATION_ERROR";
}

function safeError(error) {
  return textResult({
    ok: false,
    code: errorCodeFor(error),
    message: error?.message || "OA workflow operation failed",
    ...(error instanceof OAClientError && error.details ? error.details : {}),
  });
}

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["prepare", "attach", "submit_confirmed", "status", "cancel"],
      description: "prepare 建待确认（已有待确认单会被替换）；attach 只收图片/文件；submit_confirmed 确认后建 OA；status 按人查当前待确认和最近已提交；cancel 作废待确认。",
    },
    confirmationId: {
      type: "string",
      description: "内部确认号。员工确认/取消/补附件时传入；查进度不要传。禁止展示给员工。",
    },
    supplement: {
      type: "string",
      description: "确认提交时的一次性补充。改稿不要用这个字段，直接再 prepare。",
    },
    submitNow: {
      type: "boolean",
      description: "仅 prepare：员工原话已要求直接提交（帮我提交 / 立刻提交等）且事实已齐时传 true，建单后立刻提交。",
    },
    context: {
      type: "string",
      enum: ["unclear_reply", "asked_oa_number"],
      description: "仅 status：unclear_reply = 员工在确认卡上回了「好的 / 不用了」等含糊话；asked_oa_number = 员工报了 OA 工单号问进度。",
    },
    attachments: {
      type: "array",
      maxItems: 10,
      description: "一般不必传。企微 inbound 由插件自动暂存。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          localPath: { type: "string", description: "仅 inbound 目录内的本地路径。" },
          fileName: { type: "string", description: "可选文件名。" },
        },
        required: ["localPath"],
      },
    },
    draft: {
      type: "object",
      additionalProperties: false,
      description: "prepare 的业务底稿。不要传 OA 字段名、人员 id、工单号。",
      properties: {
        externalTicketId: { type: "string", description: "不要传。内部幂等号由插件生成，传入也会被忽略。" },
        ticketType: { type: "string", enum: ["运维支持", "权限申请", "IT需求"], description: "工单类型。规则未命中时不传，插件按运维支持。" },
        systemName: { type: "string", description: "所属系统，必须与当前类型允许清单完全一致。规则未命中时不传，插件按「其他」。" },
        location: { type: "string", description: "故障地点。仅电脑/打印机/网络问题传入：智园 / 大磡 / 深汕 / 越南 / 光明 / 泗洪，或员工回的字母 A–F。不要写进 problemDescription。" },
        problemDescription: { type: "string", description: "只抄员工文字。短句短抄；长文或断续多轮按顺序合并。不要写地点、见图、未说明。确认卡不要贴这一段。" },
        impactScope: { type: "string", description: "可选。员工没说就不要传。" },
        occurredAt: { type: "string", description: "可选。员工没说就不要传。" },
        attemptedMeasures: { type: "string", description: "可选。员工没说就不要传。" },
        demandType: { type: "string", enum: ["流程新建", "流程优化", "数据处理", "集成对接"], description: "仅 IT 需求必填。" },
        monthlyHours: { type: "number", minimum: 0, description: "仅 IT 需求必填，月节约工时，≥0。" },
      },
      required: ["problemDescription"],
    },
  },
  required: ["action"],
};

const DESCRIPTION = "IT 工单：整理员工报的问题成待确认单，员工确认后提交到 OA 流程。图片 / 文件由插件自动收下，不必传路径。每个回执都有 replyZh：那就是要发给员工的整段回复，原样输出，不要改写、不要再加别的话（只有 BUFFERED 之后可以再追问一句缺的信息）。不要传工单号、URL、凭据、流程 ID、OA 字段名或人员 id。";

/**
 * dependencies（测试注入）：loadConfig、loadSystems、clientFactory、lookupRequesterProfile、
 * identityAdapter（`{ resolve }` 或 `async (store, config) => ({ resolve })`）、removeStagingDirectory。
 */
export function createOAWorkflowToolFactory({ stateDir, stateStore, resolveStateStore, logger, dependencies = {} }) {
  const adapter = dependencies.identityAdapter;
  const deps = {
    loadConfig: dependencies.loadConfig || loadBridgeConfig,
    loadSystems: dependencies.loadSystems || loadSystems,
    clientFactory: dependencies.clientFactory || ((config) => getSharedOAClient({ config })),
    lookupProfile: dependencies.lookupRequesterProfile || lookupRequesterProfile,
    identityAdapter: typeof adapter === "function" ? adapter : async () => adapter || null,
    removeSubmittedStaging: dependencies.removeStagingDirectory || removeStagingDirectory,
  };

  async function store() {
    if (stateStore) return stateStore;
    if (resolveStateStore) return resolveStateStore();
    throw new OAClientError("OA bridge state store is not configured", { code: "DB_UNAVAILABLE" });
  }

  return (ctx) => ({
    name: "oa_workflow",
    label: "xA OA 工单流程",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(_toolCallId, params) {
      try {
        const handler = ACTIONS[params?.action];
        if (!handler) throw new OAClientError("Unsupported OA workflow action", { code: "VALIDATION_ERROR" });
        const activeStore = await store();
        const trust = requireTrustedContext(ctx);
        const config = await deps.loadConfig();
        if (NEEDS_CONFIRMATION_ID.has(params.action) && (!params.confirmationId || typeof params.confirmationId !== "string")) {
          throw new OAClientError("confirmationId is required", { code: "MISSING_CONFIRMATION_ID" });
        }
        return textResult(await handler({ store: activeStore, stateDir, config, ctx, trust, params, logger, deps }));
      } catch (error) {
        logger?.warn?.(`[oa-workflow-bridge] ${params?.action || "oa_workflow"} failed: ${error?.message || error}`);
        return safeError(error);
      }
    },
  });
}
