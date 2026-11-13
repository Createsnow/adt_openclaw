import { summarizeStaged } from "../attachments.mjs";
import { captureInbound, takeInboxNotices } from "../inbox.mjs";
import { collectToolMedia } from "../inbound-media.mjs";
import { pendingFaultLocation } from "../mapping.mjs";
import { OAClientError } from "../oa-client.mjs";
import { cleanupExpired } from "../store.mjs";

export function fail(code, message, details = null) {
  throw new OAClientError(message, { code, details });
}

export function isoExpiresAt(expiresAt) {
  const ms = Number(expiresAt);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function isExpired(ticket, now = Date.now()) {
  return Number(ticket?.expiresAt) <= now;
}

export function belongsTo(ticket, trust) {
  return Boolean(ticket?.identity && ticket.identity === trust.identity);
}

/** 工单是不是在当前这个对话里建的（会话码可能是 sessionId 或 sessionKey 算出来的）。 */
export function isSameSession(ticket, trust) {
  return Boolean(ticket?.session && (trust?.sessions || [trust?.session]).includes(ticket.session));
}

/** 回执里回显给员工的问题预览、地点、附件计数。 */
export function cardFields(ticket) {
  return {
    summary: ticket?.draft?.summary || null,
    location: pendingFaultLocation(ticket) || null,
    ...summarizeStaged(ticket?.staged || []),
  };
}

export function retentionFields(ticket, trust, config) {
  return {
    expiresAt: isoExpiresAt(ticket.expiresAt),
    retentionHours: config?.pendingTtlHours,
    sameSession: isSameSession(ticket, trust),
  };
}

export function handlerNamesOf(ticket) {
  return ticket?.draft?.handlerNames || "";
}

/** 仍占名额的单对外的码：提交中 / 待对账一律 RECONCILIATION_REQUIRED。 */
export function activeTicketCode(ticket) {
  return ticket.status === "awaiting_confirmation" ? "AWAITING_CONFIRMATION" : "RECONCILIATION_REQUIRED";
}

/** 已结束的单对外的码。 */
export function closedTicketCode(ticket) {
  switch (ticket?.status) {
    case "expired": return "CONFIRMATION_EXPIRED";
    case "failed": return "OA_CREATE_REJECTED";
    case "cancelled": return "CANCELLED";
    case "submitted": return "ALREADY_SUBMITTED";
    default: return "NOT_FOUND";
  }
}

/** 收下本轮工具 ctx 里的附件进 inbox，并取出待报提示。调用方持锁。 */
export async function captureToolMedia({ store, stateDir, config, ctx, trust, params }) {
  const captured = await captureInbound({
    store,
    stateDir,
    config,
    source: ctx,
    attachments: collectToolMedia(ctx, params?.attachments, stateDir),
  });
  const inbox = captured?.inbox || { sessions: trust.sessions, items: [], seen: [], rejected: 0, expiredNotice: false };
  const notices = await takeInboxNotices(store, trust.identity, captured?.inbox, config);
  return { inbox, notices };
}

export async function ignoreErrors(task) {
  try {
    await task;
  } catch {
    // 清理失败不影响主流程回执。
  }
}

const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanupAt = 0;

/** 工具调用后顺带做一次到期回收，最多每分钟一次。 */
export async function maybeCleanup(store, stateDir, now = Date.now()) {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  await ignoreErrors(cleanupExpired(store, stateDir, now));
}
