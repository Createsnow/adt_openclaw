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
 * - 换了会话（会话码对不上）先清掉旧 inbox，旧图不会串进新会话。
 * - 超过 30 分钟没动的 inbox 清掉，并记一个「已过期」提示留给下一次回执。
 * - 超出单件 / 合计 / 件数上限的文件不收，记 rejected，留给下一次回执报超限。
 *
 * 返回 `{ identity, inbox }`；取不到发送人或会话时返回 null。
 */
export async function captureInbound({ store, stateDir, config, source, attachments = [] }) {
  const sender = senderIdOf(source);
  const sessions = sessionCodes(source);
  if (!sender || !sessions.length) return null;
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
    } else if (inbox && !inbox.sessions.some((code) => sessions.includes(code))) {
      await deleteInbox(store, stateDir, identity);
      inbox = null;
    }
    inbox ||= { sessions: [], items: [], seen: [], rejected: 0, expiredNotice: false };
    inbox.expiredNotice ||= expiredNotice;
    for (const code of sessions) {
      if (!inbox.sessions.includes(code)) inbox.sessions.push(code);
    }

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
 * 搬完 inbox 只清附件、保留去重键，同一张图后续 hook 再报也不会重复收。
 * 超过工单上限则这批全部丢弃并报超限（工单不变）。调用方持锁。
 */
export async function moveInboxToTicket({ store, stateDir, config, identity, inbox, confirmationId, staged }) {
  if (!inbox?.items.length) return [];
  const items = inbox.items;
  inbox.items = [];
  const tooMany = staged.length + items.length > MAX_STAGED_ATTACHMENTS
    || stagedBytes(staged) + stagedBytes(items) > config.maxTotalAttachmentBytes;
  const moved = tooMany ? [] : await moveStagedFiles(stateDir, inboxDirName(identity), confirmationId, items, staged.length);
  await writeInbox(store, identity, inbox, resolveInboxTtlMs(config));
  if (tooMany) {
    await removeInboxFiles(stateDir, identity);
    throw limitExceeded();
  }
  return moved;
}

async function removeInboxFiles(stateDir, identity) {
  await rm(path.join(stagingPaths(stateDir).stagingRoot, inboxDirName(identity)), { recursive: true, force: true });
}
