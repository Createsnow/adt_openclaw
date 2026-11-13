import assert from "node:assert/strict";
import test from "node:test";
import { createIdentityResolver, mappingCodeOf } from "../src/resolve.mjs";
import { IDENTITY_CODES, IdentityError } from "../src/errors.mjs";
import { idmapKey } from "../src/cache.mjs";

function fakeRedis() {
  const values = new Map();
  return {
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async set(key, value) {
      values.set(key, value);
      return "OK";
    },
    snapshot() {
      return values;
    },
  };
}

function resolver({ redis = fakeRedis(), wecomCalls = { n: 0 }, hrmCalls = { n: 0 }, wecomImpl, hrmImpl } = {}) {
  return {
    redis,
    adapter: createIdentityResolver({
      redis,
      keyPrefix: "oa-workflow-bridge",
      adapterConfig: { alignMode: "userid_equals_workcode", cache: { ttlHours: 24, missTtlSeconds: 600 } },
      wecomClient: {
        lookupUserid: async (senderId) => {
          wecomCalls.n += 1;
          if (wecomImpl) return wecomImpl(senderId);
          return { userid: "10001", extattrJobNumber: "10001" };
        },
      },
      hrmClient: {
        lookupUserIdByWorkcode: async (workcode) => {
          hrmCalls.n += 1;
          if (hrmImpl) return hrmImpl(workcode);
          return "30538";
        },
      },
    }),
    wecomCalls,
    hrmCalls,
  };
}

test("缓存命中 0 次外部 HTTP", async () => {
  const redis = fakeRedis();
  const senderId = "sender-cached";
  const mappingCode = mappingCodeOf(senderId);
  await redis.set(idmapKey("oa-workflow-bridge", mappingCode), JSON.stringify({ oaUserId: "30538", cachedAt: "2026-09-02T00:00:00.000Z" }));
  const wecomCalls = { n: 0 };
  const hrmCalls = { n: 0 };
  const { adapter } = resolver({ redis, wecomCalls, hrmCalls });
  const result = await adapter.resolve(senderId);
  assert.equal(result.oaUserId, "30538");
  assert.equal(result.mappingCode, mappingCode);
  assert.equal(wecomCalls.n, 0);
  assert.equal(hrmCalls.n, 0);
});

test("miss 各调一次企微和人事并写回", async () => {
  const { adapter, redis, wecomCalls, hrmCalls } = resolver();
  const result = await adapter.resolve("sender-fixture-1");
  assert.equal(result.oaUserId, "30538");
  assert.match(result.mappingCode, /^[a-f0-9]{24}$/);
  assert.equal(wecomCalls.n, 1);
  assert.equal(hrmCalls.n, 1);
  const dumped = [...redis.snapshot().values()].join("\n");
  assert.equal(dumped.includes("sender-fixture-1"), false);
  assert.equal(dumped.includes("10001"), false);
  assert.match(dumped, /30538/);
});

test("idmiss 命中则直接抛出且不调外部 HTTP", async () => {
  const redis = fakeRedis();
  const senderId = "sender-missed";
  const mappingCode = mappingCodeOf(senderId);
  await redis.set(`oa-workflow-bridge:idmiss:${mappingCode}`, "WECOM_IDENTITY_OUT_OF_SCOPE");
  const wecomCalls = { n: 0 };
  const hrmCalls = { n: 0 };
  const { adapter } = resolver({ redis, wecomCalls, hrmCalls });
  await assert.rejects(() => adapter.resolve(senderId), (error) => error.code === "WECOM_IDENTITY_OUT_OF_SCOPE");
  assert.equal(wecomCalls.n, 0);
  assert.equal(hrmCalls.n, 0);
});

test("企微失败不调人事", async () => {
  const hrmCalls = { n: 0 };
  const { adapter } = resolver({
    hrmCalls,
    wecomImpl: async () => {
      throw new IdentityError("out of scope", { code: IDENTITY_CODES.OUT_OF_SCOPE });
    },
  });
  await assert.rejects(() => adapter.resolve("sender-fixture-2"), (error) => error.code === "WECOM_IDENTITY_OUT_OF_SCOPE");
  assert.equal(hrmCalls.n, 0);
});

test("NOT_CONFIGURED 与 TOKEN_FAILED 不写 idmiss", async () => {
  const redis = fakeRedis();
  const senderId = "sender-not-configured";
  const mappingCode = mappingCodeOf(senderId);
  const { adapter } = resolver({
    redis,
    wecomImpl: async () => {
      throw new IdentityError("missing secrets", { code: IDENTITY_CODES.NOT_CONFIGURED });
    },
  });
  await assert.rejects(() => adapter.resolve(senderId), (error) => error.code === "OA_IDENTITY_NOT_CONFIGURED");
  assert.equal(await redis.get(`oa-workflow-bridge:idmiss:${mappingCode}`), null);

  const tokenRedis = fakeRedis();
  const tokenSender = "sender-token-failed";
  const tokenCode = mappingCodeOf(tokenSender);
  const { adapter: tokenAdapter } = resolver({
    redis: tokenRedis,
    wecomImpl: async () => {
      throw new IdentityError("token failed", { code: IDENTITY_CODES.TOKEN_FAILED });
    },
  });
  await assert.rejects(() => tokenAdapter.resolve(tokenSender), (error) => error.code === "WECOM_IDENTITY_TOKEN_FAILED");
  assert.equal(await tokenRedis.get(`oa-workflow-bridge:idmiss:${tokenCode}`), null);
});

test("OUT_OF_SCOPE 仍写入 idmiss", async () => {
  const redis = fakeRedis();
  const senderId = "sender-out-of-scope";
  const mappingCode = mappingCodeOf(senderId);
  const { adapter } = resolver({
    redis,
    wecomImpl: async () => {
      throw new IdentityError("out of scope", { code: IDENTITY_CODES.OUT_OF_SCOPE });
    },
  });
  await assert.rejects(() => adapter.resolve(senderId), (error) => error.code === "WECOM_IDENTITY_OUT_OF_SCOPE");
  assert.equal(await redis.get(`oa-workflow-bridge:idmiss:${mappingCode}`), "WECOM_IDENTITY_OUT_OF_SCOPE");
});
