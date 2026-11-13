import { forgetStagedPathsFor, rememberInboundMediaFor } from "../inbound-media.mjs";
import { dropInbox, expireTicket, getTicket, isActiveTicket, removeStagingDirectory, updateTicket, withStateLock } from "../store.mjs";
import { belongsTo, cardFields, fail, ignoreErrors, isExpired, maybeCleanup } from "./common.mjs";

/**
 * cancel 会连同 staging 目录删掉附件副本。同一会话「cancel + prepare」改稿时，
 * 要把源 inbound 路径放回会话缓冲，新单才不会少附件。
 */
function restoreStagedSources(ctx, staged) {
  const sources = (staged || [])
    .filter((item) => item?.sourcePath)
    .map((item) => ({ localPath: item.sourcePath, fileName: item.fileName }));
  if (!sources.length) return;
  forgetStagedPathsFor(ctx, sources);
  rememberInboundMediaFor(ctx, sources, { restoredFromCancel: true });
}

export async function cancel({ store, stateDir, ctx, trust, params }) {
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
    await dropInbox(store, stateDir, ticket.identity, ticket.session);
    return ticket;
  });
  await removeStagingDirectory(stateDir, confirmationId);
  // 仅同一会话的改稿需要回灌附件；`/new` 后的明确取消不得把旧图灌进新对话。
  if (removed.session === trust.session) restoreStagedSources(ctx, removed.staged);
  await maybeCleanup(store, stateDir);
  return {
    ok: true,
    code: "CANCELLED",
    externalTicketId: removed.externalTicketId,
    ...cardFields(removed),
  };
}
