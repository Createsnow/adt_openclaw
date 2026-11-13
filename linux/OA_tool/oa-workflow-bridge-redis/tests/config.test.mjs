import assert from "node:assert/strict";
import test from "node:test";
import { loadBridgeConfig, requireIsnextflow } from "../src/config.mjs";

test('isnextflow 只接受字符串 "0" 或 "1"', () => {
  assert.equal(requireIsnextflow("0"), "0");
  assert.equal(requireIsnextflow("1"), "1");
  assert.equal(requireIsnextflow(" 1 "), "1");
  assert.throws(() => requireIsnextflow(), /isnextflow must be "0" or "1"/);
  assert.throws(() => requireIsnextflow(""), /isnextflow must be "0" or "1"/);
  assert.throws(() => requireIsnextflow("2"), /isnextflow must be "0" or "1"/);
  assert.throws(() => requireIsnextflow(true), /isnextflow must be "0" or "1"/);
});

test("仓库样例 bridge-config.json 现网 isnextflow 为 0", async () => {
  const config = await loadBridgeConfig();
  assert.equal(config.isnextflow, "0");
  assert.equal(config.redis.url, "");
});
