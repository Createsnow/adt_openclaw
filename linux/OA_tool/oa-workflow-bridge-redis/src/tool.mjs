import { randomBytes } from "node:crypto";
import { loadBridgeConfig, loadSystemOptions, loadTicketTypeSystems, loadSystemHandlers, resolveInboxTtlMs } from "./config.mjs";
import { requireTrustedContext } from "./trust.mjs";
import {
  adoptStagedFiles,
  encodeStagedAttachments,
  stageAttachments,
  stagedBytes,
  summarizeStaged,
} from "./attachments.mjs";
import { lookupRequesterProfile } from "./hrm-profile.mjs";
import { maskFileNames } from "./log-redact.mjs";
import { allocateExternalTicketId, buildCreatePayload, normalizeDraft, pendingFaultLocation, sanitizeSupplement } from "./mapping.mjs";
import { getSharedOAClient, OAClientError } from "./oa-client.mjs";
import { resolveProtectedValues } from "./secret-resolver.mjs";
import { inboxDirName } from "./staging.mjs";
import {
  attachmentIdentityKeys,
  collectCtxMedia,
  collectPrepareAttachments,
  collectSubmitAttachments,
  consumeInboundMediaFor,
  forgetStagedPathsFor,
  peekInboundMediaFor,
  rememberInboundMediaFor,
  rememberStagedPathsFor,
} from "./inbound-media.mjs";
import {
  cleanupExpiredStaging,
  commitTicketState,
  getInbox,
  getLedger,
  getLedgerByConfirmation,
  getPending,
  getPersonInboxSession,
  getPersonPendingId,
  getPersonTickets,
  getSessionPendingId,
  removeInbox,
  removeInboxDirectory,
  removeStagingDirectory,
  setInbox,
  wipePersonInbox,
  withStateLock,
} from "./state-store.mjs";
import { submittedPreview, withHintZh } from "./hints.mjs";

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(withHintZh(data), null, 2) }] };
}

const REDIS_UNAVAILABLE_CODES = new Set(["REDIS_UNAVAILABLE", "ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EPIPE", "ETIMEDOUT", "NR_CLOSED"]);
const REDIS_UNAVAILABLE_MESSAGE = /ECONNREFUSED|ENOTFOUND|ECONNRESET|EPIPE|ETIMEDOUT|NR_CLOSED|Socket closed|Connection is closed|Stream isn't writeable|MOVED|READONLY/i;

