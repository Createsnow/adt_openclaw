import assert from "node:assert/strict";
import test from "node:test";
import { loadBridgeConfig, parseSystems, requireIsnextflow } from "../src/config.mjs";

test('isnextflow 只接受字符串 "0" 或 "1"', () => {
  assert.equal(requireIsnextflow("0"), "0");
  assert.equal(requireIsnextflow("1"), "1");
  assert.equal(requireIsnextflow(" 1 "), "1");
  assert.throws(() => requireIsnextflow(), /isnextflow must be "0" or "1"/);
  assert.throws(() => requireIsnextflow(""), /isnextflow must be "0" or "1"/);
  assert.throws(() => requireIsnextflow("2"), /isnextflow must be "0" or "1"/);
  assert.throws(() => requireIsnextflow(true), /isnextflow must be "0" or "1"/);
});

test("仓库 bridge-config.json：isnextflow 为 0，MySQL 只写连接参数不写密码", async () => {
  const config = await loadBridgeConfig();
  assert.equal(config.isnextflow, "0");
  assert.deepEqual(Object.keys(config.mysql).sort(), ["database", "host", "port", "user"]);
  assert.equal(config.mysql.port, 3306);
  assert.equal(config.inboxTtlMinutes, 30);
  assert.equal(config.identity.adapter, "on");
});

test("systems.json 校验：选项 ID 唯一、处理人是数字串、类型必须是三类之一", () => {
  const ok = parseSystems({ 其他: { optionId: 17, handlers: "4280", types: ["运维支持"] } });
  assert.equal(ok.options.get("其他"), 17);
  assert.equal(ok.handlers.get("其他"), "4280");
  assert.equal(ok.typeSystems.get("运维支持").has("其他"), true);
  assert.equal(ok.typeSystems.get("权限申请").has("其他"), false);
  assert.throws(() => parseSystems({
    A: { optionId: 1, handlers: "1", types: ["运维支持"] },
    B: { optionId: 1, handlers: "2", types: ["运维支持"] },
  }), /unique/);
  assert.throws(() => parseSystems({ A: { optionId: 1, handlers: "张三", types: ["运维支持"] } }), /handlers/);
  assert.throws(() => parseSystems({ A: { optionId: 1, handlers: "1", types: ["报销"] } }), /types/);
});
