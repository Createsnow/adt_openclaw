import assert from "node:assert/strict";
import test from "node:test";
import { WecomClient } from "../src/identity/wecom-client.mjs";

function client(fetchImpl, now = () => 1_000) {
  return new WecomClient({
    fetchImpl,
    now,
    tokenCacheMs: 5_400_000,
    corpId: "ww-test",
    corpSecret: "secret-test",
  });
}

test("转换成功：user/get 直接返回 userid", async () => {
  const calls = [];
  const wecom = client(async (url) => {
    calls.push(url);
    if (String(url).includes("/gettoken")) {
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", access_token: "tok", expires_in: 7200 }));
    }
    return new Response(JSON.stringify({
      errcode: 0,
      errmsg: "ok",
      userid: "57999",
      extattr: { attrs: [{ name: "工号", type: 0, text: { value: "57999" } }] },
    }));
  });
  const result = await wecom.lookupUserid("open-user-fixture");
  assert.equal(result.userid, "57999");
  assert.equal(result.extattrJobNumber, "57999");
  assert.equal(calls.filter((url) => String(url).includes("/gettoken")).length, 1);
});

test("token 缓存命中不二次 gettoken", async () => {
  let now = 1_000;
  let tokenCalls = 0;
  const wecom = client(async (url) => {
    if (String(url).includes("/gettoken")) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ errcode: 0, access_token: "tok", expires_in: 7200 }));
    }
    return new Response(JSON.stringify({ errcode: 0, userid: "10001" }));
  }, () => now);
  await wecom.lookupUserid("sender-a");
  now += 5_399_000;
  await wecom.lookupUserid("sender-b");
  assert.equal(tokenCalls, 1);
});

test("进入 invalid 列表视为加密串无法转换", async () => {
  const wecom = client(async (url) => {
    if (String(url).includes("/gettoken")) {
      return new Response(JSON.stringify({ errcode: 0, access_token: "tok" }));
    }
    if (String(url).includes("/user/get")) {
      return new Response(JSON.stringify({ errcode: 60111, errmsg: "userid not found" }));
    }
    return new Response(JSON.stringify({
      errcode: 0,
      userid_list: [],
      invalid_open_userid_list: ["open-user-fixture"],
    }));
  });
  await assert.rejects(() => wecom.lookupUserid("open-user-fixture"), (error) => error.code === "WECOM_OPENUSERID_INVALID");
});

test("user/get 可见范围外不回退 batch", async () => {
  const calls = [];
  const wecom = client(async (url) => {
    calls.push(String(url));
    if (String(url).includes("/gettoken")) {
      return new Response(JSON.stringify({ errcode: 0, access_token: "tok" }));
    }
    return new Response(JSON.stringify({ errcode: 81013, errmsg: "user not in visible range" }));
  });
  await assert.rejects(() => wecom.lookupUserid("open-user-fixture"), (error) => error.code === "WECOM_IDENTITY_OUT_OF_SCOPE");
  assert.equal(calls.some((url) => url.includes("openuserid_to_userid")), false);
});

test("user/get token 失效清缓存且不回退 batch", async () => {
  let tokenCalls = 0;
  const wecom = client(async (url) => {
    if (String(url).includes("/gettoken")) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ errcode: 0, access_token: `tok-${tokenCalls}` }));
    }
    if (String(url).includes("/user/get")) {
      return new Response(JSON.stringify({ errcode: 42001, errmsg: "access_token expired" }));
    }
    throw new Error("batch should not run");
  });
  await assert.rejects(() => wecom.lookupUserid("sender-a"), (error) => error.code === "WECOM_IDENTITY_TOKEN_FAILED");
  await assert.rejects(() => wecom.lookupUserid("sender-b"), (error) => error.code === "WECOM_IDENTITY_TOKEN_FAILED");
  assert.equal(tokenCalls, 2);
});

test("gettoken 非 JSON 归为 TOKEN_FAILED", async () => {
  const wecom = client(async () => new Response("<html>bad gateway</html>"));
  await assert.rejects(() => wecom.lookupUserid("sender-x"), (error) => error.code === "WECOM_IDENTITY_TOKEN_FAILED");
});

test("user/get 失败后 batch 成功再拉扩展属性", async () => {
  const calls = [];
  const wecom = client(async (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    if (String(url).includes("/gettoken")) {
      return new Response(JSON.stringify({ errcode: 0, access_token: "tok" }));
    }
    if (String(url).includes("/user/get") && String(url).includes("userid=open-user-fixture")) {
      return new Response(JSON.stringify({ errcode: 60111, errmsg: "userid not found" }));
    }
    if (String(url).includes("openuserid_to_userid")) {
      return new Response(JSON.stringify({
        errcode: 0,
        userid_list: [{ userid: "57999" }],
        invalid_open_userid_list: [],
      }));
    }
    if (String(url).includes("/user/get") && String(url).includes("userid=57999")) {
      return new Response(JSON.stringify({
        errcode: 0,
        userid: "57999",
        extattr: { attrs: [{ name: "工号", type: 0, text: { value: "57999" } }] },
      }));
    }
    throw new Error(`unexpected ${url}`);
  });
  const result = await wecom.lookupUserid("open-user-fixture");
  assert.equal(result.userid, "57999");
  assert.equal(result.extattrJobNumber, "57999");
  assert.equal(calls.filter((item) => item.url.includes("openuserid_to_userid")).length, 1);
});

test("日志错误对象不含 senderId", async () => {
  const wecom = client(async () => {
    throw new Error("network down");
  });
  await assert.rejects(() => wecom.lookupUserid("should-not-appear-in-error"), (error) => {
    assert.equal(error.message.includes("should-not-appear-in-error"), false);
    return error.code === "WECOM_IDENTITY_TOKEN_FAILED";
  });
});