function errorCodeFor(error) {
  if (error instanceof OAClientError) return error.code;
  const code = String(error?.code || "");
  if (REDIS_UNAVAILABLE_CODES.has(code) || REDIS_UNAVAILABLE_MESSAGE.test(String(error?.message || ""))) {
    return "REDIS_UNAVAILABLE";
  }
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

function newConfirmationId() {
  return `OA-${Date.now().toString(36).toUpperCase()}-${randomBytes(8).toString("hex").toUpperCase()}`;
}

/** sessionId 已变时丢掉上一会话尚未 prepare 的 inbox，避免 `/new` 后旧图进新单。 */
async function dropRotatedInbox(activeStore, stateDir, trust) {
  await withStateLock(activeStore, async () => {
    const pointed = await getPersonInboxSession(activeStore, trust.identity);
    if (!pointed || pointed === trust.session) return;
    await wipePersonInbox(activeStore, stateDir, trust.identity, pointed);
  });
}

async function getMappedOaUserId({ identity, senderId, config, adapter }) {
  if ((config.identity?.adapter || "on") !== "on") return "";
  if (adapter?.getCachedOaUserId) {
    const cached = await adapter.getCachedOaUserId(identity);
    if (cached) return cached;
  }
  if (!adapter?.resolve) {
    return "";
  }
  try {
    const result = await adapter.resolve(senderId);
    return /^\d{1,18}$/.test(String(result?.oaUserId || "")) ? String(result.oaUserId) : "";
  } catch (error) {
    if (error instanceof OAClientError) throw error;
    throw new OAClientError(error?.message || "OA identity lookup failed", {
      code: error?.code || "OA_IDENTITY_LOOKUP_FAILED",
    });
  }
}

function isSamePendingSession(pending, trust) {
  return Boolean(pending?.session && trust?.session && pending.session === trust.session);
}

function isoExpiresAt(expiresAt) {
  const ms = Number(expiresAt);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function pendingCardFields(pending) {
  return {
    summary: pending?.draft?.summary || null,
    location: pendingFaultLocation(pending) || null,
    ...summarizeStaged(pending?.staged || []),
  };
}

function alreadyPendingPayload(conflict, config) {
  const crossSession = conflict?.sameSession === false;
  return {
    ok: false,
    code: "ALREADY_PENDING",
    message: crossSession
      ? "This sender already has a pending OA confirmation in another session. Confirm or cancel it within the retention window; do not add files or rewrite from this session."
      : "This sender already has a pending OA confirmation.",
    confirmationId: conflict.confirmationId,
    externalTicketId: conflict.externalTicketId,
    summary: conflict.summary ?? null,
    location: conflict.location ?? null,
    imageCount: conflict.imageCount ?? 0,
    documentCount: conflict.documentCount ?? 0,
    attachmentCount: conflict.attachmentCount ?? 0,
    sameSession: !crossSession,
    retentionHours: config?.pendingTtlHours,
    expiresAt: isoExpiresAt(conflict.expiresAt),
  };
}

function pendingConflictView(existing, trust, externalTicketId) {
  if (!existing) return null;
  if (Number(existing.expiresAt) <= Date.now()) return { expired: existing };
  if (externalTicketId && existing.draft?.externalTicketId === externalTicketId) return null;
  return {
    confirmationId: existing.confirmationId,
    externalTicketId: existing.draft?.externalTicketId || null,
    expiresAt: existing.expiresAt,
    sameSession: isSamePendingSession(existing, trust),
    ...pendingCardFields(existing),
  };
}

async function loadPersonPending(store, trust) {
  let existingId = await getPersonPendingId(store, trust.identity);
  if (!existingId) existingId = await getSessionPendingId(store, trust.identity, trust.session);
  if (!existingId) return null;
  const existing = await getPending(store, existingId);
  if (!existing || existing.identity !== trust.identity) return null;
  return existing;
}

/**
 * 同一提交人全局只允许一张待确认单（跨 `/new` 仍拦住）。
 * 企微把正文和附件拆成两条投递时，两轮会各生成一个工单号，只按 externalTicketId 查 ledger 拦不住。
 */
async function findPersonPendingConflict(store, trust, externalTicketId) {
  return pendingConflictView(await loadPersonPending(store, trust), trust, externalTicketId);
}

/** cancel 会连同 staging 目录删掉附件副本，必须把源 inbound 路径放回会话缓冲，同轮改稿后的新单才不会少附件。 */
function restoreStagedSources(ctx, staged) {
  const sources = (staged || [])
    .filter((item) => item?.sourcePath)
    .map((item) => ({ localPath: item.sourcePath, fileName: item.fileName }));
  if (!sources.length) return;
  forgetStagedPathsFor(ctx, sources);
  rememberInboundMediaFor(ctx, sources, { restoredFromCancel: true });
}

function settleInbound(ctx, incoming) {
  if (!incoming?.length) return;
  rememberStagedPathsFor(ctx, incoming, { merge: true });
  consumeInboundMediaFor(ctx);
}

/**
 * `attach`：把员工陆续发来的图片/文件并入工单，不销毁 pending、不换 confirmationId。
 * 带 confirmationId 时追加到待确认单；同会话已有 pending 时漏传 id 也并入该单。
 * 尚无 pending 时先落到会话 inbox，等 prepare 认领。
 * 附件数量与体积在这一刻就校验，不拖到员工点「确认提交」才失败。
 */
async function attachInbound({ activeStore, config, ctx, stateDir, trust, confirmationId, paramsAttachments, now, logger }) {
  // 认领 pending 还是写入 inbox 必须在锁内决定：prepare 的快照/commit/清 inbox 也持这把锁，
  // 否则 attach 会在「还没有 pending」时拍板，等锁释放后把文件写进已被清空的 inbox。
  return withStateLock(activeStore, async () => {
  const personPending = await loadPersonPending(activeStore, trust);
  const conflict = pendingConflictView(personPending, trust, null);
  if (conflict && !conflict.expired && conflict.sameSession === false) {
    return alreadyPendingPayload(conflict, config);
  }
  if (conflict?.expired && !confirmationId) {
    await wipeExpiredPending({ activeStore, stateDir, pending: conflict.expired, locked: true });
  }
  if (!confirmationId && conflict && !conflict.expired && conflict.sameSession) {
    confirmationId = conflict.confirmationId;
  }
  if (confirmationId) {
    let outcome;
    await withStateLock(activeStore, async () => {
      const pending = await getPending(activeStore, confirmationId);
      if (!pending) {
        throw new OAClientError("Pending OA confirmation was not found", { code: "NOT_FOUND" });
      }
      if (pending.identity !== trust.identity) {
        throw new OAClientError("Only the original WeCom sender can add files to this OA request", { code: "SENDER_MISMATCH" });
      }
      if (pending.expiresAt <= Date.now()) {
        await wipeExpiredPending({ activeStore, stateDir, pending, locked: true });
        throw new OAClientError("OA confirmation expired", { code: "CONFIRMATION_EXPIRED" });
      }
      if (["submitting", "unknown"].includes(pending.submissionState)) {
        throw new OAClientError("This ticket requires OA reconciliation before retry", { code: "RECONCILIATION_REQUIRED" });
      }
      const incoming = collectSubmitAttachments(ctx, paramsAttachments, stateDir);
      logger?.info?.(
        `[oa-workflow-bridge-redis] attach collecting ${incoming.length} inbound (buffered=${peekInboundMediaFor(ctx).length} ctx=${collectCtxMedia(ctx, stateDir).length}): ${maskFileNames(incoming)}`,
      );
      const added = await stageAttachments({
        stateDir,
        confirmationId,
        attachments: incoming,
        config,
        startIndex: pending.staged.length,
        existingBytes: stagedBytes(pending.staged),
      });
      if (added.length) {
        pending.staged = [...pending.staged, ...added];
        await commitTicketState(activeStore, { pending });
      }
      settleInbound(ctx, added.length ? incoming : []);
      outcome = { addedCount: added.length, staged: pending.staged };
    });
    logger?.info?.(
      `[oa-workflow-bridge-redis] attach ${outcome.addedCount ? "attached" : "no-new"} added=${outcome.addedCount} confirmationId=${confirmationId}`,
    );
    return {
      ok: true,
      code: outcome.addedCount ? "ATTACHED" : "NO_NEW_ATTACHMENT",
      confirmationId,
      addedCount: outcome.addedCount,
      ...summarizeStaged(outcome.staged),
    };
  }

  // 建单前 inbox 与待确认 attach 一样必须串行：两轮重叠时后写会整份覆盖 Redis，磁盘还会撞 01- 文件名。
  let buffered;
  await withStateLock(activeStore, async () => {
    await dropRotatedInbox(activeStore, stateDir, trust);
    const existing = await getInbox(activeStore, trust.identity, trust.session);
    const items = Array.isArray(existing?.items) ? existing.items : [];
    const knownKeys = new Set();
    for (const item of items) {
      for (const key of attachmentIdentityKeys(item.sourcePath, item.fileName)) knownKeys.add(key);
    }
    const incoming = collectPrepareAttachments(ctx, paramsAttachments, stateDir)
      .filter((item) => !attachmentIdentityKeys(item.localPath, item.fileName).some((key) => knownKeys.has(key)));
    logger?.info?.(
      `[oa-workflow-bridge-redis] attach collecting ${incoming.length} inbound (buffered=${peekInboundMediaFor(ctx).length} ctx=${collectCtxMedia(ctx, stateDir).length} inbox=${items.length}): ${maskFileNames(incoming)}`,
    );
    const added = await stageAttachments({
      stateDir,
      stageDirName: inboxDirName(trust.identity, trust.session),
      attachments: incoming,
      config,
      startIndex: items.length,
      existingBytes: stagedBytes(items),
    });
    const nextItems = [...items, ...added];
    if (added.length) {
      await setInbox(
        activeStore,
        trust.identity,
        trust.session,
        { items: nextItems, updatedAt: new Date(now).toISOString() },
        resolveInboxTtlMs(config),
      );
    }
    settleInbound(ctx, added.length ? incoming : []);
    buffered = { addedCount: added.length, staged: nextItems };
  });
  logger?.info?.(
    `[oa-workflow-bridge-redis] attach ${buffered.addedCount ? "buffered" : "no-new"} added=${buffered.addedCount}`,
  );
  return {
    ok: true,
    code: buffered.addedCount ? "BUFFERED" : "NO_NEW_ATTACHMENT",
    addedCount: buffered.addedCount,
    ...summarizeStaged(buffered.staged),
  };
  });
}

async function assertLedgerReusable(store, entry, trust, config) {
  if (entry?.status === "submitted") {
    throw new OAClientError("This ticket was already submitted to OA", { code: "ALREADY_SUBMITTED" });
  }
  if (["submitting", "unknown"].includes(entry?.status)) {
    throw new OAClientError("This ticket requires OA reconciliation before retry", { code: "RECONCILIATION_REQUIRED" });
  }
  if (entry?.status !== "awaiting_confirmation") return;
  // pending 已过期或已被 Redis TTL 回收时，同一工单号必须还能重新 prepare，
  // 否则 cancel 也查不到 pending，这张单会永久卡在 ALREADY_PENDING。
  const pending = await getPending(store, entry.confirmationId);
  if (pending && Number(pending.expiresAt) > Date.now()) {
    // 同一条企微消息重复 prepare 会算出同一个内部幂等号，这里是最常走的拦截口。
    // 回执必须带 confirmationId / sameSession，否则模型既出不了确认卡也出不了拦截卡。
    throw new OAClientError("This ticket already has a pending OA confirmation", {
      code: "ALREADY_PENDING",
      details: alreadyPendingPayload(pendingConflictView(pending, trust, null), config),
    });
  }
}

function describePending(pending, now) {
  const state = String(pending?.submissionState || "").toLowerCase();
  if (state === "submitting" || state === "unknown") {
    return { code: "RECONCILIATION_REQUIRED" };
  }
  if (Number(pending?.expiresAt) <= now) {
    return { code: "CONFIRMATION_EXPIRED" };
  }
  return {
    code: "AWAITING_CONFIRMATION",
    expiresAt: isoExpiresAt(pending.expiresAt),
  };
}

/** status 带 confirmationId 且 pending 已不在时，把 ledger 小写状态收成工具约定码，才能带 hintZh。 */
function describeLedgerStatus(ledgerEntry) {
  const status = String(ledgerEntry?.status || "").toLowerCase();
  if (status === "expired" || status === "awaiting_confirmation") return "CONFIRMATION_EXPIRED";
  if (status === "unknown" || status === "submitting") return "RECONCILIATION_REQUIRED";
  if (status === "failed") return "OA_CREATE_REJECTED";
  if (status === "cancelled") return "CANCELLED";
  if (status === "submitted") return "ALREADY_SUBMITTED";
  return String(ledgerEntry?.status || "NOT_FOUND").toUpperCase();
}

/**
 * Redis TTL 只回收 pending，ledger 可能仍停在 awaiting_confirmation。
 * 看见这一跳就补写成 expired，status / submit / cancel 才不会一个待确认、一个找不到。
 */
async function expireOrphanAwaitingLedger(activeStore, ledgerEntry) {
  if (!ledgerEntry?.externalTicketId) return ledgerEntry;
  const current = await getLedger(activeStore, ledgerEntry.externalTicketId);
  if (!current || current.confirmationId !== ledgerEntry.confirmationId) return current || ledgerEntry;
  if (String(current.status || "").toLowerCase() !== "awaiting_confirmation") return current;
  const expired = ledgerRecord({
    status: "expired",
    confirmationId: current.confirmationId,
    identity: current.identity,
    session: current.session,
    externalTicketId: current.externalTicketId,
  });
  await commitTicketState(activeStore, { ledger: expired });
  return expired;
}

/** pending 已不在时，按同号 ledger 决定还能不能再 submit。 */
function submitOutcomeWhenPendingGone(ledgerEntry, trust) {
  if (!belongsToPerson(ledgerEntry, trust)) {
    return { ok: false, code: "NOT_FOUND" };
  }
  const status = String(ledgerEntry.status || "").toLowerCase();
  if (status === "submitted") {
    return {
      ok: true,
      code: "ALREADY_SUBMITTED",
      requestId: ledgerEntry.requestId || null,
      externalTicketId: ledgerEntry.externalTicketId || null,
    };
  }
  if (status === "unknown" || status === "submitting") {
    return { ok: false, code: "RECONCILIATION_REQUIRED" };
  }
  if (status === "failed") {
    return { ok: false, code: "OA_CREATE_REJECTED" };
  }
  if (status === "expired" || status === "awaiting_confirmation") {
    return {
      ok: false,
      code: "CONFIRMATION_EXPIRED",
      externalTicketId: ledgerEntry.externalTicketId || null,
    };
  }
  return { ok: false, code: "NOT_FOUND" };
}

function pendingRetentionFields(pending, trust, config) {
  return {
    expiresAt: isoExpiresAt(pending.expiresAt),
    retentionHours: config?.pendingTtlHours,
    sameSession: isSamePendingSession(pending, trust),
  };
}

async function ignoreStagingCleanup(task) {
  try {
    await task;
  } catch {
    // Staging GC must not fail prepare / status.
  }
}

const STAGING_GC_INTERVAL_MS = 60_000;
let lastStagingGcAt = 0;
const inflightSubmits = new Map();

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject, settled: false };
}

