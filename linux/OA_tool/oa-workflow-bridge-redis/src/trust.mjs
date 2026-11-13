import { createHash } from "node:crypto";
import { OAClientError } from "./oa-client.mjs";

export function identityCode(senderId) {
  return createHash("sha256").update(String(senderId), "utf8").digest("hex").slice(0, 24);
}

/**
 * Redis inbox / pending-idx 的会话码。优先 sessionId，这样 `/new` 或空闲自动新会话
 * 不会把建单前附件认领进下一轮；没有 sessionId 时才退回稳定的 sessionKey。
 */
export function sessionCode(ctx) {
  const token = String(ctx?.sessionId || ctx?.SessionId || ctx?.sessionKey || ctx?.SessionKey || "").trim();
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 24);
}

export function requireTrustedContext(ctx) {
  if (ctx.messageChannel !== "wecom" || !ctx.requesterSenderId || (!ctx.sessionKey && !ctx.sessionId)) {
    throw new OAClientError("OA submission requires a trusted WeCom sender context", { code: "UNTRUSTED_CONTEXT" });
  }
  return { identity: identityCode(ctx.requesterSenderId), session: sessionCode(ctx) };
}
