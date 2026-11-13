import jpeg from "jpeg-js";
import pngjs from "pngjs";
import { detectImageMime, mimeFromFileName } from "./media-kind.mjs";

const PNG = pngjs.PNG;
const MAX_EDGE = 1280;
const JPEG_QUALITIES = [72, 50, 40];
const MAX_OUTPUT_BYTES = 400 * 1024;

function decodeImage(bytes, mime) {
  if (mime === "image/png") {
    const png = PNG.sync.read(bytes);
    return { width: png.width, height: png.height, data: Buffer.from(png.data) };
  }
  if (mime === "image/jpeg") {
    const decoded = jpeg.decode(bytes, { maxMemoryUsageInMB: 64 });
    return { width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) };
  }
  return null;
}

function resizeRgba(image, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  if (!Number.isFinite(scale) || scale >= 1) return image;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const srcY = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const srcX = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      image.data.copy(data, (y * width + x) * 4, (srcY * image.width + srcX) * 4, (srcY * image.width + srcX) * 4 + 4);
    }
  }
  return { width, height, data };
}

function encodeJpeg(image, quality) {
  return Buffer.from(jpeg.encode(image, quality).data);
}

function toDataUri(mime, bytes) {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

export function compressImage(bytes, fileName) {
  const original = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const detectedMime = detectImageMime(original) || mimeFromFileName(fileName);
  try {
    const decoded = decodeImage(original, detectedMime === "image/jpg" ? "image/jpeg" : detectedMime);
    if (!decoded?.width || !decoded?.height) {
      return { mime: detectedMime, bytes: original, compressed: false };
    }
    const resized = resizeRgba(decoded, MAX_EDGE);
    const resizedChanged = resized.width !== decoded.width || resized.height !== decoded.height;
    let best = encodeJpeg(resized, JPEG_QUALITIES[0]);
    for (const quality of JPEG_QUALITIES.slice(1)) {
      if (best.length <= MAX_OUTPUT_BYTES) break;
      const next = encodeJpeg(resized, quality);
      if (next.length < best.length) best = next;
    }
    if (!resizedChanged && detectedMime === "image/jpeg" && original.length <= best.length) {
      return { mime: "image/jpeg", bytes: original, compressed: false };
    }
    return { mime: "image/jpeg", bytes: best, compressed: true };
  } catch {
    return { mime: detectedMime, bytes: original, compressed: false };
  }
}

export function embedImage(fileName, bytes) {
  const original = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const compressed = compressImage(original, fileName);
  return {
    fileName: String(fileName || "image.jpg"),
    dataUri: toDataUri(compressed.mime || "image/jpeg", compressed.bytes),
    compressed: compressed.compressed,
    encodedBytes: compressed.bytes.length,
  };
}