function settleInflight(confirmationId, deferred, payload, error) {
  if (!deferred || deferred.settled) return;
  deferred.settled = true;
  if (inflightSubmits.get(confirmationId) === deferred.promise) {
    inflightSubmits.delete(confirmationId);
  }
  if (error) deferred.reject(error);
  else deferred.resolve(payload);
}

function remapParallelSubmitLoser(payload) {
  if (payload?.code === "SUBMITTED") {
    return { ...payload, code: "ALREADY_SUBMITTED" };
  }
  return payload;
}

async function maybeCleanupExpiredStaging(activeStore, stateDir, now = Date.now()) {
  if (now - lastStagingGcAt < STAGING_GC_INTERVAL_MS) return;
  lastStagingGcAt = now;
  await ignoreStagingCleanup(cleanupExpiredStaging(activeStore, stateDir, now));
}

/** 确认窗口到期：删 pending / staging / inbox，ledger 记 expired，旧描述与附件不得再带进下一张单。 */
async function expirePendingInStore(activeStore, pending) {
  const current = await getPending(activeStore, pending.confirmationId);
  if (!current || Number(current.expiresAt) > Date.now()) return null;
  await commitTicketState(activeStore, {
    removePendingId: current.confirmationId,
    removeSessionRef: { identity: current.identity, session: current.session },
    ledger: ledgerRecord({
      status: "expired",
      confirmationId: current.confirmationId,
      identity: current.identity,
      session: current.session,
      externalTicketId: current.draft?.externalTicketId,
    }),
  });
  return current;
}

