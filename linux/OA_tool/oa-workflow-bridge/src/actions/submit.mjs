import { encodeStagedAttachments, limitExceeded } from "../attachments.mjs";
import { moveInboxToTicket } from "../inbox.mjs";
import { buildCreatePayload, pendingFaultLocation, sanitizeSupplement } from "../mapping.mjs";
import { inactiveCard, reconcileCard, submittedCard } from "../reply.mjs";
import { expireTicket, getTicket, isActiveTicket, removeStagingDirectory, updateTicket, withStateLock } from "../store.mjs";
import { belongsTo, captureToolMedia, fail, handlerNamesOf, ignoreErrors, isExpired, isSameSession, maybeCleanup } from "./common.mjs";

/** 同进程里正在提交的确认单：并发的第二次确认等第一次的结果，不再打 OA。 */
const inflightSubmits = new Map();

/** 确认单已不在待确认状态时，按记录决定回执。 */
function outcomeForClosedTicket(ticket, trust) {
  if (!belongsTo(ticket, trust)) return { ok: false, code: "NOT_FOUND" };
  switch (ticket.status) {
    case "submitted":
      return { ok: true, code: "ALREADY_SUBMITTED", requestId: ticket.requestId || null, externalTicketId: ticket.externalTicketId || null };
    case "submitting":
    case "unknown":
      return { ok: false, code: "RECONCILIATION_REQUIRED" };
    case "failed":
      return { ok: false, code: "OA_CREATE_REJECTED" };
    case "expired":
      return { ok: false, code: "CONFIRMATION_EXPIRED", externalTicketId: ticket.externalTicketId || null };
    default:
      return { ok: false, code: "NOT_FOUND" };
  }
}

