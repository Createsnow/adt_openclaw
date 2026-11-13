import { CANCELLED } from "../reply.mjs";
import { deleteSessionInbox, expireTicket, getTicket, isActiveTicket, removeStagingDirectory, updateTicket, withStateLock } from "../store.mjs";
import { belongsTo, cardFields, fail, ignoreErrors, isExpired, maybeCleanup } from "./common.mjs";

/** 明确取消：作废待确认单，删该单附件与同一对话里还没进单的附件。下一句要重新说问题。 */
export async function cancel({ store, stateDir, trust, params }) {
  const confirmationId = params.confirmationId;
  const removed = await withStateLock(store, async () => {
    const ticket = await getTicket(store, confirmationId);
    if (!belongsTo(ticket, trust)) fail("NOT_FOUND", "Pending OA confirmation was not found");
    if (!isActiveTicket(ticket)) {
      if (ticket.status === "expired") {
        await ignoreErrors(removeStagingDirectory(stateDir, confirmationId));
        fail("CONFIRMATION_EXPIRED", "OA confirmation expired");
      }
      fail("NOT_FOUND", "Pending OA confirmation was not found");
    }
    if (isExpired(ticket)) {
      await expireTicket(store, stateDir, ticket);
      fail("CONFIRMATION_EXPIRED", "OA confirmation expired");
    }
    if (ticket.status !== "awaiting_confirmation") {
      fail("RECONCILIATION_REQUIRED", "This ticket requires OA reconciliation before it can be cancelled");
    }
    await updateTicket(store, confirmationId, { status: "cancelled" });
    await deleteSessionInbox(store, stateDir, ticket.identity, ticket.session);
    return ticket;
  });
  await ignoreErrors(removeStagingDirectory(stateDir, confirmationId));
  await maybeCleanup(store, stateDir);
  return {
    ok: true,
    code: "CANCELLED",
    externalTicketId: removed.externalTicketId,
    ...cardFields(removed),
    replyZh: CANCELLED,
  };
}