async function dropSessionInboxLocked(activeStore, stateDir, identity, session) {
  if (!identity || !session) return;
  await removeInbox(activeStore, identity, session);
  await ignoreStagingCleanup(removeInboxDirectory(stateDir, identity, session));
}

async function wipeExpiredPending({ activeStore, stateDir, pending, locked = false }) {
  if (!pending) return false;
  const run = async () => {
    const gone = await expirePendingInStore(activeStore, pending);
    if (gone) await dropSessionInboxLocked(activeStore, stateDir, pending.identity, pending.session);
    return gone;
  };
  const gone = locked ? await run() : await withStateLock(activeStore, run);
  await ignoreStagingCleanup(removeStagingDirectory(stateDir, pending.confirmationId));
  return Boolean(gone);
}

function belongsToPerson(record, trust) {
  return Boolean(record?.identity && record.identity === trust.identity);
}

async function readPersonStatus({ activeStore, trust, stateDir, config }) {
  const now = Date.now();
  let pendingId = await getPersonPendingId(activeStore, trust.identity);
  if (!pendingId) pendingId = await getSessionPendingId(activeStore, trust.identity, trust.session);
  let pendingView = null;
  if (pendingId) {
    const pending = await getPending(activeStore, pendingId);
    if (pending && belongsToPerson(pending, trust)) {
      if (Number(pending.expiresAt) <= now) {
        await wipeExpiredPending({ activeStore, stateDir, pending });
      } else {
        const described = describePending(pending, now);
        pendingView = {
          confirmationId: pending.confirmationId,
          code: described.code,
          ...pendingCardFields(pending),
          ...pendingRetentionFields(pending, trust, config),
        };
      }
    }
  }
  const recent = (await getPersonTickets(activeStore, trust.identity)).map((item) => ({
    confirmationId: item.confirmationId,
    status: item.status,
    requestId: item.requestId || null,
    updatedAt: item.updatedAt,
  }));
  const preview = submittedPreview(recent);
  // 问进度惯例不带 confirmationId。对账中的 pending 必须抬成顶层码，
  // 否则模型只看见 PERSON_STATUS + pending 就会发确认卡。
  if (pendingView?.code === "RECONCILIATION_REQUIRED") {
    return {
      ok: true,
      code: "RECONCILIATION_REQUIRED",
      confirmationId: pendingView.confirmationId,
      pending: pendingView,
      recent,
      ...preview,
    };
  }
  return {
    ok: true,
    code: "PERSON_STATUS",
    pending: pendingView,
    recent,
    ...preview,
  };
}

function ledgerRecord({ status, confirmationId, identity, session, externalTicketId, requestId, errorCode }) {
  const record = {
    status,
    confirmationId,
    identity,
    session,
    externalTicketId,
    updatedAt: new Date().toISOString(),
  };
  if (requestId) record.requestId = requestId;
  if (errorCode) record.errorCode = errorCode;
  return record;
}

