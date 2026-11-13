import { summarizeStaged } from "../attachments.mjs";
import { pendingFaultLocation } from "../mapping.mjs";
import { OAClientError } from "../oa-client.mjs";
import { cleanupExpired, getActiveTicket, wipePersonInbox, getInboxSession } from "../store.mjs";

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

export function isSameSession(ticket, trust) {
  return Boolean(ticket?.session && trust?.session && ticket.session === trust.session);
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

/**
 * 同一提交人全局只允许一张待确认单（跨 `/new`、私聊 / 群聊仍拦住）。
 * 返回 null（无冲突）、`{ expired }`（占名额的单已到期，调用方先过期它）或冲突视图。
 */
export function conflictView(existing, trust, externalTicketId) {
  if (!existing) return null;
  if (isExpired(existing)) return { expired: existing };
  if (externalTicketId && existing.externalTicketId === externalTicketId) return null;
  return {
    confirmationId: existing.confirmationId,
    externalTicketId: existing.externalTicketId || null,
    expiresAt: existing.expiresAt,
    sameSession: isSameSession(existing, trust),
    ...cardFields(existing),
  };
}

export async function personConflict(store, trust, externalTicketId) {
  return conflictView(await getActiveTicket(store, trust.identity), trust, externalTicketId);
}

export function alreadyPendingPayload(conflict, config) {
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

/** 会话已换（`/new`、空闲新会话）时丢掉上一会话尚未 prepare 的 inbox，避免旧图进新单。调用方持锁。 */
export async function dropRotatedInbox(store, stateDir, trust) {
  const pointed = await getInboxSession(store, trust.identity);
  if (pointed && pointed !== trust.session) {
    await wipePersonInbox(store, stateDir, trust.identity, pointed);
  }
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
