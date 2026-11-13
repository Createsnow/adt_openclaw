import { createHash } from "node:crypto";
import { OAClientError } from "./oa-client.mjs";

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 24);
}

/**
 * 发送人码（工单 sender_code、身份缓存 mapping_code）。按小写算：单聊 hook 有时只能从
 * sessionKey 尾部拿到小写的发送人，必须和工具 ctx 的原始大小写对上。原始 SenderId 不落库。
 */
export function identityCode(senderId) {
  return digest(String(senderId).trim().toLowerCase());
}

/**
 * 会话码。优先 sessionId，这样 `/new` 或空闲自动新会话不会把建单前附件认领进下一轮；
 * 没有 sessionId 时才退回稳定的 sessionKey。
 */
export function sessionCode(ctx) {
  return digest(String(ctx?.sessionId || ctx?.SessionId || ctx?.sessionKey || ctx?.SessionKey || "").trim());
}

/** 同一会话可能出现的所有会话码：hook 常常只有 sessionKey，工具 ctx 还有 sessionId。 */
export function sessionCodes(ctx) {
  const tokens = [ctx?.sessionId || ctx?.SessionId, ctx?.sessionKey || ctx?.SessionKey]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(tokens.map(digest))];
}

export function requireTrustedContext(ctx) {
  if (ctx.messageChannel !== "wecom" || !ctx.requesterSenderId || (!ctx.sessionKey && !ctx.sessionId)) {
    throw new OAClientError("OA submission requires a trusted WeCom sender context", { code: "UNTRUSTED_CONTEXT" });
  }
  return { identity: identityCode(ctx.requesterSenderId), session: sessionCode(ctx), sessions: sessionCodes(ctx) };
}