export function createOAWorkflowToolFactory({ stateDir, stateStore, resolveStateStore, logger, dependencies = {} }) {
  const loadConfig = dependencies.loadConfig || loadBridgeConfig;
  const loadOptions = dependencies.loadOptions || loadSystemOptions;
  const loadTypeSystems = dependencies.loadTicketTypeSystems || loadTicketTypeSystems;
  const loadHandlers = dependencies.loadSystemHandlers || loadSystemHandlers;
  const resolveSecrets = dependencies.resolveSecrets || resolveProtectedValues;
  const clientFactory = dependencies.clientFactory || ((config) => getSharedOAClient({ config, resolveSecrets }));
  const lookupProfile = dependencies.lookupRequesterProfile || lookupRequesterProfile;
  const injectedAdapter = dependencies.identityAdapter || null;
  const resolveIdentityAdapter = dependencies.resolveIdentityAdapter || null;
  const removeSubmittedStaging = dependencies.removeStagingDirectory || removeStagingDirectory;

  async function store() {
    if (stateStore) return stateStore;
    if (resolveStateStore) return resolveStateStore();
    throw new OAClientError("OA bridge state store is not configured", { code: "REDIS_UNAVAILABLE" });
  }

  return (ctx) => ({
    name: "oa_workflow",
    label: "Aidy OA 工单流程",
    description: "准备一次性OA工单确认、把员工陆续发来的图片/文件并入当前工单、由同一企微提交人确认后发起唯一流程、查询该人当前待确认/已提交记录或取消待确认。企微 inbound 图片/文件按当前 OpenClaw 会话暂存，不必传入本地路径。查进度可不传 confirmationId：可确认的待确认返回 PERSON_STATUS；对账中（unknown/submitting）顶层返回 RECONCILIATION_REQUIRED，不要当成待确认。不支持按 OA 工单号查询具体进度。待确认默认保留 24 小时，未确认或取消则自动清除图片、文档和描述。跨会话只能确认或取消，不能补附件。不要传入工单号；内部幂等号由插件生成。不能传入URL、凭据、流程ID或OA字段名。回执 hintZh 是给员工看的短句：无对应确认卡/提交成功模板时原样输出，不要贴英文 message。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["prepare", "attach", "submit_confirmed", "status", "cancel"],
          description: "prepare 建待确认；attach 只收图片/文件；submit_confirmed 确认后建 OA；status 按人查当前待确认和最近已提交（条数+最多5条单号，不要按工单号查 OA 进度；对账中顶层是 RECONCILIATION_REQUIRED）；cancel 作废待确认。",
        },
        confirmationId: {
          type: "string",
          description: "内部确认号。员工确认/取消/补附件时传入；查进度不要传。禁止展示给员工。",
        },
        supplement: {
          type: "string",
          description: "确认提交时的一次性补充。改稿不要用这个字段，必须 cancel 再 prepare。",
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
            ticketType: { type: "string", enum: ["运维支持", "权限申请", "IT需求"], description: "工单类型。" },
            systemName: { type: "string", description: "所属系统，必须与当前类型允许清单完全一致。" },
            location: { type: "string", enum: ["智园", "大磡", "深汕", "越南", "光明", "泗洪"], description: "故障地点。仅电脑/打印机/网络问题传入；不要写进 summary 或 problemDescription。" },
            summary: { type: "string", description: "员工原话开头预览。短的原样；长的约 20 字加 ...。不要改写、不要写地点或长文。" },
            problemDescription: { type: "string", description: "只抄员工文字。短句短抄；长文或断续多轮按顺序合并。不要写地点、见图、未说明。确认卡不要贴这一段。" },
            impactScope: { type: "string", description: "可选。员工没说就不要传。" },
            occurredAt: { type: "string", description: "可选。员工没说就不要传。" },
            attemptedMeasures: { type: "string", description: "可选。员工没说就不要传。" },
            demandType: { type: "string", enum: ["流程新建", "流程优化", "数据处理", "集成对接"], description: "仅 IT 需求必填。" },
            monthlyHours: { type: "number", minimum: 0, description: "仅 IT 需求必填，月节约工时，≥0。" },
          },
          required: ["ticketType", "systemName", "summary", "problemDescription"],
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId, params) {
      let submitDeferred;
      try {
        const activeStore = await store();
        const trust = requireTrustedContext(ctx);
        const config = await loadConfig();
        const now = Date.now();
        if (params.action === "prepare") {
          const draft = normalizeDraft({
            ...(params.draft || {}),
            externalTicketId: allocateExternalTicketId(ctx, now),
          }, await loadOptions(), await loadTypeSystems(), await loadHandlers());
          await assertLedgerReusable(activeStore, await getLedger(activeStore, draft.externalTicketId), trust, config);
          const conflict = await findPersonPendingConflict(activeStore, trust, draft.externalTicketId);
          if (conflict?.expired) {
            await wipeExpiredPending({ activeStore, stateDir, pending: conflict.expired });
          } else if (conflict) {
            return textResult(alreadyPendingPayload(conflict, config));
          }
          const adapter = injectedAdapter
            || (resolveIdentityAdapter ? await resolveIdentityAdapter(activeStore, config) : null);
          const oaRequesterId = await getMappedOaUserId({
            identity: trust.identity,
            senderId: ctx.requesterSenderId,
            config,
            adapter,
          });
          if (!oaRequesterId) {
            return textResult({
              ok: false,
              code: (config.identity?.adapter || "on") === "on" ? "OA_IDENTITY_NOT_FOUND" : "OA_IDENTITY_MAPPING_REQUIRED",
              message: "The verified WeCom sender is not mapped to an OA resource ID.",
            });
          }
          const confirmationId = newConfirmationId();
          const expiresAt = now + config.pendingTtlHours * 60 * 60 * 1000;
          let staged;
          let committed = false;
          // inbox 快照、adopt、commit、清空 inbox 必须同处一个临界区：attach 全程持锁写同一条 inbox key，
          // 快照之后落进来的那一份不会进本单的 staged，却会被收尾的 removeInbox 整份删掉，附件就永久丢了。
          try {
            await withStateLock(activeStore, async () => {
              await dropRotatedInbox(activeStore, stateDir, trust);
              const inbox = await getInbox(activeStore, trust.identity, trust.session);
              const inboxItems = Array.isArray(inbox?.items) ? inbox.items : [];
              const bufferedKeys = new Set();
              for (const item of inboxItems) {
                for (const key of attachmentIdentityKeys(item.sourcePath, item.fileName)) bufferedKeys.add(key);
              }
              const attachments = collectPrepareAttachments(ctx, params.attachments, stateDir)
                .filter((item) => !attachmentIdentityKeys(item.localPath, item.fileName).some((key) => bufferedKeys.has(key)));
              logger?.info?.(
                `[oa-workflow-bridge-redis] prepare collecting ${inboxItems.length} buffered + ${attachments.length} inbound attachment(s): ${maskFileNames(attachments)}`,
              );
              const adopted = await adoptStagedFiles({
                stateDir,
                fromDirName: inboxDirName(trust.identity, trust.session),
                toDirName: confirmationId,
                items: inboxItems,
                config,
              });
              staged = [...adopted, ...await stageAttachments({
                stateDir,
                confirmationId,
                attachments,
                config,
                startIndex: adopted.length,
                existingBytes: stagedBytes(adopted),
              })];
              await assertLedgerReusable(activeStore, await getLedger(activeStore, draft.externalTicketId), trust, config);
              const lockedConflict = await findPersonPendingConflict(activeStore, trust, draft.externalTicketId);
              if (lockedConflict?.expired) {
                await wipeExpiredPending({ activeStore, stateDir, pending: lockedConflict.expired, locked: true });
              } else if (lockedConflict) {
                // 仍然 throw：外层 catch 要先删掉本次已暂存的 staging 目录，再把回执交给 safeError。
                throw new OAClientError("This sender already has a pending OA confirmation", {
                  code: "ALREADY_PENDING",
                  details: alreadyPendingPayload(lockedConflict, config),
                });
              }
              await commitTicketState(activeStore, {
                pending: {
                  confirmationId,
                  identity: trust.identity,
                  session: trust.session,
                  oaRequesterId,
                  draft,
                  staged,
                  createdAt: new Date(now).toISOString(),
                  expiresAt,
                },
                ledger: ledgerRecord({
                  status: "awaiting_confirmation",
                  confirmationId,
                  identity: trust.identity,
                  session: trust.session,
                  externalTicketId: draft.externalTicketId,
                }),
              });
              committed = true;
              rememberStagedPathsFor(ctx, [
                ...attachments,
                ...inboxItems.filter((item) => item.sourcePath).map((item) => ({ localPath: item.sourcePath })),
              ]);
              if (attachments.length) consumeInboundMediaFor(ctx);
              if (inboxItems.length) {
                try {
                  await dropSessionInboxLocked(activeStore, stateDir, trust.identity, trust.session);
                } catch (cleanupError) {
                  logger?.warn?.(
                    `[oa-workflow-bridge-redis] pending committed but inbox cleanup failed: ${cleanupError?.message || cleanupError}`,
                  );
                }
              }
            });
          } catch (error) {
            if (!committed) await ignoreStagingCleanup(removeStagingDirectory(stateDir, confirmationId));
            throw error;
          }
          logger?.info?.(`[oa-workflow-bridge-redis] prepare staged ${staged.length} attachment(s)`);
          await maybeCleanupExpiredStaging(activeStore, stateDir, now);
          return textResult({
            ok: true,
            code: "AWAITING_CONFIRMATION",
            confirmationId,
            expiresAt: new Date(expiresAt).toISOString(),
            retentionHours: config.pendingTtlHours,
            sameSession: true,
            location: draft.location || null,
            summary: {
              externalTicketId: draft.externalTicketId,
              ticketType: draft.ticketType,
              systemName: draft.systemName,
              location: draft.location || null,
              problemSummary: draft.summary,
              ...summarizeStaged(staged),
            },
          });
        }

        if (params.action === "attach") {
          const attached = await attachInbound({
            activeStore,
            config,
            ctx,
            stateDir,
            trust,
            confirmationId: params.confirmationId,
            paramsAttachments: params.attachments,
            now,
            logger,
          });
          await maybeCleanupExpiredStaging(activeStore, stateDir, now);
          return textResult(attached);
        }

        if (params.action === "status") {
          if (!params.confirmationId || typeof params.confirmationId !== "string") {
            const personStatus = await readPersonStatus({ activeStore, trust, stateDir, config });
            await maybeCleanupExpiredStaging(activeStore, stateDir, now);
            return textResult(personStatus);
          }
          const pending = await getPending(activeStore, params.confirmationId);
          if (pending && belongsToPerson(pending, trust)) {
            if (Number(pending.expiresAt) <= Date.now()) {
              await wipeExpiredPending({ activeStore, stateDir, pending });
              await maybeCleanupExpiredStaging(activeStore, stateDir, now);
              return textResult({
                ok: true,
                code: "CONFIRMATION_EXPIRED",
                confirmationId: pending.confirmationId,
                externalTicketId: pending.draft?.externalTicketId || null,
              });
            }
            const described = describePending(pending, Date.now());
            await maybeCleanupExpiredStaging(activeStore, stateDir, now);
            return textResult({
              ok: true,
              code: described.code,
              confirmationId: pending.confirmationId,
              expiresAt: described.expiresAt || isoExpiresAt(pending.expiresAt),
              externalTicketId: pending.draft?.externalTicketId || null,
              ...pendingCardFields(pending),
              ...pendingRetentionFields(pending, trust, config),
            });
          }
          const ledgerEntry = await getLedgerByConfirmation(activeStore, params.confirmationId);
          if (belongsToPerson(ledgerEntry, trust)) {
            const reconciled = await withStateLock(activeStore, () => expireOrphanAwaitingLedger(activeStore, ledgerEntry));
            await ignoreStagingCleanup(removeStagingDirectory(stateDir, params.confirmationId));
            await maybeCleanupExpiredStaging(activeStore, stateDir, Date.now());
            return textResult({
              ok: true,
              code: describeLedgerStatus(reconciled),
              requestId: reconciled.requestId || null,
              externalTicketId: reconciled.externalTicketId || null,
            });
          }
          return textResult({ ok: false, code: "NOT_FOUND" });
        }

        if (!params.confirmationId || typeof params.confirmationId !== "string") {
          throw new OAClientError("confirmationId is required", { code: "MISSING_CONFIRMATION_ID" });
        }

        if (params.action === "cancel") {
          let removed = null;
          await withStateLock(activeStore, async () => {
            const pending = await getPending(activeStore, params.confirmationId);
            if (!pending || !belongsToPerson(pending, trust)) {
              const ledgerEntry = await getLedgerByConfirmation(activeStore, params.confirmationId);
              if (belongsToPerson(ledgerEntry, trust)) {
                const reconciled = await expireOrphanAwaitingLedger(activeStore, ledgerEntry);
                if (describeLedgerStatus(reconciled) === "CONFIRMATION_EXPIRED") {
                  await ignoreStagingCleanup(removeStagingDirectory(stateDir, params.confirmationId));
                  throw new OAClientError("OA confirmation expired", { code: "CONFIRMATION_EXPIRED" });
                }
              }
              throw new OAClientError("Pending OA confirmation was not found", { code: "NOT_FOUND" });
            }
            if (pending.expiresAt <= Date.now()) {
              await wipeExpiredPending({ activeStore, stateDir, pending, locked: true });
              throw new OAClientError("OA confirmation expired", { code: "CONFIRMATION_EXPIRED" });
            }
            if (["submitting", "unknown"].includes(pending.submissionState)) {
              throw new OAClientError("This ticket requires OA reconciliation before it can be cancelled", { code: "RECONCILIATION_REQUIRED" });
            }
            removed = pending;
            await commitTicketState(activeStore, {
              removePendingId: params.confirmationId,
              removeSessionRef: { identity: pending.identity, session: pending.session },
              ledger: ledgerRecord({
                status: "cancelled",
                confirmationId: params.confirmationId,
                identity: pending.identity,
                session: pending.session,
                externalTicketId: pending.draft.externalTicketId,
              }),
            });
            await dropSessionInboxLocked(activeStore, stateDir, pending.identity, pending.session);
          });
          await removeStagingDirectory(stateDir, params.confirmationId);
          // 仅同一 OpenClaw 会话的改稿需要回灌附件；`/new` 后的明确取消不得把旧图灌进新对话。
          if (removed.session === trust.session) {
            restoreStagedSources(ctx, removed.staged);
          }
          await maybeCleanupExpiredStaging(activeStore, stateDir, Date.now());
          return textResult({
            ok: true,
            code: "CANCELLED",
            externalTicketId: removed.draft.externalTicketId,
            ...pendingCardFields(removed),
          });
        }

        if (params.action !== "submit_confirmed") {
          throw new OAClientError("Unsupported OA workflow action", { code: "VALIDATION_ERROR" });
        }
        const supplement = sanitizeSupplement(params.supplement);
        let pending;
        let alreadySubmitted;
        let waitInflight = false;
        await withStateLock(activeStore, async () => {
          pending = await getPending(activeStore, params.confirmationId);
          if (!pending) {
            alreadySubmitted = await getLedgerByConfirmation(activeStore, params.confirmationId);
            alreadySubmitted = await expireOrphanAwaitingLedger(activeStore, alreadySubmitted);
            return;
          }
          if (pending.identity !== trust.identity) {
            throw new OAClientError("Only the original WeCom sender can confirm this OA request", { code: "SENDER_MISMATCH" });
          }
          if (pending.expiresAt <= Date.now()) {
            await wipeExpiredPending({ activeStore, stateDir, pending, locked: true });
            throw new OAClientError("OA confirmation expired", { code: "CONFIRMATION_EXPIRED" });
          }
          if (pending.submissionState === "submitting") {
            waitInflight = true;
            return;
          }
          if (pending.submissionState === "unknown") {
            throw new OAClientError("This ticket requires OA reconciliation before retry", { code: "RECONCILIATION_REQUIRED" });
          }
          if (!config.active) {
            return;
          }
          // 新会话只能确认已暂存资料，不能把本会话新图并进上一会话的待确认单。
          const sameSession = isSamePendingSession(pending, trust);
          const extraAttachments = sameSession
            ? collectSubmitAttachments(ctx, params.attachments, stateDir)
            : [];
          const extraStaged = extraAttachments.length ? await stageAttachments({
            stateDir,
            confirmationId: params.confirmationId,
            attachments: extraAttachments,
            config,
            startIndex: pending.staged.length,
            existingBytes: stagedBytes(pending.staged),
          }) : [];
          if (extraStaged.length) pending.staged = [...pending.staged, ...extraStaged];
          const deferred = createDeferred();
          deferred.promise.catch(() => {});
          inflightSubmits.set(params.confirmationId, deferred.promise);
          submitDeferred = deferred;
          pending.submissionState = "submitting";
          try {
            await commitTicketState(activeStore, {
              pending,
              ledger: ledgerRecord({
                status: "submitting",
                confirmationId: params.confirmationId,
                identity: pending.identity,
                session: pending.session,
                externalTicketId: pending.draft.externalTicketId,
              }),
            });
          } catch (error) {
            settleInflight(params.confirmationId, submitDeferred, null, error);
            submitDeferred = null;
            throw error;
          }
          // 跨会话确认不清当前会话 inbound：B 里的新图留给处理完旧单后的新单。
          if (sameSession && extraStaged.length) {
            rememberStagedPathsFor(ctx, extraAttachments, { merge: true });
            consumeInboundMediaFor(ctx);
          }
        });
        if (waitInflight) {
          const inflight = inflightSubmits.get(params.confirmationId);
          if (inflight) {
            try {
              return textResult(remapParallelSubmitLoser(await inflight));
            } catch (error) {
              return safeError(error);
            }
          }
          const ledgerEntry = await expireOrphanAwaitingLedger(
            activeStore,
            await getLedgerByConfirmation(activeStore, params.confirmationId),
          );
          return textResult(submitOutcomeWhenPendingGone(ledgerEntry, trust));
        }
        if (!pending) {
          const outcome = submitOutcomeWhenPendingGone(alreadySubmitted, trust);
          if (outcome.code === "CONFIRMATION_EXPIRED") {
            await ignoreStagingCleanup(removeStagingDirectory(stateDir, params.confirmationId));
            await maybeCleanupExpiredStaging(activeStore, stateDir, Date.now());
          }
          return textResult(outcome);
        }
        if (!config.active) {
          return textResult({ ok: false, code: "OA_BRIDGE_INACTIVE", message: "OA live submission is not enabled." });
        }

        let payload;
        let attachmentSummary = summarizeStaged(pending.staged);
        const client = clientFactory(config);
        const prepareStarted = Date.now();
        try {
          const [encoded, profile, handlers] = await Promise.all([
            encodeStagedAttachments({
              stateDir,
              confirmationId: params.confirmationId,
              staged: pending.staged,
            }),
            lookupProfile({
              oaUserId: pending.oaRequesterId,
              client,
            }),
            loadHandlers(),
          ]);
          logger?.info?.(
            `[oa-workflow-bridge-redis] submit_confirmed encode+profile elapsedMs=${Date.now() - prepareStarted} images=${encoded.images.length} documents=${encoded.documents.length}`,
          );
          attachmentSummary = {
            attachmentCount: encoded.images.length + encoded.documents.length,
            imageCount: encoded.images.length,
            documentCount: encoded.documents.length,
          };
          payload = buildCreatePayload({
            config,
            draft: pending.draft,
            oaRequesterId: pending.oaRequesterId,
            profile,
            attachments: encoded.documents,
            images: encoded.images,
            supplement,
            handlers,
          });
        } catch (error) {
          await withStateLock(activeStore, async () => {
            const current = await getPending(activeStore, params.confirmationId);
            if (!current) return;
            current.submissionState = null;
            await commitTicketState(activeStore, {
              pending: current,
              ledger: ledgerRecord({
                status: "awaiting_confirmation",
                confirmationId: params.confirmationId,
                identity: pending.identity,
                session: pending.session,
                externalTicketId: pending.draft.externalTicketId,
              }),
            });
          });
          throw error;
        }

        let created;
        try {
          const createStarted = Date.now();
          created = await client.createRequest(payload, { requesterUserId: pending.oaRequesterId });
          logger?.info?.(
            `[oa-workflow-bridge-redis] submit_confirmed doCreateRequest elapsedMs=${Date.now() - createStarted} requestId=${created.requestId}`,
          );
        } catch (error) {
          logger?.warn?.(`[oa-workflow-bridge-redis] OA submission failed with safe code ${error?.code || "UNKNOWN"}`);
          const ambiguous = Boolean(error?.ambiguous);
          await withStateLock(activeStore, async () => {
            const current = await getPending(activeStore, params.confirmationId);
            if (ambiguous) {
              if (current) current.submissionState = "unknown";
              await commitTicketState(activeStore, {
                pending: current || undefined,
                ledger: ledgerRecord({
                  status: "unknown",
                  confirmationId: params.confirmationId,
                  identity: pending.identity,
                  session: pending.session,
                  externalTicketId: pending.draft.externalTicketId,
                  errorCode: error?.code || "OA_ERROR",
                }),
              });
              return;
            }
            await commitTicketState(activeStore, {
              removePendingId: params.confirmationId,
              removeSessionRef: { identity: pending.identity, session: pending.session },
              ledger: ledgerRecord({
                status: "failed",
                confirmationId: params.confirmationId,
                identity: pending.identity,
                session: pending.session,
                externalTicketId: pending.draft.externalTicketId,
                errorCode: error?.code || "OA_ERROR",
              }),
            });
          });
          if (!ambiguous) {
            await ignoreStagingCleanup(removeStagingDirectory(stateDir, params.confirmationId));
            await maybeCleanupExpiredStaging(activeStore, stateDir, Date.now());
          }
          throw error;
        }

        try {
          await withStateLock(activeStore, async () => {
            await commitTicketState(activeStore, {
              removePendingId: params.confirmationId,
              removeSessionRef: { identity: pending.identity, session: pending.session },
              ledger: ledgerRecord({
                status: "submitted",
                confirmationId: params.confirmationId,
                identity: pending.identity,
                session: pending.session,
                externalTicketId: pending.draft.externalTicketId,
                requestId: created.requestId,
              }),
            });
          });
        } catch (error) {
          logger?.warn?.(
            `[oa-workflow-bridge-redis] OA created requestId=${created.requestId} but local persist failed: ${error?.message || error}`,
          );
          try {
            await withStateLock(activeStore, async () => {
              const current = await getPending(activeStore, params.confirmationId);
              if (current) current.submissionState = "unknown";
              await commitTicketState(activeStore, {
                pending: current || undefined,
                ledger: ledgerRecord({
                  status: "unknown",
                  confirmationId: params.confirmationId,
                  identity: pending.identity,
                  session: pending.session,
                  externalTicketId: pending.draft.externalTicketId,
                  requestId: created.requestId,
                  errorCode: "REDIS_UNAVAILABLE",
                }),
              });
            });
          } catch (persistError) {
            logger?.warn?.(
              `[oa-workflow-bridge-redis] failed to mark unknown after OA success requestId=${created.requestId}: ${persistError?.message || persistError}`,
            );
          }
          const reconcilePayload = {
            ok: false,
            code: "RECONCILIATION_REQUIRED",
            requestId: created.requestId,
            externalTicketId: pending.draft.externalTicketId,
            summary: pending.draft?.summary || null,
            location: pendingFaultLocation(pending) || null,
            ...attachmentSummary,
          };
          settleInflight(params.confirmationId, submitDeferred, reconcilePayload);
          return textResult(reconcilePayload);
        }

        await ignoreStagingCleanup(removeSubmittedStaging(stateDir, params.confirmationId));
        await maybeCleanupExpiredStaging(activeStore, stateDir, Date.now());
        const submittedPayload = {
          ok: true,
          code: "SUBMITTED",
          requestId: created.requestId,
          externalTicketId: pending.draft.externalTicketId,
          summary: pending.draft?.summary || null,
          location: pendingFaultLocation(pending) || null,
          ...attachmentSummary,
        };
        settleInflight(params.confirmationId, submitDeferred, submittedPayload);
        return textResult(submittedPayload);
      } catch (error) {
        settleInflight(params.confirmationId, submitDeferred, null, error);
        logger?.warn?.(`[oa-workflow-bridge-redis] ${params?.action || "oa_workflow"} failed: ${error?.message || error}`);
        return safeError(error);
      }
    },
  });
}
