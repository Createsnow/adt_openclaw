import assert from "node:assert/strict";
import test from "node:test";
import { createIdentityCache } from "../src/cache.mjs";

const MAPPING_CODE = "aaaaaaaaaaaaaaaaaaaaaaaa";

test("redis 缺失时 setIdmap 打警告且不抛错", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const cache = createIdentityCache({ redis: null, keyPrefix: "oa-workflow-bridge" });
    await cache.setIdmap(MAPPING_CODE, "30538");
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.some((line) => /redis is not configured/i.test(line)), true);
});
