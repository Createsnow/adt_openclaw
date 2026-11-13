import { statSync } from "node:fs";
import path from "node:path";

const inboundBySession = new Map();
const stagedPathsBySession = new Map();
/**
 * 会话缓冲只是 hook 到 attach / prepare 之间的第一跳。留太久会把上一张单里员工发了又放弃的
 * 图片带进下一张单，所以超过这个时长的条目直接丢弃；真正要留存的附件已经落到会话 inbox。
 * 30 分钟对齐 OpenClaw 空闲新会话与 Redis inboxTtlMinutes。
 */
const INBOUND_BUFFER_TTL_MS = 30 * 60 * 1000;
const MEDIA_ATTACHED_RE = /\[media attached:\s*([^\]]+)\]/gi;
const INBOUND_PATH_RE = /(?:^|[\s"'`=])((?:[A-Za-z]:)?[\\/][^\s"'`\]]+?[\\/]media[\\/]+inbound[\\/]+[^\s"'`\]]+)/g;
const MEDIA_URI_RE = /^media:\/\/inbound\/(.+)$/i;

function sessionKeyOf(value) {
  return String(value || "").trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

/** 通道 inbound 常用 SenderId / from.userid，工具 ctx 才保证有 requesterSenderId。 */
export function senderIdOf(source) {
  if (!source || typeof source !== "object") return "";
  const from = source.from;
  const fromId = typeof from === "string"
    ? from
    : (from && typeof from === "object"
      ? firstNonEmpty(from.userid, from.userId, from.UserId, from.id, from.senderId, from.SenderId)
      : "");
  return firstNonEmpty(
    source.requesterSenderId,
    source.SenderId,
    source.senderId,
    source.senderID,
    fromId,
  );
}

function sessionIdOf(source) {
  return firstNonEmpty(source?.sessionId, source?.SessionId);
}

function sessionKeyFieldOf(source) {
  return firstNonEmpty(source?.sessionKey, source?.SessionKey);
}

/**
 * 合并 hook event 与工具 ctx 上的身份字段。按传入顺序先到先得（hook 调用为 ctx, event）。
 */
export function mediaSourceFrom(...sources) {
  const merged = {};
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const sender = senderIdOf(source);
    const sessionId = sessionIdOf(source);
    const sessionKey = sessionKeyFieldOf(source);
    if (sender && !merged.requesterSenderId) merged.requesterSenderId = sender;
    if (sessionId && !merged.sessionId) merged.sessionId = sessionId;
    if (sessionKey && !merged.sessionKey) merged.sessionKey = sessionKey;
  }
  return merged;
}

function conversationOf(source) {
  return firstNonEmpty(sessionIdOf(source), sessionKeyFieldOf(source));
}

function senderEmbeddedInSessionKey(sender, sessionKey) {
  if (!sender || !sessionKey) return false;
  return sessionKey.toLowerCase().includes(sender.toLowerCase());
}

function pushScopeKey(keys, value) {
  const key = sessionKeyOf(value);
  if (key && !keys.includes(key)) keys.push(key);
}

function isRemoteUrl(value) {
  if (/^media:/i.test(value)) return false;
  return /^(https?|ftp|ws|wss):/i.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function resolveMediaUri(value, stateDir) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = MEDIA_URI_RE.exec(text);
  if (!match) return text;
  if (!stateDir) return text;
  const id = decodeURIComponent(match[1]).replace(/\\/g, "/");
  if (!id || id.includes("..") || id.includes("/") || path.isAbsolute(id)) return "";
  return path.join(stateDir, "media", "inbound", id);
}

function asLocalPath(item, stateDir) {
  if (typeof item === "string") return resolveMediaUri(item.trim(), stateDir);
  if (!item || typeof item !== "object") return "";
  return resolveMediaUri(
    String(item.localPath || item.path || item.mediaPath || item.MediaPath || item.filePath || "").trim(),
    stateDir,
  );
}

function looksLikeInboundMediaPath(value) {
  const text = String(value || "").trim();
  if (!text || isRemoteUrl(text) || /[<>]/.test(text)) return false;
  const normalized = text.replace(/\\/g, "/");
  if (!path.isAbsolute(text) && !/^[A-Za-z]:[\\/]/.test(text) && !normalized.startsWith("/")) return false;
  return /\/media\/inbound\//i.test(normalized);
}

function inboundPathFromCapture(raw) {
  const value = String(raw || "").trim().replace(/^['"`]+|['"`]+$/g, "");
  if (!value || /[<>]/.test(value)) return "";
  const match = value.match(/((?:[A-Za-z]:)?[\\/][^\s"'`\]]+?[\\/]media[\\/]+inbound[\\/]+[^\s"'`()]+)/i);
  return match && looksLikeInboundMediaPath(match[1]) ? match[1] : "";
}

function lastUserLikeMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const assistantRoles = new Set(["assistant", "ai", "tool", "system", "developer", "model"]);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = String(messages[i]?.role || messages[i]?.type || "").toLowerCase();
    if (!assistantRoles.has(role)) return messages[i];
  }
  return null;
}

function currentTurnText(source) {
  if (!source || typeof source !== "object") return "";
  const current = source.currentMessage;
  const currentText = typeof current === "string"
    ? current
    : (current?.text || current?.content || current?.body || "");
  const nestedBody = typeof source.body === "string"
    ? source.body
    : (source.body?.text || source.body?.content || source.text?.content || "");
  return [source.cleanedBody, source.bodyForAgent, source.content, currentText, nestedBody]
    .filter((item) => typeof item === "string" && item.trim())
    .join("\n");
}

/** OpenClaw `/new` / `/reset`：建单前 inbox 必须立刻丢掉，不能等 TTL。 */
export function isSessionResetCommand(...sources) {
  for (const source of sources) {
    const text = typeof source === "string" ? source : currentTurnText(source);
    const line = String(text || "").trim().split(/\r?\n/, 1)[0].trim();
    if (/^(?:\/new|\/reset)(?:\s|$)/i.test(line)) return true;
  }
  return false;
}

function lastUserPromptSlice(prompt) {
  const text = String(prompt || "");
  if (!text) return "";
  const markers = [
    /(?:^|\n)(?:#{1,3}[ \t]*)?User(?:\s|:)/gi,
    /(?:^|\n)Human:/gi,
    /(?:^|\n)用户：/g,
    /(?:^|\n)\[(?:User|user)\]/g,
  ];
  let lastIndex = -1;
  for (const re of markers) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      if (match.index > lastIndex) lastIndex = match.index;
    }
  }
  return lastIndex >= 0 ? text.slice(lastIndex) : text;
}

function extractMediaAttachedOnly(text) {
  const collected = [];
  for (const match of String(text || "").matchAll(MEDIA_ATTACHED_RE)) {
    const inboundPath = inboundPathFromCapture(match[1]);
    if (inboundPath) pushUnique(collected, inboundPath);
  }
  return toAttachmentList(collected);
}

function extractPromptMedia(prompt) {
  const text = String(prompt || "");
  if (!text) return [];
  const slice = lastUserPromptSlice(text);
  if (slice !== text) return extractMediaAttachedOnly(slice);
  if (text.length > 4000) return [];
  return extractMediaAttachedOnly(text);
}

function asFileName(item) {
  if (!item || typeof item !== "object") return "";
  return String(item.fileName || item.filename || item.name || "").trim();
}

function inboundDisplayName(fileName) {
  return String(fileName || "attachment.bin").replace(
    /---[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[^.]+)$/i,
    "$1",
  );
}

function pathKey(localPath) {
  return String(localPath || "").replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function fileSize(localPath) {
  try {
    const info = statSync(localPath);
    return info.isFile() ? Number(info.size) : -1;
  } catch {
    return -1;
  }
}

function stripOpenClawStagedPrefix(name) {
  return String(name || "").replace(/^input-/i, "");
}

/**
 * 一张图会被通道写成 media/inbound；OpenClaw 2026.9.2 再拷到
 * workspace/media/inbound/openclaw-staged-<uuid>/input-<原文件名>。
 * 只按完整路径或带 input- 的 basename 去重，会把同一张算成两份。
 */
function inboundIdentityKeys(localPath, fileName) {
  const keys = [];
  const normalized = pathKey(localPath);
  if (normalized) keys.push(`path:${normalized}`);
  const base = path.basename(String(localPath || "")).toLowerCase();
  if (base) keys.push(`base:${base}`);
  const originBase = stripOpenClawStagedPrefix(base);
  if (originBase) keys.push(`origin:${originBase}`);
  const display = inboundDisplayName(fileName || path.basename(String(localPath || ""))).toLowerCase();
  const stem = inboundDisplayName(originBase || display).toLowerCase();
  const size = fileSize(localPath);
  if (size > 0 && display) keys.push(`content:${size}:${display}`);
  if (size > 0 && stem && stem !== display) keys.push(`content:${size}:${stem}`);
  return keys;
}

function isOpenClawStagedCopy(localPath) {
  const normalized = String(localPath || "").replace(/\\/g, "/");
  return /\/media\/inbound\/openclaw-staged-/i.test(normalized)
    || /^input-/i.test(path.basename(normalized));
}

function hasSharedIdentity(left, right) {
  if (!left?.length || !right?.length) return false;
  const lookup = new Set(left);
  return right.some((key) => lookup.has(key));
}

function pushUnique(target, item) {
  const localPath = asLocalPath(item);
  if (!localPath || isRemoteUrl(localPath) || /[<>]/.test(localPath)) return;
  if (!MEDIA_URI_RE.test(localPath) && !looksLikeInboundMediaPath(localPath)) return;
  const fileName = asFileName(item) || inboundDisplayName(stripOpenClawStagedPrefix(path.basename(localPath)));
  const keys = inboundIdentityKeys(localPath, fileName);
  const existingIndex = target.findIndex((existing) => hasSharedIdentity(existing.keys, keys));
  if (existingIndex >= 0) {
    const existing = target[existingIndex];
    if (isOpenClawStagedCopy(existing.localPath) && !isOpenClawStagedCopy(localPath)) {
      target[existingIndex] = {
        key: pathKey(localPath),
        keys,
        localPath,
        ...(fileName ? { fileName } : {}),
      };
    }
    return;
  }
  target.push({
    key: pathKey(localPath),
    keys,
    localPath,
    ...(fileName ? { fileName } : {}),
  });
}

function collectFromBag(bag, target) {
  if (typeof bag === "string") {
    pushUnique(target, bag);
    return;
  }
  if (!Array.isArray(bag)) return;
  for (const item of bag) pushUnique(target, item);
}

function toAttachmentList(collected) {
  return collected.map(({ localPath, fileName }) => (fileName ? { localPath, fileName } : { localPath }));
}

function remapResolved(list, stateDir) {
  const collected = [];
  for (const item of list || []) {
    const localPath = resolveMediaUri(item.localPath, stateDir);
    if (!localPath || isRemoteUrl(localPath) || /[<>]/.test(localPath)) continue;
    if (!looksLikeInboundMediaPath(localPath)) continue;
    pushUnique(collected, { ...item, localPath });
  }
  return toAttachmentList(collected);
}

function collectStructuredMedia(source, target) {
  if (!source || typeof source !== "object") return;
  collectFromBag(source.media, target);
  collectFromBag(source.mediaPaths, target);
  collectFromBag(source.MediaPaths, target);
  collectFromBag(source.mediaPath, target);
  collectFromBag(source.MediaPath, target);
  collectFromBag(source.inboundMedia, target);
  collectFromBag(source.images, target);
  collectFromBag(source.files, target);
  collectFromBag(source.attachments, target);
  collectFromBag(source.deliveryContext?.media, target);
  collectFromBag(source.currentMessage?.media, target);
  collectFromBag(source.currentMessage?.attachments, target);
  collectFromBag(source.metadata?.mediaPaths, target);
  collectFromBag(source.metadata?.mediaPath, target);
  collectFromBag(source.metadata?.originalMediaPaths, target);
}

export function extractPathsFromText(text) {
  const collected = [];
  const source = String(text || "");
  if (!source) return [];
  for (const match of source.matchAll(MEDIA_ATTACHED_RE)) {
    const inboundPath = inboundPathFromCapture(match[1]);
    if (inboundPath) pushUnique(collected, inboundPath);
  }
  for (const match of source.matchAll(INBOUND_PATH_RE)) {
    const inboundPath = inboundPathFromCapture(match[1]);
    if (inboundPath) pushUnique(collected, inboundPath);
  }
  return toAttachmentList(collected);
}

function extractPathsFromMessages(messages) {
  const collected = [];
  if (!Array.isArray(messages)) return [];
  for (const message of messages) {
    const content = message?.content ?? message?.text ?? message?.body;
    if (typeof content === "string") {
      collectFromBag(extractPathsFromText(content), collected);
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") collectFromBag(extractPathsFromText(part), collected);
        else if (part?.text) collectFromBag(extractPathsFromText(part.text), collected);
        else if (part?.path || part?.localPath) pushUnique(collected, part);
      }
    }
  }
  return toAttachmentList(collected);
}

export function collectCtxMedia(ctx, stateDir) {
  const collected = [];
  if (!ctx || typeof ctx !== "object") return [];
  collectStructuredMedia(ctx, collected);
  collectFromBag(extractPathsFromText(currentTurnText(ctx)), collected);
  collectFromBag(extractPromptMedia(ctx.prompt), collected);
  return remapResolved(toAttachmentList(collected), stateDir);
}

export function extractHookMedia(event, ctx, stateDir) {
  if (!event && !ctx) return [];
  const collected = [];
  collectStructuredMedia(event, collected);
  if (event && !event.mediaStagingPending) collectFromBag(event.originalMedia, collected);
  collectStructuredMedia(ctx, collected);
  collectFromBag(extractPathsFromText(currentTurnText(event)), collected);
  collectFromBag(extractPathsFromText(currentTurnText(ctx)), collected);
  const lastUser = lastUserLikeMessage(event?.messages);
  if (lastUser) collectFromBag(extractPathsFromMessages([lastUser]), collected);
  collectFromBag(extractPromptMedia(event?.prompt || ctx?.prompt || ""), collected);
  return remapResolved(toAttachmentList(collected), stateDir);
}

export function mergeAttachmentLists(...lists) {
  const collected = [];
  for (const list of lists) collectFromBag(list, collected);
  return toAttachmentList(collected);
}

export function rememberInboundMedia(sessionKey, attachments, { messageId, restoredFromCancel } = {}) {
  const key = sessionKeyOf(sessionKey);
  if (!key) return 0;
  const incoming = filterUnstaged(key, mergeAttachmentLists(attachments));
  peekInboundMedia(key);
  if (!incoming.length) return peekInboundMedia(key).length;
  const current = inboundBySession.get(key) || [];
  const retained = messageId ? current.filter((item) => item.messageId !== messageId) : current;
  const next = mergeAttachmentLists(retained, incoming).slice(-10).map((item) => {
    const previous = retained.find((candidate) => candidate.localPath === item.localPath);
    const fromIncoming = incoming.some((candidate) => candidate.localPath === item.localPath);
    return {
      ...item,
      messageId: previous?.messageId || messageId,
      rememberedAt: previous?.rememberedAt || Date.now(),
      restoredFromCancel: restoredFromCancel
        ? true
        : (fromIncoming ? false : Boolean(previous?.restoredFromCancel)),
    };
  });
  inboundBySession.set(key, next);
  return next.length;
}

export function rememberInboundMediaFor(source, attachments, options) {
  let count = 0;
  for (const key of mediaScopeCandidates(source)) {
    count = Math.max(count, rememberInboundMedia(key, attachments, options));
  }
  return count;
}

export function peekInboundMedia(sessionKey, now = Date.now()) {
  const key = sessionKeyOf(sessionKey);
  const items = inboundBySession.get(key) || [];
  const fresh = items.filter((item) => now - Number(item.rememberedAt || 0) < INBOUND_BUFFER_TTL_MS);
  if (key && fresh.length !== items.length) {
    if (fresh.length) inboundBySession.set(key, fresh);
    else inboundBySession.delete(key);
  }
  return toAttachmentList(fresh);
}

export function consumeInboundMedia(sessionKey) {
  const key = sessionKeyOf(sessionKey);
  const items = peekInboundMedia(key);
  if (key) inboundBySession.delete(key);
  return items;
}

export function peekInboundMediaFor(source, now = Date.now()) {
  return mergeAttachmentLists(
    ...mediaScopeCandidates(source).map((key) => peekInboundMedia(key, now)),
  );
}

export function consumeInboundMediaFor(source) {
  const collected = [];
  for (const key of mediaScopeCandidates(source)) {
    collected.push(...consumeInboundMedia(key));
  }
  return mergeAttachmentLists(collected);
}

export function dropCancelRestoredInboundFor(source, now = Date.now()) {
  let dropped = 0;
  for (const key of mediaScopeCandidates(source)) {
    dropped += dropCancelRestoredInbound(key, now);
  }
  return dropped;
}

export function rememberStagedPathsFor(source, attachments, options) {
  for (const key of mediaScopeCandidates(source)) {
    rememberStagedPaths(key, attachments, options);
  }
}

export function forgetStagedPathsFor(source, attachments) {
  for (const key of mediaScopeCandidates(source)) {
    forgetStagedPaths(key, attachments);
  }
}

export function clearInboundMediaFor(source) {
  if (!source) {
    clearInboundMedia();
    return;
  }
  for (const key of mediaScopeCandidates(source)) {
    clearInboundMedia(key);
  }
}

export function rememberStagedPaths(sessionKey, attachments, { merge = false } = {}) {
  const key = sessionKeyOf(sessionKey);
  if (!key) return;
  const next = merge ? new Set(stagedPathsBySession.get(key) || []) : new Set();
  for (const item of attachments || []) {
    const localPath = asLocalPath(item);
    if (!localPath) continue;
    for (const identity of inboundIdentityKeys(localPath, asFileName(item))) next.add(identity);
  }
  stagedPathsBySession.set(key, next);
}

/**
 * 明确取消后的下一轮用户消息到来时调用：丢掉 cancel 回灌的旧单附件，
 * 本轮新发的图片 / 文件不受影响。同轮「cancel 再 prepare」的改稿不会走到这里。
 */
export function dropCancelRestoredInbound(sessionKey, now = Date.now()) {
  const key = sessionKeyOf(sessionKey);
  if (!key) return 0;
  peekInboundMedia(key, now);
  const items = inboundBySession.get(key) || [];
  const kept = items.filter((item) => !item.restoredFromCancel);
  if (kept.length === items.length) return 0;
  if (kept.length) inboundBySession.set(key, kept);
  else inboundBySession.delete(key);
  return items.length - kept.length;
}

/**
 * 撤回「已随单暂存」标记。`cancel` 之后这些附件的 staging 副本已被删除，
 * 必须让它们重新可被 `rememberInboundMedia` 收下，同轮改稿后的新单才不会少附件。
 */
export function forgetStagedPaths(sessionKey, attachments) {
  const key = sessionKeyOf(sessionKey);
  const staged = key ? stagedPathsBySession.get(key) : null;
  if (!staged) return;
  for (const item of attachments || []) {
    const localPath = asLocalPath(item);
    if (!localPath) continue;
    for (const identity of inboundIdentityKeys(localPath, asFileName(item))) staged.delete(identity);
  }
  if (staged.size) stagedPathsBySession.set(key, staged);
  else stagedPathsBySession.delete(key);
}

export function attachmentPathKey(localPath) {
  return pathKey(localPath);
}

export function attachmentIdentityKeys(localPath, fileName) {
  const resolved = asLocalPath({ localPath, fileName }) || String(localPath || "").trim();
  if (!resolved) return [];
  return inboundIdentityKeys(resolved, fileName);
}

function isAlreadyStaged(staged, item) {
  if (!staged.size) return false;
  const localPath = asLocalPath(item) || item?.localPath;
  if (!localPath) return false;
  return inboundIdentityKeys(localPath, asFileName(item)).some((identity) => staged.has(identity));
}

function filterUnstaged(sessionKey, attachments) {
  const staged = stagedPathsBySession.get(sessionKeyOf(sessionKey)) || new Set();
  if (!staged.size) return attachments;
  return attachments.filter((item) => !isAlreadyStaged(staged, item));
}

function filterUnstagedFor(source, attachments) {
  const staged = new Set();
  for (const key of mediaScopeCandidates(source)) {
    for (const item of stagedPathsBySession.get(key) || []) staged.add(item);
  }
  if (!staged.size) return attachments;
  return attachments.filter((item) => !isAlreadyStaged(staged, item));
}

export function clearInboundMedia(sessionKey) {
  const key = sessionKeyOf(sessionKey);
  if (key) {
    inboundBySession.delete(key);
    stagedPathsBySession.delete(key);
  } else {
    inboundBySession.clear();
    stagedPathsBySession.clear();
  }
}

export function collectPrepareAttachments(ctx, paramsAttachments, stateDir) {
  return mergeAttachmentLists(
    collectCtxMedia(ctx, stateDir),
    remapResolved(peekInboundMediaFor(ctx), stateDir),
    remapResolved(paramsAttachments, stateDir),
  );
}

export function collectSubmitAttachments(ctx, paramsAttachments, stateDir) {
  return filterUnstagedFor(
    ctx,
    mergeAttachmentLists(
      collectCtxMedia(ctx, stateDir),
      remapResolved(peekInboundMediaFor(ctx), stateDir),
      remapResolved(paramsAttachments, stateDir),
    ),
  );
}

/**
 * 附件缓冲按「提交人 + OpenClaw 会话」隔离。
 * 优先 sessionId：`/new` 或自动新会话后旧图不会串进新对话；
 * 提交人必须参与，否则群聊同一 sessionKey 会把同事的图并进自己的单。
 */
export function mediaScope(source) {
  const sender = senderIdOf(source);
  const conversation = conversationOf(source);
  if (sender && conversation) return `${sender}::${conversation}`;
  return sessionKeyOf(conversation);
}

/**
 * hook 往往只有 sessionKey，工具 ctx 还有 requesterSenderId + sessionId。
 * 读取时把这些键都试一遍；裸 sessionKey 仅当其中已包含发送人（单聊）才作为候选，避免群聊串图。
 */
export function mediaScopeCandidates(source) {
  const sender = senderIdOf(source);
  const sessionId = sessionIdOf(source);
  const sessionKey = sessionKeyFieldOf(source);
  const keys = [];
  pushScopeKey(keys, mediaScope(source));
  if (sender && sessionId) pushScopeKey(keys, `${sender}::${sessionId}`);
  if (sender && sessionKey) pushScopeKey(keys, `${sender}::${sessionKey}`);
  if (senderEmbeddedInSessionKey(sender, sessionKey)) pushScopeKey(keys, sessionKey);
  return keys;
}
