import { stageAttachments, stagedBytes, summarizeStaged } from "../attachments.mjs";
import { resolveInboxTtlMs } from "../config.mjs";
import {
  attachmentIdentityKeys,
  collectCtxMedia,
  collectPrepareAttachments,
  collectSubmitAttachments,
  consumeInboundMediaFor,
  peekInboundMediaFor,
  rememberStagedPathsFor,
} from "../inbound-media.mjs";
import { maskFileNames } from "../log-redact.mjs";
import {
  expireTicket,
  getActiveTicket,
  getInbox,
  getTicket,
  inboxDirName,
  isActiveTicket,
  setInbox,
  updateTicket,
  withStateLock,
} from "../store.mjs";
import { alreadyPendingPayload, conflictView, dropRotatedInbox, fail, isExpired, maybeCleanup } from "./common.mjs";

/** 新附件已暂存：记成「已随单」并清空会话缓冲，下一轮不再重复收。 */
function settleInbound(ctx, incoming) {
  if (!incoming?.length) return;
  rememberStagedPathsFor(ctx, incoming, { merge: true });
  consumeInboundMediaFor(ctx);
}

async function attachToTicket({ store, stateDir, config, ctx, trust, params, logger }, confirmationId) {
  const ticket = await getTicket(store, confirmationId);
  if (!isActiveTicket(ticket)) fail("NOT_FOUND", "Pending OA confirmation was not found");
  if (ticket.identity !== trust.identity) {
    fail("SENDER_MISMATCH", "Only the original WeCom sender can add files to this OA request");
  }
  if (isExpired(ticket)) {
    await expireTicket(store, stateDir, ticket);
    fail("CONFIRMATION_EXPIRED", "OA confirmation expired");
  }
  if (ticket.status !== "awaiting_confirmation") {
    fail("RECONCILIATION_REQUIRED", "This ticket requires OA reconciliation before retry");
  }
  const incoming = collectSubmitAttachments(ctx, params.attachments, stateDir);
  logger?.info?.(
    `[oa-workflow-bridge] attach collecting ${incoming.length} inbound (buffered=${peekInboundMediaFor(ctx).length} ctx=${collectCtxMedia(ctx, stateDir).length}): ${maskFileNames(incoming)}`,
  );
  const added = await stageAttachments({
    stateDir,
    confirmationId,
    attachments: incoming,
    config,
    startIndex: ticket.staged.length,
    existingBytes: stagedBytes(ticket.staged),
  });
  const staged = [...ticket.staged, ...added];
  if (added.length) await updateTicket(store, confirmationId, { staged });
  settleInbound(ctx, added.length ? incoming : []);
  logger?.info?.(`[oa-workflow-bridge] attach ${added.length ? "attached" : "no-new"} added=${added.length}`);
  return {
    ok: true,
    code: added.length ? "ATTACHED" : "NO_NEW_ATTACHMENT",
    confirmationId,
    addedCount: added.length,
    ...summarizeStaged(staged),
  };
}

/** 尚无待确认单：附件落到「提交人 + 会话」的 inbox，等 prepare 认领。 */
async function attachToInbox({ store, stateDir, config, ctx, trust, params, logger }) {
  await dropRotatedInbox(store, stateDir, trust);
  const existing = await getInbox(store, trust.identity, trust.session);
  const items = Array.isArray(existing?.items) ? existing.items : [];
  const knownKeys = new Set(items.flatMap((item) => attachmentIdentityKeys(item.sourcePath, item.fileName)));
  const incoming = collectPrepareAttachments(ctx, params.attachments, stateDir)
    .filter((item) => !attachmentIdentityKeys(item.localPath, item.fileName).some((key) => knownKeys.has(key)));
  logger?.info?.(
    `[oa-workflow-bridge] attach collecting ${incoming.length} inbound (buffered=${peekInboundMediaFor(ctx).length} ctx=${collectCtxMedia(ctx, stateDir).length} inbox=${items.length}): ${maskFileNames(incoming)}`,
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
  if (added.length) await setInbox(store, trust.identity, trust.session, nextItems, resolveInboxTtlMs(config));
  settleInbound(ctx, added.length ? incoming : []);
  logger?.info?.(`[oa-workflow-bridge] attach ${added.length ? "buffered" : "no-new"} added=${added.length}`);
  return {
    ok: true,
    code: added.length ? "BUFFERED" : "NO_NEW_ATTACHMENT",
    addedCount: added.length,
    ...summarizeStaged(nextItems),
  };
}

/**
 * `attach`：把员工陆续发来的图片 / 文件并入工单，不换 confirmationId。
 * 带 confirmationId 时追加到待确认单；同会话已有待确认单时漏传 id 也并入该单；
 * 另一会话已有待确认单则拦截（跨会话只能确认或取消）。尚无待确认单时落到 inbox。
 * 附件数量与体积此刻就校验。认领单还是写 inbox 必须在锁内决定。
 */
export async function attach(env) {
  const { store, stateDir, config, trust, params } = env;
  const result = await withStateLock(store, async () => {
    const conflict = conflictView(await getActiveTicket(store, trust.identity), trust, null);
    if (conflict && !conflict.expired && conflict.sameSession === false) {
      return alreadyPendingPayload(conflict, config);
    }
    let confirmationId = params.confirmationId;
    if (conflict?.expired && !confirmationId) await expireTicket(store, stateDir, conflict.expired);
    if (!confirmationId && conflict && !conflict.expired) confirmationId = conflict.confirmationId;
    return confirmationId ? attachToTicket(env, confirmationId) : attachToInbox(env);
  });
  await maybeCleanup(store, stateDir);
  return result;
}
