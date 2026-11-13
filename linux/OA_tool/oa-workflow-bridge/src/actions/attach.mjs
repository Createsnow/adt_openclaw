import { limitExceeded, summarizeStaged } from "../attachments.mjs";
import { resolveInboxTtlMs } from "../config.mjs";
import { attachmentReceiptHint, hintZhFor } from "../hints.mjs";
import { moveInboxToTicket } from "../inbox.mjs";
import { confirmCard, INBOX_EXPIRED } from "../reply.mjs";
import { expireTicket, getActiveTicket, getTicket, isActiveTicket, updateTicket, withStateLock, writeInbox } from "../store.mjs";
import { captureToolMedia, cardFields, fail, isExpired, isSameSession, maybeCleanup } from "./common.mjs";

function withExpiredNotice(notices, reply) {
  return notices.expired ? [INBOX_EXPIRED, reply].filter(Boolean).join("\n\n") : reply;
}

/**
 * `attach`：员工只发了图片 / 文件。附件已由 hook / 本轮 ctx 落进 inbox，这里只决定归属并回执：
 * - 当前对话里有待确认单：整批并入该单（ATTACHED），回执后重发确认卡；
 * - 否则留在 inbox 等 prepare 认领（BUFFERED），包括另一个对话里还留着旧单的情况。
 * 超限当场报 ATTACHMENT_LIMIT_EXCEEDED，待确认单不变。
 */
export async function attach(env) {
  const { store, stateDir, config, trust, params } = env;
  const result = await withStateLock(store, async () => {
    const { inbox, notices } = await captureToolMedia(env);
    if (params.confirmationId) {
      const named = await getTicket(store, params.confirmationId);
      if (!isActiveTicket(named)) fail("NOT_FOUND", "Pending OA confirmation was not found");
      if (named.identity !== trust.identity) {
        fail("SENDER_MISMATCH", "Only the original WeCom sender can add files to this OA request");
      }
    }
    let active = await getActiveTicket(store, trust.identity);
    if (active && isExpired(active)) {
      await expireTicket(store, stateDir, active);
      if (params.confirmationId === active.confirmationId) fail("CONFIRMATION_EXPIRED", "OA confirmation expired");
      active = null;
    }

    if (active && isSameSession(active, trust)) {
      if (active.status !== "awaiting_confirmation") {
        fail("RECONCILIATION_REQUIRED", "This ticket requires OA reconciliation before retry");
      }
      const moved = await moveInboxToTicket({
        store, stateDir, config, identity: trust.identity, inbox, confirmationId: active.confirmationId, staged: active.staged,
      });
      if (moved.length) {
        active.staged = [...active.staged, ...moved];
        await updateTicket(store, active.confirmationId, { staged: active.staged });
      }
      if (notices.rejected) throw limitExceeded();
      const counts = summarizeStaged(active.staged);
      const payload = {
        ok: true,
        code: moved.length ? "ATTACHED" : "NO_NEW_ATTACHMENT",
        confirmationId: active.confirmationId,
        addedCount: moved.length,
        ...counts,
      };
      const receipt = moved.length ? attachmentReceiptHint(counts) : hintZhFor(payload);
      payload.replyZh = withExpiredNotice(notices, moved.length ? `${receipt}\n\n${confirmCard(cardFields(active))}` : (notices.expired ? "" : receipt));
      return payload;
    }

    const fresh = inbox.items.filter((item) => !item.reported);
    if (fresh.length) {
      for (const item of inbox.items) item.reported = true;
      await writeInbox(store, trust.identity, inbox, resolveInboxTtlMs(config));
    }
    if (notices.rejected) throw limitExceeded();
    const payload = {
      ok: true,
      code: fresh.length ? "BUFFERED" : "NO_NEW_ATTACHMENT",
      addedCount: fresh.length,
      ...summarizeStaged(inbox.items),
    };
    payload.replyZh = withExpiredNotice(notices, notices.expired && !fresh.length ? "" : hintZhFor(payload));
    return payload;
  });
  await maybeCleanup(store, stateDir);
  return result;
}