/** 锁内校验并把单标成 submitting。返回 `{ ticket }`（可以提交）或 `{ outcome }` / `{ waitInflight }`。 */
async function claimForSubmit(env) {
  const { store, stateDir, config, trust, params } = env;
  const { confirmationId } = params;
  return withStateLock(store, async () => {
    const ticket = await getTicket(store, confirmationId);
    if (!isActiveTicket(ticket)) return { outcome: ticket };
    if (ticket.identity !== trust.identity) {
      fail("SENDER_MISMATCH", "Only the original WeCom sender can confirm this OA request");
    }
    if (isExpired(ticket)) {
      await expireTicket(store, stateDir, ticket);
      fail("CONFIRMATION_EXPIRED", "OA confirmation expired");
    }
    if (ticket.status === "submitting") return { waitInflight: true };
    if (ticket.status === "unknown") fail("RECONCILIATION_REQUIRED", "This ticket requires OA reconciliation before retry");
    if (!config.active) return { inactive: ticket };
    // 同一对话里确认时随消息发来的新图并入；另一个对话里确认只提交旧单已有的附件。
    if (isSameSession(ticket, trust)) {
      const { inbox, notices } = await captureToolMedia(env);
      if (notices.rejected) throw limitExceeded();
      const moved = await moveInboxToTicket({
        store, stateDir, config, identity: trust.identity, inbox, confirmationId, staged: ticket.staged,
      });
      ticket.staged = [...ticket.staged, ...moved];
    }
    await updateTicket(store, confirmationId, { status: "submitting", staged: ticket.staged });
    ticket.status = "submitting";
    // 必须在锁内登记：并发的第二次确认一拿到锁就会看见 submitting，要能找到这次的结果。
    const inflight = createDeferred();
    inflightSubmits.set(confirmationId, inflight.promise);
    return { ticket, inflight };
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function createInOa({ store, stateDir, logger, deps, config, params }, ticket, supplement) {
  const { confirmationId } = params;
  const client = deps.clientFactory(config);
  let payload;
  let attachmentSummary;
  try {
    const started = Date.now();
    const [encoded, profile] = await Promise.all([
      encodeStagedAttachments({ stateDir, confirmationId, staged: ticket.staged }),
      deps.lookupProfile({ oaUserId: ticket.oaRequesterId, client }),
    ]);
    logger?.info?.(
      `[oa-workflow-bridge] submit_confirmed encode+profile elapsedMs=${Date.now() - started} images=${encoded.images.length} documents=${encoded.documents.length}`,
    );
    attachmentSummary = {
      attachmentCount: encoded.images.length + encoded.documents.length,
      imageCount: encoded.images.length,
      documentCount: encoded.documents.length,
    };
    payload = buildCreatePayload({
      config,
      draft: ticket.draft,
      oaRequesterId: ticket.oaRequesterId,
      profile,
      attachments: encoded.documents,
      images: encoded.images,
      supplement,
    });
  } catch (error) {
    // 资料 / 附件没备齐，没调 OA：退回待确认，员工可以再确认或取消。
    await withStateLock(store, () => updateTicket(store, confirmationId, {
      status: "awaiting_confirmation",
      expectStatus: "submitting",
    }));
    throw error;
  }

  let created;
  try {
    const started = Date.now();
    created = await client.createRequest(payload, { requesterUserId: ticket.oaRequesterId });
    logger?.info?.(`[oa-workflow-bridge] submit_confirmed doCreateRequest elapsedMs=${Date.now() - started} requestId=${created.requestId}`);
  } catch (error) {
    logger?.warn?.(`[oa-workflow-bridge] OA submission failed with safe code ${error?.code || "UNKNOWN"}`);
    // 结果不明 → unknown，留单人工对账；OA 明确拒绝 → failed，结束本单（可换新单重报）。两者都不自动重试。
    const status = error?.ambiguous ? "unknown" : "failed";
    await withStateLock(store, () => updateTicket(store, confirmationId, { status, errorCode: error?.code || "OA_ERROR" }));
    if (status === "failed") {
      await ignoreErrors(removeStagingDirectory(stateDir, confirmationId));
      await maybeCleanup(store, stateDir);
    }
    throw error;
  }

  const result = {
    requestId: created.requestId,
    externalTicketId: ticket.externalTicketId,
    summary: ticket.draft?.summary || null,
    location: pendingFaultLocation(ticket) || null,
    ...attachmentSummary,
  };
  const handlerNames = handlerNamesOf(ticket);
  try {
    await withStateLock(store, () => updateTicket(store, confirmationId, { status: "submitted", requestId: created.requestId }));
  } catch (error) {
    // OA 已建单但本地没记上：绝不能改判失败，标 unknown（带单号）留人工对账。
    logger?.warn?.(`[oa-workflow-bridge] OA created requestId=${created.requestId} but local persist failed: ${error?.message || error}`);
    await ignoreErrors(withStateLock(store, () => updateTicket(store, confirmationId, {
      status: "unknown",
      requestId: created.requestId,
      errorCode: "DB_UNAVAILABLE",
    })));
    return { ok: false, code: "RECONCILIATION_REQUIRED", ...result, replyZh: reconcileCard({ requestId: created.requestId, handlerNames }) };
  }
  await ignoreErrors(deps.removeSubmittedStaging(stateDir, confirmationId));
  await maybeCleanup(store, stateDir);
  return { ok: true, code: "SUBMITTED", ...result, replyZh: submittedCard({ ...result, handlerNames }) };
}

export async function submitConfirmed(env) {
  const { store, stateDir, trust, params } = env;
  const { confirmationId } = params;
  const supplement = sanitizeSupplement(params.supplement);
  const claim = await claimForSubmit(env);

  if (claim.waitInflight) {
    const inflight = inflightSubmits.get(confirmationId);
    if (inflight) {
      const payload = await inflight;
      return payload?.code === "SUBMITTED" ? { ...payload, code: "ALREADY_SUBMITTED" } : payload;
    }
    return outcomeForClosedTicket(await getTicket(store, confirmationId), trust);
  }
  if ("outcome" in claim) {
    const outcome = outcomeForClosedTicket(claim.outcome, trust);
    if (outcome.code === "CONFIRMATION_EXPIRED") {
      await ignoreErrors(removeStagingDirectory(stateDir, confirmationId));
      await maybeCleanup(store, stateDir);
    }
    return outcome;
  }
  if (claim.inactive) {
    return {
      ok: false,
      code: "OA_BRIDGE_INACTIVE",
      message: "OA live submission is not enabled.",
      replyZh: inactiveCard({ handlerNames: handlerNamesOf(claim.inactive) }),
    };
  }

  const { inflight } = claim;
  try {
    const payload = await createInOa(env, claim.ticket, supplement);
    inflight.resolve(payload);
    return payload;
  } catch (error) {
    inflight.reject(error);
    throw error;
  } finally {
    if (inflightSubmits.get(confirmationId) === inflight.promise) inflightSubmits.delete(confirmationId);
  }
}

