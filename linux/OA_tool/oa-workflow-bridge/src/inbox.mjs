import { rm } from "node:fs/promises";
import path from "node:path";
import {
  copyIntoStaging,
  limitExceeded,
  MAX_STAGED_ATTACHMENTS,
  moveStagedFiles,
  resolveInboundFile,
  stagedBytes,
  storedNameFor,
} from "./attachments.mjs";
import { resolveInboxTtlMs } from "./config.mjs";
import { attachmentIdentityKeys, senderIdOf } from "./inbound-media.mjs";
import { deleteInbox, inboxDirName, readInbox, stagingPaths, withStateLock, writeInbox } from "./store.mjs";
import { identityCode, sessionCodes } from "./trust.mjs";

/**
 * 员工发来的图片 / 文件一出现（hook 或工具 ctx）就落到此人的 inbox：拷进本机 staging 并入库。
 * 不在进程内缓冲，Gateway 重启也不丢。
 *
 * - 同一会话按去重键只收一次（通道原件与 OpenClaw 副本、多个 hook 重复上报都算同一份）。
 * - 换了对话（sessionId 对不上，见 sameConversation）先清掉旧 inbox，旧图不会串进新对话。
 * - 超过 30 分钟没动的 inbox 清掉，并记一个「已过期」提示留给下一次回执。
 * - 超出单件 / 合计 / 件数上限的文件不收，记 rejected，留给下一次回执报超限。
 *
 * 返回 `{ identity, inbox }`；取不到发送人或会话时返回 null。
 */
/**
 * 是不是同一个对话：两边都有 sessionId 时只认 sessionId（`/new` 后 sessionKey 不变，不能靠它）；
 * 有一边只有 sessionKey（hook 常见）时才用 sessionKey 对。
 */
export function sameConversation(sessions, codes) {
  if (codes.id && sessions.ids.length) return sessions.ids.includes(codes.id);
  return Boolean(codes.key && sessions.keys.includes(codes.key));
}

export async function captureInbound({ store, stateDir, config, source, attachments = [] }) {
  const sender = senderIdOf(source);
  const codes = sessionCodes(source);
  if (!sender || (!codes.id && !codes.key)) return null;
  const identity = identityCode(sender);
  return withStateLock(store, async () => {
    let inbox = await readInbox(store, identity);
    let changed = false;
    let expiredNotice = false;
    if (inbox?.expired) {
      expiredNotice = inbox.items.length > 0 || inbox.expiredNotice;
      await deleteInbox(store, stateDir, identity);
      inbox = null;
      changed = true;
    } else if (inbox && !sameConversation(inbox.sessions, codes)) {
      await deleteInbox(store, stateDir, identity);
      inbox = null;
    }
    inbox ||= { sessions: { ids: [], keys: [] }, items: [], seen: [], rejected: 0, expiredNotice: false };
    inbox.expiredNotice ||= expiredNotice;
    if (codes.id && !inbox.sessions.ids.includes(codes.id)) inbox.sessions.ids.push(codes.id);
    if (codes.key && !inbox.sessions.keys.includes(codes.key)) inbox.sessions.keys.push(codes.key);

    const seen = new Set(inbox.seen);
    for (const item of attachments) {
      const keys = attachmentIdentityKeys(item.localPath, item.fileName);
      if (!keys.length || keys.some((key) => seen.has(key))) continue;
      const file = await resolveInboundFile(stateDir, item);
      if (!file) continue;
      const realKey = `realpath:${file.source}`;
      if (seen.has(realKey)) continue;
      for (const key of [...keys, realKey]) seen.add(key);
      changed = true;
      const fits = file.size <= config.maxAttachmentBytes
        && inbox.items.length < MAX_STAGED_ATTACHMENTS
        && stagedBytes(inbox.items) + file.size <= config.maxTotalAttachmentBytes;
      if (!fits) {
        inbox.rejected += 1;
        continue;
      }
      const storedName = storedNameFor(inbox.items.length, file.fileName);
      await copyIntoStaging(stateDir, inboxDirName(identity), file.source, storedName);
      inbox.items.push({ storedName, fileName: file.fileName, size: file.size, sourcePath: file.source, reported: false });
    }
    inbox.seen = [...seen];
    if (changed) await writeInbox(store, identity, inbox, resolveInboxTtlMs(config));
    return { identity, inbox };
  });
}

/** 取出待报的提示（过期、超限）并清零。调用方持锁。 */
export async function takeInboxNotices(store, identity, inbox, config) {
  if (!inbox || (!inbox.expiredNotice && !inbox.rejected)) return { expired: false, rejected: 0 };
  const notices = { expired: inbox.expiredNotice, rejected: inbox.rejected };
  inbox.expiredNotice = false;
  inbox.rejected = 0;
  await writeInbox(store, identity, inbox, resolveInboxTtlMs(config));
  return notices;
}

/**
 * 把 inbox 里的附件整批搬进工单目录（prepare 认领、待确认单补件、确认时随单）。
 * 只搬文件，不改 inbox 记录：调用方把工单写库后再调 clearInboxItems，
 * 这样写库失败时附件仍在 inbox 名下，不会丢。
 * 超过工单上限则这批全部丢弃并报超限（工单不变）。调用方持锁。
 */
export async function moveInboxToTicket({ store, stateDir, config, identity, inbox, confirmationId, staged }) {
  if (!inbox?.items.length) return [];
  const items = inbox.items;
  if (staged.length + items.length > MAX_STAGED_ATTACHMENTS
    || stagedBytes(staged) + stagedBytes(items) > config.maxTotalAttachmentBytes) {
    await clearInboxItems(store, identity, inbox, config);
    await removeInboxFiles(stateDir, identity);
    throw limitExceeded();
  }
  return moveStagedFiles(stateDir, inboxDirName(identity), confirmationId, items, staged.length);
}

/** inbox 附件已进工单：清掉附件清单，保留去重键（同一张图后续 hook 再报也不会重复收）。 */
export async function clearInboxItems(store, identity, inbox, config) {
  if (!inbox?.items.length) return;
  inbox.items = [];
  await writeInbox(store, identity, inbox, resolveInboxTtlMs(config));
}

async function removeInboxFiles(stateDir, identity) {
  await rm(path.join(stagingPaths(stateDir).stagingRoot, inboxDirName(identity)), { recursive: true, force: true });
}
