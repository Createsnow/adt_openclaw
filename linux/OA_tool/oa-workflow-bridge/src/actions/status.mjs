import { submittedPreview } from "../hints.mjs";
import { expireTicket, getActiveTicket, getTicket, isActiveTicket, listRecentTickets, removeStagingDirectory } from "../store.mjs";
import {
  activeTicketCode,
  belongsTo,
  cardFields,
  closedTicketCode,
  ignoreErrors,
  isExpired,
  maybeCleanup,
  retentionFields,
} from "./common.mjs";

/** 不带 confirmationId：此人当前待确认（如有）+ 最近记录（最多 5 条已提交单号）。 */
async function personStatus({ store, stateDir, config, trust }) {
  let pendingView = null;
  const active = await getActiveTicket(store, trust.identity);
  if (active) {
    if (isExpired(active)) {
      await expireTicket(store, stateDir, active);
    } else {
      pendingView = {
        confirmationId: active.confirmationId,
        code: activeTicketCode(active),
        ...cardFields(active),
        ...retentionFields(active, trust, config),
      };
    }
  }
  const recent = await listRecentTickets(store, trust.identity);
  const preview = submittedPreview(recent);
  // 问进度惯例不带 confirmationId。对账中的单必须抬成顶层码，否则模型只看见 PERSON_STATUS + pending 就会发确认卡。
  if (pendingView?.code === "RECONCILIATION_REQUIRED") {
    return { ok: true, code: "RECONCILIATION_REQUIRED", confirmationId: pendingView.confirmationId, pending: pendingView, recent, ...preview };
  }
  return { ok: true, code: "PERSON_STATUS", pending: pendingView, recent, ...preview };
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
