import assert from "node:assert/strict";
import test from "node:test";
import { maskFileName, maskFileNames, redactPayload } from "../src/log-redact.mjs";

test("文件名只留后缀与类别，不留原名", () => {
  assert.equal(maskFileName("2026年报销单.pdf"), "***.pdf（文件类型）");
  assert.equal(maskFileName("张三的工位截图.PNG"), "***.png（图片类型）");
  assert.equal(maskFileName("/home/xa/media/inbound/身份证.jpg"), "***.jpg（图片类型）");
  assert.equal(maskFileName("没有后缀"), "***（文件类型）");
  assert.equal(maskFileName(""), "***（文件类型）");
});

test("附件列表整体掩码，空列表给 (none)", () => {
  assert.equal(
    maskFileNames([{ fileName: "合同.docx" }, { localPath: "/x/y/截图.png" }]),
    "***.docx（文件类型）, ***.png（图片类型）",
  );
  assert.equal(maskFileNames([]), "(none)");
  assert.equal(maskFileNames(undefined), "(none)");
});

test("OA 请求体里的附件 base64 不进日志，但保留结构与数量", () => {
  const payload = {
    mainData: [
      { fieldName: "wtxqmskftp", fieldValue: "问题描述<img src=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg\">尾部" },
      {
        fieldName: "scfj",
        fieldValue: [
          { filePath: "JVBERi0xLjQKJeLjz9MK", fileName: "报销单.pdf" },
          { filePath: "UEsDBBQABgAIAAAAIQ", fileName: "明细.xlsx" },
        ],
      },
    ],
  };
  const redacted = redactPayload(payload);

  const description = redacted.mainData[0].fieldValue;
  assert.ok(description.includes("data:image/png;base64,***（图片类型）"));
  assert.ok(description.includes("问题描述"), "非附件正文要保留，排障还得靠它");
  assert.ok(!description.includes("iVBORw0KGgo"));

  assert.deepEqual(redacted.mainData[1].fieldValue, [
    { fileName: "***.pdf（文件类型）", filePath: "***" },
    { fileName: "***.xlsx（文件类型）", filePath: "***" },
  ]);

  const serialized = JSON.stringify(redacted);
  assert.ok(!serialized.includes("JVBERi0xLjQ"));
  assert.ok(!serialized.includes("报销单"));
});

test("字符串化的 scfj fieldValue 同样脱敏，且仍是 JSON 字符串", () => {
  const payload = {
    mainData: [{
      fieldName: "scfj",
      fieldValue: JSON.stringify([
        { filePath: "JVBERi0xLjQKJeLjz9MK", fileName: "报销单.pdf" },
      ]),
    }],
  };
  const redacted = redactPayload(payload);
  assert.equal(typeof redacted.mainData[0].fieldValue, "string");
  assert.deepEqual(JSON.parse(redacted.mainData[0].fieldValue), [
    { fileName: "***.pdf（文件类型）", filePath: "***" },
  ]);
  assert.ok(!redacted.mainData[0].fieldValue.includes("JVBERi0"));
  assert.ok(!redacted.mainData[0].fieldValue.includes("报销单"));
});

test("OA errMsg 里夹带的 filePath 也会脱敏", () => {
  const redacted = redactPayload({
    code: "PARAM_ERROR",
    errMsg: { scfj: "生成附件失败,fileValue:[{\"filePath\":\"JVBERi0xLjQK\",\"fileName\":\"报销单.pdf\"}]" },
  });
  assert.equal(redacted.code, "PARAM_ERROR");
  assert.match(redacted.errMsg.scfj, /生成附件失败/);
  assert.match(redacted.errMsg.scfj, /"filePath":"\*\*\*"/);
  assert.ok(!redacted.errMsg.scfj.includes("JVBERi0"));
  assert.ok(!redacted.errMsg.scfj.includes("报销单"));
});

test("掩码不改动原对象", () => {
  const payload = { mainData: [{ fieldValue: [{ filePath: "AAAA", fileName: "a.pdf" }] }] };
  redactPayload(payload);
  assert.equal(payload.mainData[0].fieldValue[0].filePath, "AAAA");
  assert.equal(payload.mainData[0].fieldValue[0].fileName, "a.pdf");
});
