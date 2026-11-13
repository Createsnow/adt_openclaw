import { copyFile, mkdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { embedImage } from "./image-embed.mjs";
import { attachmentIdentityKeys } from "./inbound-media.mjs";
import { maskFileName } from "./log-redact.mjs";
import { isImageAttachment, looksLikeImageName } from "./media-kind.mjs";
import { OAClientError } from "./oa-client.mjs";
import { stagingPaths } from "./store.mjs";

function logEncode(message) {
  if (process.env.NODE_TEST_CONTEXT) return;
  console.log(message);
}

export const MAX_STAGED_ATTACHMENTS = 10;

function sanitizeFileName(value) {
  const base = path.basename(String(value || "attachment.bin")).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  return (base || "attachment.bin").slice(0, 180);
}

function isWithin(candidate, root) {
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

async function resolveInboundRoots(stateDir) {
  const candidates = [
    path.join(stateDir, "media", "inbound"),
    path.join(stateDir, "workspace", "media", "inbound"),
  ];
  const roots = [];
  for (const candidate of candidates) {
    try {
      roots.push(await realpath(candidate));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return roots;
}

export async function stageAttachments({
  stateDir,
  confirmationId,
  stageDirName,
  attachments,
  config,
  startIndex = 0,
  existingBytes = 0,
}) {
  if (!attachments?.length) return [];
  if (!Array.isArray(attachments)) throw new Error("At most 10 attachments are allowed");
  const inboundRoots = await resolveInboundRoots(stateDir);
  if (!inboundRoots.length) return [];
  const resolved = [];
  const seen = new Set();
  for (const item of attachments) {
    try {
      const source = await realpath(String(item?.localPath || ""));
      if (!inboundRoots.some((root) => isWithin(source, root))) continue;
      const info = await stat(source);
      if (!info.isFile()) continue;
      if (info.size <= 0 || info.size > config.maxAttachmentBytes) {
        throw new OAClientError("Attachment exceeds the configured per-file limit", { code: "ATTACHMENT_LIMIT_EXCEEDED" });
      }
      const fileName = sanitizeFileName(item?.fileName || path.basename(source));
      const identities = [`realpath:${source}`, ...attachmentIdentityKeys(source, fileName)];
      if (identities.some((key) => seen.has(key))) continue;
      for (const key of identities) seen.add(key);
      resolved.push({
        source,
        info,
        fileName,
      });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EINVAL") continue;
      throw error;
    }
  }
  if (!resolved.length) return [];
  if (startIndex + resolved.length > MAX_STAGED_ATTACHMENTS) {
    throw new OAClientError(`At most ${MAX_STAGED_ATTACHMENTS} attachments are allowed`, { code: "ATTACHMENT_LIMIT_EXCEEDED" });
  }
  const { stagingRoot } = stagingPaths(stateDir);
  const stageDir = path.join(stagingRoot, stageDirName || confirmationId);
  await mkdir(stageDir, { recursive: true });
  const staged = [];
  let totalBytes = existingBytes;
  const copied = [];
  try {
    for (let index = 0; index < resolved.length; index += 1) {
      const item = resolved[index];
      totalBytes += item.info.size;
      if (totalBytes > config.maxTotalAttachmentBytes) {
        throw new OAClientError("Attachments exceed the configured total limit", { code: "ATTACHMENT_LIMIT_EXCEEDED" });
      }
      const storedName = `${String(startIndex + index + 1).padStart(2, "0")}-${item.fileName}`;
      const destination = path.join(stageDir, storedName);
      await copyFile(item.source, destination);
      copied.push(destination);
      // sourcePath 只在本机与工单记录内部使用：cancel 后要靠它把附件回灌进会话缓冲，
      // 否则「确认前改稿 = cancel + prepare」会把上一轮已暂存的图片连同 staging 目录一起丢掉。
      staged.push({ storedName, fileName: item.fileName, size: item.info.size, sourcePath: item.source });
    }
  } catch (error) {
    await Promise.all(copied.map((item) => unlink(item).catch(() => {})));
    throw error;
  }
  return staged;
}

/**
 * 把会话 inbox 目录里已落盘的附件搬进本张单的 staging 目录。
 * 源 inbound 文件此时可能已被通道清理，所以只能从 inbox 副本复制，不能回头去读 `media/inbound`。
 */
export async function adoptStagedFiles({
  stateDir,
  fromDirName,
  toDirName,
  items,
  config,
  startIndex = 0,
  existingBytes = 0,
}) {
  if (!items?.length) return [];
  if (startIndex + items.length > MAX_STAGED_ATTACHMENTS) {
    throw new OAClientError(`At most ${MAX_STAGED_ATTACHMENTS} attachments are allowed`, { code: "ATTACHMENT_LIMIT_EXCEEDED" });
  }
  const { stagingRoot } = stagingPaths(stateDir);
  const fromDir = path.join(stagingRoot, fromDirName);
  const toDir = path.join(stagingRoot, toDirName);
  await mkdir(toDir, { recursive: true });
  const staged = [];
  const copied = [];
  let totalBytes = existingBytes;
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const fileName = sanitizeFileName(item?.fileName);
      const source = path.join(fromDir, path.basename(String(item?.storedName || "")));
      let info;
      try {
        info = await stat(source);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (!info.isFile()) continue;
      totalBytes += info.size;
      if (totalBytes > config.maxTotalAttachmentBytes) {
        throw new OAClientError("Attachments exceed the configured total limit", { code: "ATTACHMENT_LIMIT_EXCEEDED" });
      }
      const storedName = `${String(startIndex + staged.length + 1).padStart(2, "0")}-${fileName}`;
      const destination = path.join(toDir, storedName);
      await copyFile(source, destination);
      copied.push(destination);
      staged.push({ storedName, fileName, size: info.size, sourcePath: item?.sourcePath || "" });
    }
  } catch (error) {
    await Promise.all(copied.map((entry) => unlink(entry).catch(() => {})));
    throw error;
  }
  return staged;
}

/** 回执用的附件计数。这里只看文件名，真正的图片/文档分流在提交前按文件头判定。 */
export function summarizeStaged(staged = []) {
  let imageCount = 0;
  for (const item of staged) {
    if (looksLikeImageName(item?.fileName)) imageCount += 1;
  }
  return {
    attachmentCount: staged.length,
    imageCount,
    documentCount: staged.length - imageCount,
  };
}

export function stagedBytes(staged = []) {
  return staged.reduce((sum, item) => sum + Number(item?.size || 0), 0);
}

export async function encodeStagedAttachments({ stateDir, confirmationId, staged }) {
  const started = Date.now();
  if (!staged?.length) {
    logEncode(`[oa-workflow-bridge] encodeStagedAttachments images=0 documents=0 elapsedMs=${Date.now() - started}`);
    return { images: [], documents: [] };
  }
  const { stagingRoot } = stagingPaths(stateDir);
  const stageDir = path.join(stagingRoot, confirmationId);
  const images = [];
  const documents = [];
  for (const item of staged) {
    const itemStarted = Date.now();
    try {
      const bytes = await readFile(path.join(stageDir, item.storedName));
      if (isImageAttachment(item.fileName, bytes)) {
        const image = embedImage(item.fileName, bytes);
        images.push({ fileName: image.fileName, dataUri: image.dataUri });
        logEncode(
          `[oa-workflow-bridge] encode image ${maskFileName(item.fileName)} originalBytes=${bytes.length} encodedBytes=${image.encodedBytes} compressed=${image.compressed} elapsedMs=${Date.now() - itemStarted}`,
        );
      } else {
        documents.push({ filePath: `base64:${bytes.toString("base64")}`, fileName: item.fileName });
        logEncode(
          `[oa-workflow-bridge] encode document ${maskFileName(item.fileName)} originalBytes=${bytes.length} elapsedMs=${Date.now() - itemStarted}`,
        );
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new OAClientError("OA confirmation attachments are missing from local staging", { code: "STAGING_MISSING" });
      }
      throw error;
    }
  }
  logEncode(
    `[oa-workflow-bridge] encodeStagedAttachments images=${images.length} documents=${documents.length} elapsedMs=${Date.now() - started}`,
  );
  return { images, documents };
}
