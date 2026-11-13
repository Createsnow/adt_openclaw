import { statSync } from "node:fs";
import path from "node:path";

/**
 * 只负责从 hook 事件 / 工具 ctx 里找出本轮企微 inbound 附件的本地路径，并算去重键。
 * 附件一经发现就由 inbox.mjs 落到库里的 inbox（不在进程内缓冲）。
 */
const MEDIA_ATTACHED_RE = /\[media attached:\s*([^\]]+)\]/gi;
const INBOUND_PATH_RE = /(?:^|[\s"'`=])((?:[A-Za-z]:)?[\\/][^\s"'`\]]+?[\\/]media[\\/]+inbound[\\/]+[^\s"'`\]]+)/g;
const MEDIA_URI_RE = /^media:\/\/inbound\/(.+)$/i;

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

/**
 * 通道 inbound 常用 SenderId / from.userid，工具 ctx 才保证有 requesterSenderId。
 * 单聊 hook 有时只有 sessionKey（`…:wecom:direct:<发送人小写>`），此时从键尾取发送人；
 * 身份码按小写算，所以与工具 ctx 的发送人对得上。群聊键不含发送人，取不到就不收。
 */
export function senderIdOf(source) {
  if (!source || typeof source !== "object") return "";
  const from = source.from;
  const fromId = typeof from === "string"
    ? from
    : (from && typeof from === "object"
      ? firstNonEmpty(from.userid, from.userId, from.UserId, from.id, from.senderId, from.SenderId)
      : "");
  const direct = /:direct:([^:]+)$/i.exec(firstNonEmpty(source.sessionKey, source.SessionKey));
  return firstNonEmpty(
    source.requesterSenderId,
    source.SenderId,
    source.senderId,
    source.senderID,
    fromId,
    direct?.[1],
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

export function attachmentIdentityKeys(localPath, fileName) {
  const resolved = asLocalPath({ localPath, fileName }) || String(localPath || "").trim();
  if (!resolved) return [];
  return inboundIdentityKeys(resolved, fileName);
}

/** 工具调用时本轮能看到的 inbound：工具 ctx 里的媒体 + 模型显式传的 attachments。 */
export function collectToolMedia(ctx, paramsAttachments, stateDir) {
  return mergeAttachmentLists(collectCtxMedia(ctx, stateDir), remapResolved(paramsAttachments, stateDir));
}
