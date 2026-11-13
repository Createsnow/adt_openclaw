import path from "node:path";
import { looksLikeImageName } from "./media-kind.mjs";

const DATA_URI_PAYLOAD = /(data:[\w.+-]+\/[\w.+-]+;base64,)[A-Za-z0-9+/=]+/g;
const LONG_BASE64 = /[A-Za-z0-9+/]{80,}={0,2}/g;

/** `报销单.pdf` → `***.pdf（文件类型）`，只留后缀与类别，不留原文件名。 */
export function maskFileName(value) {
  const name = path.basename(String(value || ""));
  const ext = path.extname(name).toLowerCase();
  return `***${ext}（${looksLikeImageName(name) ? "图片类型" : "文件类型"}）`;
}

export function maskFileNames(items) {
  const names = (items || []).map((item) => maskFileName(item?.fileName || item?.localPath || item?.storedName));
  return names.join(", ") || "(none)";
}

function redactAttachmentJsonString(value) {
  const text = String(value).trim();
  if (!text.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.some((item) => item && typeof item.filePath === "string")) {
      return null;
    }
    return JSON.stringify(redactPayload(parsed));
  } catch {
    return null;
  }
}

function redactFreeText(value) {
  return String(value)
    .replace(DATA_URI_PAYLOAD, (_match, prefix) => `${prefix}***（图片类型）`)
    .replace(/("filePath"\s*:\s*")[^"]*(")/g, "$1***$2")
    .replace(/("fileName"\s*:\s*")([^"]*)(")/g, (_match, prefix, name, suffix) => `${prefix}${maskFileName(name)}${suffix}`)
    .replace(LONG_BASE64, "***");
}

/**
 * 打日志前抹掉附件正文：`{ filePath, fileName }` 里的 base64、字符串化的 scfj JSON，以及描述 HTML 内嵌的 data URI。
 * 结构与字段名保留，方便排障时仍能看出发了几个附件、什么类型。
 */
export function redactPayload(value) {
  if (typeof value === "string") {
    const attachments = redactAttachmentJsonString(value);
    if (attachments !== null) return attachments;
    return redactFreeText(value);
  }
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value && typeof value === "object") {
    if (typeof value.filePath === "string") {
      return { fileName: maskFileName(value.fileName), filePath: "***" };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactPayload(item)]));
  }
  return value;
}

