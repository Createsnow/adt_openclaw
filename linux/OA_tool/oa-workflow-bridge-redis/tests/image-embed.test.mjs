import assert from "node:assert/strict";
import test from "node:test";
import { compressImage, embedImage } from "../src/image-embed.mjs";
import { isImageAttachment, looksLikeImageName } from "../src/media-kind.mjs";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("按扩展名和魔数识别图片与文档", () => {
  assert.equal(looksLikeImageName("现场截图.png"), true);
  assert.equal(looksLikeImageName("诊断日志.txt"), false);
  assert.equal(isImageAttachment("shot.png", Buffer.from("not-a-real-png")), true);
  assert.equal(isImageAttachment("log.txt", Buffer.from("plain")), false);
  assert.equal(isImageAttachment("no-ext", PNG_1X1), true);
});

test("可解码 PNG 压缩为 JPEG 再转 data URI", () => {
  const compressed = compressImage(PNG_1X1, "dot.png");
  assert.equal(compressed.mime, "image/jpeg");
  assert.equal(compressed.compressed, true);
  const embedded = embedImage("dot.png", PNG_1X1);
  assert.match(embedded.dataUri, /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/);
  assert.equal(embedded.fileName, "dot.png");
  assert.equal(typeof embedded.encodedBytes, "number");
  assert.ok(embedded.encodedBytes > 0);
});

test("无法解码的图片回退为原字节 data URI", () => {
  const embedded = embedImage("坏图.png", Buffer.from("image-auto"));
  assert.match(embedded.dataUri, /^data:image\/png;base64,/);
  assert.equal(embedded.compressed, false);
  assert.equal(embedded.dataUri.endsWith(Buffer.from("image-auto").toString("base64")), true);
});
