import { randomBytes } from "node:crypto";
import { adoptStagedFiles, stageAttachments, stagedBytes, summarizeStaged } from "../attachments.mjs";
import { attachmentIdentityKeys, collectPrepareAttachments, consumeInboundMediaFor, rememberStagedPathsFor } from "../inbound-media.mjs";
import { maskFileNames } from "../log-redact.mjs";
import { allocateExternalTicketId, normalizeDraft } from "../mapping.mjs";
import { OAClientError } from "../oa-client.mjs";
import {
  dropInbox,
  expireTicket,
  getInbox,
  getLatestTicketByExternalId,
  inboxDirName,
  insertTicket,
  removeStagingDirectory,
  withStateLock,
} from "../store.mjs";
import {
  alreadyPendingPayload,
  conflictView,
  dropRotatedInbox,
  fail,
  ignoreErrors,
  isExpired,
  maybeCleanup,
  personConflict,
} from "./common.mjs";

function newConfirmationId() {
  return `OA-${Date.now().toString(36).toUpperCase()}-${randomBytes(8).toString("hex").toUpperCase()}`;
}

/** 同一内部幂等号：已提交、提交中 / 待对账、或仍在有效期的待确认都不能再 prepare。 */
async function assertExternalIdReusable(store, externalTicketId, trust, config) {
  const ticket = await getLatestTicketByExternalId(store, externalTicketId);
  if (!ticket) return;
  if (ticket.status === "submitted") fail("ALREADY_SUBMITTED", "This ticket was already submitted to OA");
  if (ticket.status === "submitting" || ticket.status === "unknown") {
    fail("RECONCILIATION_REQUIRED", "This ticket requires OA reconciliation before retry");
  }
  if (ticket.status === "awaiting_confirmation" && !isExpired(ticket)) {
    // 同一条企微消息重复 prepare 会算出同一个内部幂等号。回执必须带 confirmationId / sameSession，
    // 否则模型既出不了确认卡也出不了拦截卡。
    fail("ALREADY_PENDING", "This ticket already has a pending OA confirmation",
      alreadyPendingPayload(conflictView(ticket, trust, null), config));
  }
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

function isDuplicateKey(error) {
  return error?.code === "ER_DUP_ENTRY" || /UNIQUE constraint failed/i.test(String(error?.message || ""));
}

export async function prepare({ store, stateDir, config, ctx, trust, params, logger, deps }) {
  const now = Date.now();
  const draft = normalizeDraft({
    ...(params.draft || {}),
    externalTicketId: allocateExternalTicketId(ctx, now),
  }, await deps.loadSystems());
  // 先拦冲突再查身份：被拦下的员工不必打企微 / 人事接口。
  await assertExternalIdReusable(store, draft.externalTicketId, trust, config);
  const conflict = await personConflict(store, trust, draft.externalTicketId);
  if (conflict?.expired) {
    await expireTicket(store, stateDir, conflict.expired);
  } else if (conflict) {
    return alreadyPendingPayload(conflict, config);
  }

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
  let staged;
  let committed = false;
  // inbox 快照、adopt、写工单、清 inbox 必须同处一个临界区：attach 也持这把锁写同一个 inbox，
  // 否则快照之后落进来的附件不会进本单，却会被收尾的清 inbox 删掉。
  try {
    await withStateLock(store, async () => {
      await dropRotatedInbox(store, stateDir, trust);
      const inbox = await getInbox(store, trust.identity, trust.session);
      const inboxItems = Array.isArray(inbox?.items) ? inbox.items : [];
      const bufferedKeys = new Set(inboxItems.flatMap((item) => attachmentIdentityKeys(item.sourcePath, item.fileName)));
      const attachments = collectPrepareAttachments(ctx, params.attachments, stateDir)
        .filter((item) => !attachmentIdentityKeys(item.localPath, item.fileName).some((key) => bufferedKeys.has(key)));
      logger?.info?.(
        `[oa-workflow-bridge] prepare collecting ${inboxItems.length} buffered + ${attachments.length} inbound attachment(s): ${maskFileNames(attachments)}`,
      );
      const adopted = await adoptStagedFiles({
        stateDir,
        fromDirName: inboxDirName(trust.identity, trust.session),
        toDirName: confirmationId,
        items: inboxItems,
        config,
      });
      staged = [...adopted, ...await stageAttachments({
        stateDir,
        confirmationId,
        attachments,
        config,
        startIndex: adopted.length,
        existingBytes: stagedBytes(adopted),
      })];
      // 锁外的检查可能已过时（并发 prepare），锁内再核一次。
      await assertExternalIdReusable(store, draft.externalTicketId, trust, config);
      const lockedConflict = await personConflict(store, trust, draft.externalTicketId);
      if (lockedConflict?.expired) {
        await expireTicket(store, stateDir, lockedConflict.expired);
      } else if (lockedConflict) {
        fail("ALREADY_PENDING", "This sender already has a pending OA confirmation", alreadyPendingPayload(lockedConflict, config));
      }
      try {
        await insertTicket(store, {
          confirmationId,
          identity: trust.identity,
          session: trust.session,
          oaRequesterId,
          draft,
          staged,
          expiresAt,
        });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const raced = await personConflict(store, trust, null);
        fail("ALREADY_PENDING", "This sender already has a pending OA confirmation",
          raced && !raced.expired ? alreadyPendingPayload(raced, config) : null);
      }
      committed = true;
      rememberStagedPathsFor(ctx, [
        ...attachments,
        ...inboxItems.filter((item) => item.sourcePath).map((item) => ({ localPath: item.sourcePath })),
      ]);
      if (attachments.length) consumeInboundMediaFor(ctx);
      if (inboxItems.length) {
        try {
          await dropInbox(store, stateDir, trust.identity, trust.session);
        } catch (cleanupError) {
          logger?.warn?.(`[oa-workflow-bridge] ticket saved but inbox cleanup failed: ${cleanupError?.message || cleanupError}`);
        }
      }
    });
  } catch (error) {
    if (!committed) await ignoreErrors(removeStagingDirectory(stateDir, confirmationId));
    throw error;
  }
  logger?.info?.(`[oa-workflow-bridge] prepare staged ${staged.length} attachment(s)`);
  await maybeCleanup(store, stateDir, now);
  return {
    ok: true,
    code: "AWAITING_CONFIRMATION",
    confirmationId,
    expiresAt: new Date(expiresAt).toISOString(),
    retentionHours: config.pendingTtlHours,
    sameSession: true,
    location: draft.location || null,
    summary: {
      externalTicketId: draft.externalTicketId,
      ticketType: draft.ticketType,
      systemName: draft.systemName,
      location: draft.location || null,
      problemSummary: draft.summary,
      ...summarizeStaged(staged),
    },
  };
}
