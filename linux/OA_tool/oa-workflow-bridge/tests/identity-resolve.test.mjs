import assert from "node:assert/strict";
import test from "node:test";
import { IDENTITY_CODES, IdentityError } from "../src/identity/errors.mjs";
import { alignWorkcode, createIdentityResolver, IDENTITY_MISS_TTL_MS } from "../src/identity/resolve.mjs";
import { getIdentityCache, setIdentityCache } from "../src/store.mjs";
import { identityCode } from "../src/trust.mjs";
import { createTestStore } from "./helpers.mjs";

function resolver({ store = createTestStore(), wecomCalls = { n: 0 }, hrmCalls = { n: 0 }, wecomImpl, hrmImpl } = {}) {
  return {
    store,
    adapter: createIdentityResolver({
      store,
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

test("工号对齐：相等通过、无扩展属性时 userid 当工号、不相等 fail-closed", () => {
  assert.equal(alignWorkcode({ userid: "57999", extattrJobNumber: "57999" }), "57999");
  assert.equal(alignWorkcode({ userid: "57999", extattrJobNumber: "" }), "57999");
  assert.throws(
    () => alignWorkcode({ userid: "57999", extattrJobNumber: "88001" }),
    (error) => error.code === "WECOM_IDENTITY_ALIGN_MISMATCH",
  );
});

test("缓存命中 0 次外部 HTTP", async () => {
  const store = createTestStore();
  const senderId = "sender-cached";
  await setIdentityCache(store, identityCode(senderId), { oaUserId: "30538" }, 60_000);
  const wecomCalls = { n: 0 };
  const hrmCalls = { n: 0 };
  const { adapter } = resolver({ store, wecomCalls, hrmCalls });
  const result = await adapter.resolve(senderId);
  assert.equal(result.oaUserId, "30538");
  assert.equal(result.mappingCode, identityCode(senderId));
  assert.equal(wecomCalls.n, 0);
  assert.equal(hrmCalls.n, 0);
});

test("miss 各调一次企微和人事并写回，库里不留原始 SenderId 和工号", async () => {
  const { adapter, store, wecomCalls, hrmCalls } = resolver();
  const result = await adapter.resolve("sender-fixture-1");
  assert.equal(result.oaUserId, "30538");
  assert.match(result.mappingCode, /^[a-f0-9]{24}$/);
  assert.equal(wecomCalls.n, 1);
  assert.equal(hrmCalls.n, 1);
  const dumped = JSON.stringify(await store.db.query("SELECT * FROM oa_identity"));
  assert.equal(dumped.includes("sender-fixture-1"), false);
  assert.equal(dumped.includes("10001"), false);
  assert.match(dumped, /30538/);
  assert.equal((await adapter.resolve("sender-fixture-1")).oaUserId, "30538");
  assert.equal(wecomCalls.n, 1);
});

test("缓存过期后重新查", async () => {
  const store = createTestStore();
  const started = Date.now();
  const { adapter, wecomCalls } = resolver({ store });
  await adapter.resolve("sender-ttl");
  store.now = () => started + 25 * 60 * 60 * 1000;
  await adapter.resolve("sender-ttl");
  assert.equal(wecomCalls.n, 2);
});

test("负缓存命中则直接抛出且不调外部 HTTP", async () => {
  const store = createTestStore();
  const senderId = "sender-missed";
  await setIdentityCache(store, identityCode(senderId), { missCode: "WECOM_IDENTITY_OUT_OF_SCOPE" }, IDENTITY_MISS_TTL_MS);
  const wecomCalls = { n: 0 };
  const hrmCalls = { n: 0 };
  const { adapter } = resolver({ store, wecomCalls, hrmCalls });
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

test("NOT_CONFIGURED 与 TOKEN_FAILED 不写负缓存", async () => {
  for (const code of [IDENTITY_CODES.NOT_CONFIGURED, IDENTITY_CODES.TOKEN_FAILED]) {
    const { adapter, store } = resolver({
      wecomImpl: async () => {
        throw new IdentityError("not ready", { code });
      },
    });
    await assert.rejects(() => adapter.resolve("sender-x"), (error) => error.code === code);
    assert.deepEqual(await getIdentityCache(store, identityCode("sender-x")), { oaUserId: "", missCode: "" });
  }
});

test("OUT_OF_SCOPE 写入负缓存，10 分钟后失效", async () => {
  const store = createTestStore();
  const started = Date.now();
  const senderId = "sender-out-of-scope";
  const { adapter } = resolver({
    store,
    wecomImpl: async () => {
      throw new IdentityError("out of scope", { code: IDENTITY_CODES.OUT_OF_SCOPE });
    },
  });
  await assert.rejects(() => adapter.resolve(senderId), (error) => error.code === "WECOM_IDENTITY_OUT_OF_SCOPE");
  assert.equal((await getIdentityCache(store, identityCode(senderId))).missCode, "WECOM_IDENTITY_OUT_OF_SCOPE");
  store.now = () => started + IDENTITY_MISS_TTL_MS + 1000;
  assert.equal((await getIdentityCache(store, identityCode(senderId))).missCode, "");
});
