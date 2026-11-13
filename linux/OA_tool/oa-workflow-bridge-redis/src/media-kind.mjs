const IMAGE_NAME_RE = /\.(png|jpe?g|gif|webp|bmp|tif{1,2}|heic|heif)$/i;

const MIME_BY_EXT = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
});

export function looksLikeImageName(fileName) {
  return IMAGE_NAME_RE.test(String(fileName || ""));
}

export function detectImageMime(bytes) {
  if (!bytes || bytes.length < 12) return "";
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) return "image/bmp";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "";
}

export function mimeFromFileName(fileName) {
  const ext = String(fileName || "").toLowerCase().split(".").pop();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

export function isImageAttachment(fileName, bytes) {
  return Boolean(detectImageMime(bytes) || looksLikeImageName(fileName));
}
