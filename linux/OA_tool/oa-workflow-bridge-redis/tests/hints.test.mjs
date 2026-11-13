import assert from "node:assert/strict";
import test from "node:test";
import { attachmentReceiptHint, hintZhFor, personStatusHintZh, submittedPreview, withHintZh } from "../src/hints.mjs";

test("附件回执按图片和文档分报，不写合计", () => {
  assert.equal(attachmentReceiptHint({ imageCount: 1, documentCount: 0 }), "📎 已收到 1份图片");
  assert.equal(attachmentReceiptHint({ imageCount: 0, documentCount: 1 }), "📎 已收到 1份文档");
  assert.equal(attachmentReceiptHint({ imageCount: 2, documentCount: 1 }), "📎 已收到 2份图片、1份文档");
  assert.equal(attachmentReceiptHint({ imageCount: 0, documentCount: 0 }), "");
});

test("ATTACHED / BUFFERED 的 hintZh 就是附件回执行", () => {
  assert.equal(hintZhFor({ code: "ATTACHED", imageCount: 1, documentCount: 0 }), "📎 已收到 1份图片");
  assert.equal(hintZhFor({ code: "BUFFERED", imageCount: 1, documentCount: 1 }), "📎 已收到 1份图片、1份文档");
});

test("无模板失败码给出可原样发给员工的 hintZh", () => {
  assert.match(hintZhFor({ code: "NO_NEW_ATTACHMENT" }), /没有检测到新文件/);
  assert.match(hintZhFor({ code: "ATTACHMENT_LIMIT_EXCEEDED" }), /10MB/);
  assert.match(hintZhFor({ code: "OA_IDENTITY_NOT_FOUND" }), /还不能提交到 OA/);
  assert.match(hintZhFor({ code: "WECOM_IDENTITY_INVALID_SENDER" }), /还不能提交到 OA/);
  assert.match(hintZhFor({ code: "SENDER_MISMATCH" }), /原提交人/);
  assert.match(hintZhFor({ code: "NOT_FOUND" }), /没有找到这张确认单/);
  assert.match(hintZhFor({ code: "REDIS_UNAVAILABLE" }), /请稍后重试/);
  assert.match(hintZhFor({ code: "WORKFLOW_NOT_CREATEABLE" }), /请稍后重试/);
  assert.match(hintZhFor({ code: "PREFLIGHT_FAILED" }), /请稍后重试/);
  assert.match(hintZhFor({ code: "PARAM_ERROR" }), /OA 拒绝了这张单/);
  assert.match(hintZhFor({ code: "OA_CREATE_REJECTED" }), /不要自动再提交/);
  assert.match(hintZhFor({ code: "HTTP_502" }), /人工核对/);
  assert.match(hintZhFor({ code: "HTTP_400" }), /OA 拒绝了这张单/);
  assert.match(hintZhFor({ code: "SYSTEM_INNER_ERROR" }), /人工核对/);
  assert.match(hintZhFor({ code: "MISSING_REQUEST_ID" }), /人工核对/);
  assert.match(hintZhFor({ code: "expired" }), /已过期/);
  assert.match(hintZhFor({ code: "failed" }), /OA 拒绝了这张单/);
  assert.match(hintZhFor({ code: "SYSTEM_NOT_ALLOWED" }), /类型和所属系统对不上/);
  assert.match(hintZhFor({ code: "HANDLER_NOT_CONFIGURED" }), /处理人/);
  assert.match(hintZhFor({ code: "ATTACHMENT_FIELD_NOT_CONFIGURED" }), /文档附件字段/);
  assert.match(hintZhFor({ code: "MISSING_CONFIRMATION_ID" }), /确认号/);
  assert.match(hintZhFor({ code: "ALREADY_SUBMITTED", requestId: "1504371" }), /1504371/);
  assert.match(hintZhFor({ code: "ALREADY_SUBMITTED" }), /已经提交过/);
});

test("withHintZh 不覆盖已有 hintZh，也不给未知 code 硬塞空字段", () => {
  assert.equal(withHintZh({ code: "SUBMITTED", hintZh: "自定义" }).hintZh, "自定义");
  assert.equal(withHintZh({ code: "SUBMITTED" }).hintZh, undefined);
  assert.equal(withHintZh({ ok: true, code: "AWAITING_CONFIRMATION" }).hintZh, undefined);
});

test("查进度无待确认：空记录与已提交条数+最近5条", () => {
  assert.match(personStatusHintZh({ pending: null, submittedCount: 0, submitted: [] }), /没有待确认或已提交/);
  assert.equal(personStatusHintZh({ pending: { confirmationId: "OA-1" } }), "");
  const preview = submittedPreview([
    { status: "submitted", requestId: "1504378" },
    { status: "cancelled", requestId: "1" },
    { status: "submitted", requestId: "1504377" },
    { status: "submitted", requestId: "1504376" },
    { status: "submitted", requestId: "1504375" },
    { status: "submitted", requestId: "1504374" },
    { status: "submitted", requestId: "1504373" },
    { status: "submitted", requestId: "IT-x" },
  ]);
  assert.equal(preview.submittedCount, 6);
  assert.equal(preview.submitted.length, 5);
  assert.equal(preview.submitted[0].requestId, "1504378");
  const text = personStatusHintZh({ pending: null, ...preview });
  assert.match(text, /已提交 6 条，最近 5 条：/);
  assert.match(text, /1504378/);
  assert.doesNotMatch(text, /处理人/);
  assert.doesNotMatch(text, /1504373/);
});
