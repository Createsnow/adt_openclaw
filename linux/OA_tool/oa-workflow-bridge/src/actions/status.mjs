import { hintZhFor, submittedPreview } from "../hints.mjs";
import { confirmCard, NO_QUERY_BY_NUMBER, NUDGE, otherSessionCard, reconcileCard } from "../reply.mjs";
import { expireTicket, getActiveTicket, getTicket, isActiveTicket, listRecentTickets, removeStagingDirectory } from "../store.mjs";
import {
  activeTicketCode,
  belongsTo,
  cardFields,
  closedTicketCode,
  handlerNamesOf,
  ignoreErrors,
  isExpired,
  isSameSession,
  maybeCleanup,
  retentionFields,
} from "./common.mjs";

/** 待确认 / 对账中的单给员工看什么。 */
function activeReply(ticket, trust, context) {
  if (ticket.status !== "awaiting_confirmation") {
    return reconcileCard({ requestId: ticket.requestId, handlerNames: handlerNamesOf(ticket) });
  }
  if (!isSameSession(ticket, trust)) return otherSessionCard(cardFields(ticket));
  const lead = context === "unclear_reply" ? NUDGE : "🔍 你有一张未提交的确认单。";
  return `${lead}\n\n${confirmCard(cardFields(ticket))}`;
}

/**
 * 不带 confirmationId：此人当前待确认（如有）+ 最近记录（最多 5 条已提交单号）。
 * context=unclear_reply：员工在确认卡上回了「好的 / 不用了」等，回请改口并重发确认卡；
 * context=asked_oa_number：员工报了 OA 单号问进度，先说明不能按单号查。
 */
async function personStatus({ store, stateDir, config, trust, params }) {
  let pendingView = null;
  let active = await getActiveTicket(store, trust.identity);
  if (active && isExpired(active)) {
    await expireTicket(store, stateDir, active);
    active = null;
  }
  if (active) {
    pendingView = {
      confirmationId: active.confirmationId,
      code: activeTicketCode(active),
      ...cardFields(active),
      ...retentionFields(active, trust, config),
    };
  }
  const recent = await listRecentTickets(store, trust.identity);
  const preview = submittedPreview(recent);
  if (pendingView) {
    const payload = {
      ok: true,
      code: pendingView.code === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : "PERSON_STATUS",
      confirmationId: pendingView.confirmationId,
      pending: pendingView,
      recent,
      ...preview,
    };
    payload.replyZh = activeReply(active, trust, params.context);
    return payload;
  }
  const payload = { ok: true, code: "PERSON_STATUS", pending: null, recent, ...preview };
  const list = hintZhFor(payload);
  payload.replyZh = params.context === "asked_oa_number" ? `${NO_QUERY_BY_NUMBER}\n${list}` : list;
  return payload;
}

async function ticketStatus({ store, stateDir, config, trust }, confirmationId) {
  const ticket = await getTicket(store, confirmationId);
  if (!belongsTo(ticket, trust)) return { ok: false, code: "NOT_FOUND" };
  if (isActiveTicket(ticket) && isExpired(ticket)) {
    await expireTicket(store, stateDir, ticket);
    return { ok: true, code: "CONFIRMATION_EXPIRED", confirmationId, externalTicketId: ticket.externalTicketId || null };
  }
  if (isActiveTicket(ticket)) {
    return {
      ok: true,
      code: activeTicketCode(ticket),
      confirmationId,
      externalTicketId: ticket.externalTicketId || null,
      ...cardFields(ticket),
      ...retentionFields(ticket, trust, config),
      replyZh: activeReply(ticket, trust),
    };
  }
  await ignoreErrors(removeStagingDirectory(stateDir, confirmationId));
  return {
    ok: true,
    code: closedTicketCode(ticket),
    requestId: ticket.requestId || null,
    externalTicketId: ticket.externalTicketId || null,
  };
}

export async function status(env) {
  const { params, store, stateDir } = env;
  const result = params.confirmationId && typeof params.confirmationId === "string"
    ? await ticketStatus(env, params.confirmationId)
    : await personStatus(env);
  await maybeCleanup(store, stateDir);
  return result;
}
