import { senderIdOf, clearInboundMediaFor, isSessionResetCommand } from "./inbound-media.mjs";
import { wipePersonInbox, withStateLock } from "./state-store.mjs";
import { identityCode, sessionCode } from "./trust.mjs";

export { isSessionResetCommand };

/**
 * 丢掉尚未 prepare 的附件：进程内 inbound + Redis inbox + 本机 inbox 目录。
 * 不碰已 prepare 的 pending（那张确认单仍按人留 24 小时）。
 */
export async function discardUnpreparedInbox({ store, stateDir, source, logger }) {
  const sender = senderIdOf(source);
  if (!sender || !store) {
    clearInboundMediaFor(source);
    return { wiped: [] };
  }
  return withStateLock(store, async () => {
    clearInboundMediaFor(source);
    const identity = identityCode(sender);
    const session = sessionCode(source);
    const wiped = await wipePersonInbox(store, stateDir, identity, session);
    if (wiped.length) {
      logger?.info?.(`[oa-workflow-bridge-redis] discarded unprepared inbox sessions=${wiped.length}`);
    }
    return { wiped };
  });
}
