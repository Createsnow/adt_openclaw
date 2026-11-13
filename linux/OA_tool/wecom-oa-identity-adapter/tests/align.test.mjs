import assert from "node:assert/strict";
import test from "node:test";
import { alignWorkcode } from "../src/align.mjs";

test("相等通过", () => {
  assert.equal(alignWorkcode({ userid: "57999", extattrJobNumber: "57999" }), "57999");
});

test("无扩展属性时把 userid 当工号", () => {
  assert.equal(alignWorkcode({ userid: "57999", extattrJobNumber: "" }), "57999");
});

test("不相等 fail-closed", () => {
  assert.throws(
    () => alignWorkcode({ userid: "57999", extattrJobNumber: "88001" }),
    (error) => error.code === "WECOM_IDENTITY_ALIGN_MISMATCH",
  );
});
