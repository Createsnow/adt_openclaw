import { randomBytes } from "node:crypto";
import { limitExceeded, MAX_STAGED_ATTACHMENTS, moveStagedFiles, stagedBytes, summarizeStaged } from "../attachments.mjs";
import { clearInboxItems, moveInboxToTicket } from "../inbox.mjs";
import { hintZhFor } from "../hints.mjs";
import { maskFileNames } from "../log-redact.mjs";
import { allocateExternalTicketId, normalizeDraft } from "../mapping.mjs";
import { OAClientError } from "../oa-client.mjs";
import { confirmCard, INBOX_EXPIRED, reconcileCard, replacedOtherPrefix } from "../reply.mjs";
import {
  expireTicket,
  getActiveTicket,
  getLatestTicketByExternalId,
  insertTicket,
  removeStagingDirectory,
  updateTicket,
  withStateLock,
} from "../store.mjs";
import { captureToolMedia, fail, handlerNamesOf, ignoreErrors, isExpired, isSameSession, maybeCleanup } from "./common.mjs";
import { submitConfirmed } from "./submit.mjs";

function newConfirmationId() {
  return `OA-${Date.now().toString(36).toUpperCase()}-${randomBytes(8).toString("hex").toUpperCase()}`;
}

/** 同一内部幂等号已提交、或在提交中 / 待对账，不能再 prepare。仍在待确认的会被新单替换。 */
async function assertExternalIdReusable(store, externalTicketId) {
  const ticket = await getLatestTicketByExternalId(store, externalTicketId);
  if (ticket?.status === "submitted") fail("ALREADY_SUBMITTED", "This ticket was already submitted to OA");
  if (ticket?.status === "submitting" || ticket?.status === "unknown") {
    fail("RECONCILIATION_REQUIRED", "This ticket requires OA reconciliation before retry");
  }
}

function reconcilePayload(ticket) {
  return {
    ok: false,
    code: "RECONCILIATION_REQUIRED",
    confirmationId: ticket.confirmationId,
    replyZh: reconcileCard({ requestId: ticket.requestId, handlerNames: handlerNamesOf(ticket) }),
  };
}

function identityAdapterOn(config) {
  return (config.identity?.adapter || "on") === "on";
}

async function resolveOaRequesterId({ store, config, ctx, deps }) {
  if (!identityAdapterOn(config)) return "";
  const adapter = await deps.identityAdapter(store, config);
  if (!adapter?.resolve) return "";
  try {
    const result = await adapter.resolve(ctx.requesterSenderId);
    return /^\d{1,18}$/.test(String(result?.oaUserId || "")) ? String(result.oaUserId) : "";
  } catch (error) {
    if (error instanceof OAClientError) throw error;
    throw new OAClientError(error?.message || "OA identity lookup failed", {
      code: error?.code || "OA_IDENTITY_LOOKUP_FAILED",
    });
  }
}

/**
 * prepare：生成一张待确认单。
 * - 此人已有待确认单：作废它，由新单替换。同一对话里是改稿（旧单附件带到新单）；
 *   另一个对话里是报新问题（旧单附件随旧单清掉）。提交中 / 待对账的单仍挡住。
 * - 本轮与 inbox 里的附件全部认领进新单。
 * - `submitNow`：员工原话已要求直接提交，建单后立刻提交，回执是提交结果。
 */
