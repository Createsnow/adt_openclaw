import { copyFile, mkdir, readFile, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import { embedImage } from "./image-embed.mjs";
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

/** 校验并定位一个 inbound 文件：必须在 media/inbound 下（realpath），是普通文件。不合格返回 null。 */
export async function resolveInboundFile(stateDir, item) {
  const roots = await resolveInboundRoots(stateDir);
  if (!roots.length) return null;
  try {
    const source = await realpath(String(item?.localPath || ""));
    if (!roots.some((root) => isWithin(source, root))) return null;
    const info = await stat(source);
    if (!info.isFile() || info.size <= 0) return null;
    return { source, size: info.size, fileName: sanitizeFileName(item?.fileName || path.basename(source)) };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EINVAL") return null;
    throw error;
  }
}

function stagingDir(stateDir, dirName) {
  return path.join(stagingPaths(stateDir).stagingRoot, path.basename(String(dirName)));
}

export function storedNameFor(index, fileName) {
  return `${String(index + 1).padStart(2, "0")}-${fileName}`;
}

/** 把 inbound 原件拷进 staging 下的某个目录。 */
export async function copyIntoStaging(stateDir, dirName, source, storedName) {
  const dir = stagingDir(stateDir, dirName);
  await mkdir(dir, { recursive: true });
  await copyFile(source, path.join(dir, storedName));
}

/**
 * 把一批已落盘附件从一个 staging 目录搬到另一个（inbox → 工单、旧单 → 改稿后的新单），按目标序号重命名。
 * 源文件已不在的跳过。返回目标侧的附件清单。
 */
export async function moveStagedFiles(stateDir, fromDirName, toDirName, items, startIndex = 0) {
  if (!items?.length) return [];
  const toDir = stagingDir(stateDir, toDirName);
  await mkdir(toDir, { recursive: true });
  const moved = [];
  for (const item of items) {
    const storedName = storedNameFor(startIndex + moved.length, sanitizeFileName(item.fileName));
    try {
      await rename(path.join(stagingDir(stateDir, fromDirName), path.basename(String(item.storedName))), path.join(toDir, storedName));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    moved.push({ storedName, fileName: item.fileName, size: item.size, sourcePath: item.sourcePath || "" });
  }
  return moved;
}

export function limitExceeded() {
  return new OAClientError("Attachments exceed the configured limit", { code: "ATTACHMENT_LIMIT_EXCEEDED" });
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