export async function prepare(env) {
  const { store, stateDir, config, ctx, trust, params, logger, deps } = env;
  const now = Date.now();
  const draft = normalizeDraft({
    ...(params.draft || {}),
    externalTicketId: allocateExternalTicketId(ctx, now),
  }, await deps.loadSystems());
  await assertExternalIdReusable(store, draft.externalTicketId);
  // 先拦对账中的单再查身份：被拦下的员工不必打企微 / 人事接口。
  const blocking = await getActiveTicket(store, trust.identity);
  if (blocking && !isExpired(blocking) && blocking.status !== "awaiting_confirmation") return reconcilePayload(blocking);

  const oaRequesterId = await resolveOaRequesterId({ store, config, ctx, deps });
  if (!oaRequesterId) {
    return {
      ok: false,
      code: identityAdapterOn(config) ? "OA_IDENTITY_NOT_FOUND" : "OA_IDENTITY_MAPPING_REQUIRED",
      message: "The verified WeCom sender is not mapped to an OA resource ID.",
    };
  }

  const confirmationId = newConfirmationId();
  const expiresAt = now + config.pendingTtlHours * 60 * 60 * 1000;
  let staged = [];
  let replaced = null;
  let expiredNotice = false;
  let committed = false;
  try {
    await withStateLock(store, async () => {
      const { inbox, notices } = await captureToolMedia(env);
      expiredNotice = notices.expired;
      if (notices.rejected) throw limitExceeded();

      let previous = await getActiveTicket(store, trust.identity);
      if (previous && isExpired(previous)) {
        await expireTicket(store, stateDir, previous);
        previous = null;
      }
      if (previous && previous.status !== "awaiting_confirmation") {
        fail("RECONCILIATION_REQUIRED", "This ticket requires OA reconciliation before retry");
      }
      const carry = previous && isSameSession(previous, trust) ? previous.staged : [];
      // 先算上限再动任何东西：超限时旧单、inbox 都保持原样。
      if (carry.length + inbox.items.length > MAX_STAGED_ATTACHMENTS
        || stagedBytes(carry) + stagedBytes(inbox.items) > config.maxTotalAttachmentBytes) {
        throw limitExceeded();
      }
      logger?.info?.(
        `[oa-workflow-bridge] prepare carry=${carry.length} inbox=${inbox.items.length}: ${maskFileNames(inbox.items)}`,
      );
      if (previous) {
        staged = await moveStagedFiles(stateDir, previous.confirmationId, confirmationId, carry);
        await updateTicket(store, previous.confirmationId, { status: "cancelled" });
        await ignoreErrors(removeStagingDirectory(stateDir, previous.confirmationId));
        replaced = {
          summary: previous.draft?.summary,
          sameSession: isSameSession(previous, trust),
          sameMessage: previous.externalTicketId === draft.externalTicketId,
        };
      }
      const adopted = await moveInboxToTicket({ store, stateDir, config, identity: trust.identity, inbox, confirmationId, staged });
      staged = [...staged, ...adopted];
      await insertTicket(store, { confirmationId, identity: trust.identity, session: trust.session, oaRequesterId, draft, staged, expiresAt });
      committed = true;
      try {
        await clearInboxItems(store, trust.identity, inbox, config);
      } catch (cleanupError) {
        logger?.warn?.(`[oa-workflow-bridge] ticket saved but inbox cleanup failed: ${cleanupError?.message || cleanupError}`);
      }
    });
  } catch (error) {
    if (!committed) await ignoreErrors(removeStagingDirectory(stateDir, confirmationId));
    throw error;
  }
  logger?.info?.(`[oa-workflow-bridge] prepare staged ${staged.length} attachment(s)${replaced ? " (replaced previous)" : ""}`);
  await maybeCleanup(store, stateDir, now);

  const card = { summary: draft.summary, location: draft.location, ...summarizeStaged(staged) };
  let prefix = "";
  if (replaced && !replaced.sameMessage) {
    prefix = replaced.sameSession ? "📝 已补充描述\n\n" : replacedOtherPrefix(replaced.summary);
  }
  const expiredLine = expiredNotice ? `${INBOX_EXPIRED}\n\n` : "";

  if (params.submitNow) {
    const submitted = await submitConfirmed({ ...env, params: { action: "submit_confirmed", confirmationId } });
    const otherPrefix = replaced && !replaced.sameSession && !replaced.sameMessage ? prefix : "";
    return { ...submitted, replyZh: `${expiredLine}${otherPrefix}${submitted.replyZh || hintZhFor(submitted)}` };
  }
  return {
    ok: true,
    code: "AWAITING_CONFIRMATION",
    confirmationId,
    expiresAt: new Date(expiresAt).toISOString(),
    retentionHours: config.pendingTtlHours,
    sameSession: true,
    location: draft.location || null,
    replacedPrevious: Boolean(replaced && !replaced.sameMessage),
    summary: {
      externalTicketId: draft.externalTicketId,
      ticketType: draft.ticketType,
      systemName: draft.systemName,
      location: draft.location || null,
      problemSummary: draft.summary,
      ...summarizeStaged(staged),
    },
    replyZh: `${expiredLine}${prefix}${confirmCard(card)}`,
  };
}
