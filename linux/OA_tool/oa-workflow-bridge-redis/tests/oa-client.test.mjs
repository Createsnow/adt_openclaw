import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import test from "node:test";
import { encryptCredential, getSharedOAClient, OAClient, resetSharedOAClients } from "../src/oa-client.mjs";
import { lookupRequesterProfile } from "../src/hrm-profile.mjs";
import { OA_SECRET_REFS } from "../src/secret-resolver.mjs";

function keys() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey,
    spki: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

function decryptHeader(value, privateKey) {
  return privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(value, "base64"),
  ).toString("utf8");
}

function config(spki) {
  return {
    baseUrl: "https://adtekoa.com",
    appId: "oa-develop",
    workflowId: 602,
    publicKeySpkiBase64: spki,
  };
}

const resolver = async (ids) => Object.fromEntries(ids.map((id) => [
  id,
  id === OA_SECRET_REFS.apiUserId ? "10001" : "TEST_ONLY_NOT_A_CREDENTIAL",
]));

test("OA凭据生成2048位随机填充的RSA密文", () => {
  const { spki } = keys();
  const first = Buffer.from(encryptCredential("sensitive-value", spki), "base64");
  const second = Buffer.from(encryptCredential("sensitive-value", spki), "base64");
  assert.equal(first.length, 256);
  assert.equal(second.length, 256);
  assert.notDeepEqual(first, second);
});

test("OA创建只接受SUCCESS和数字requestid，且不强制Content-Length", async () => {
  const { spki } = keys();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/applytoken")) {
      return new Response(JSON.stringify({ status: true, code: "0", token: "token-value" }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: "SUCCESS", data: { requestid: 778899 } }), { status: 200 });
  };
  const client = new OAClient({ config: config(spki), resolveSecrets: resolver, fetchImpl });
  const result = await client.createRequest(
    { workflowId: 602, requestName: "test", mainData: [] },
    { requesterUserId: "13437" },
  );
  assert.equal(result.requestId, "778899");
  assert.equal(calls.length, 2);
  assert.equal(Object.keys(calls[1].options.headers).some((name) => name.toLowerCase() === "content-length"), false);
  assert.equal(JSON.parse(calls[1].options.body).workflowId, 602);
});

test("创建流程 Header userid 使用加密后的申请人人员 id，不是接口账号", async () => {
  const { privateKey, spki } = keys();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/applytoken")) {
      return new Response(JSON.stringify({ status: true, code: "0", token: "token-value" }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: "SUCCESS", data: { requestid: 778899 } }), { status: 200 });
  };
  const client = new OAClient({ config: config(spki), resolveSecrets: resolver, fetchImpl });
  await client.createRequest(
    { workflowId: 602, requestName: "test", mainData: [{ fieldName: "xqsqr", fieldValue: "13437" }] },
    { requesterUserId: "13437" },
  );
  assert.equal(calls[0].url.endsWith("/applytoken"), true);
  assert.equal("userid" in (calls[0].options.headers || {}), false);
  assert.equal(decryptHeader(calls[1].options.headers.userid, privateKey), "13437");
  assert.notEqual(decryptHeader(calls[1].options.headers.userid, privateKey), "10001");
});

test("创建流程缺少申请人人员 id 时拒绝调用", async () => {
  const { spki } = keys();
  const client = new OAClient({
    config: config(spki),
    resolveSecrets: resolver,
    fetchImpl: async () => {
      throw new Error("createRequest must not call OA without requesterUserId");
    },
  });
  await assert.rejects(
    client.createRequest({ workflowId: 602, requestName: "test", mainData: [] }),
    (error) => error.code === "INVALID_CONFIGURATION",
  );
});

test("资料现查使用 applytoken 与申请人 Header，不把接口账号写入 userid", async () => {
  const { privateKey, spki } = keys();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (String(url).endsWith("/applytoken")) {
      return new Response(JSON.stringify({ status: true, code: "0", token: "token-value" }), { status: 200 });
    }
    return new Response(JSON.stringify({
      simpleInfo: {
        id: "13437",
        departmentid: "714",
        jobtitle: "636",
        locationid: "3",
        lastname: "测试人员",
      },
    }), { status: 200 });
  };
  const client = new OAClient({ config: config(spki), resolveSecrets: resolver, fetchImpl });
  const profile = await lookupRequesterProfile({ oaUserId: "13437", client });
  assert.deepEqual(profile, { departmentId: "714", jobTitleId: "636", locationId: "3" });
  assert.equal(calls[0].url.endsWith("/applytoken"), true);
  assert.equal("userid" in (calls[0].options.headers || {}), false);
  assert.equal(calls[1].options.method, "GET");
  assert.match(String(calls[1].url), /\/api\/hrm\/simpleinfo\/getHrmSimpleInfo\?userid=13437$/);
  assert.equal(decryptHeader(calls[1].options.headers.userid, privateKey), "13437");
  assert.notEqual(decryptHeader(calls[1].options.headers.userid, privateKey), "10001");
  assert.equal(JSON.stringify(profile).includes("测试人员"), false);
});

test("资料现查 status false / 002 记 OA_PROFILE_LOOKUP_FAILED，不标 unknown", async () => {
  const { spki } = keys();
  const client = new OAClient({
    config: config(spki),
    resolveSecrets: resolver,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/applytoken")) {
        return new Response(JSON.stringify({ status: true, code: "0", token: "token-value" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: false, errorCode: "002", msg: "用户未登录" }), { status: 200 });
    },
  });
  await assert.rejects(
    lookupRequesterProfile({ oaUserId: "13437", client }),
    (error) => error.code === "OA_PROFILE_LOOKUP_FAILED" && error.ambiguous !== true,
  );
});

test("OA创建请求网络中断标记为结果未知", async () => {
  const { spki } = keys();
  let requestNumber = 0;
  const client = new OAClient({
    config: config(spki),
    resolveSecrets: resolver,
    fetchImpl: async () => {
      requestNumber += 1;
      if (requestNumber === 1) {
        return new Response(JSON.stringify({ status: true, code: "0", token: "token-value" }), { status: 200 });
      }
      throw new Error("simulated network loss");
    },
  });
  await assert.rejects(
    client.createRequest(
      { workflowId: 602, requestName: "test", mainData: [] },
      { requesterUserId: "13437" },
    ),
    (error) => error.code === "NETWORK_OUTCOME_UNKNOWN" && error.ambiguous === true,
  );
});

test("创建失败时记录脱敏后的 OA errMsg，不把附件正文打进日志", async () => {
  const { spki } = keys();
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const client = new OAClient({
      config: config(spki),
      resolveSecrets: resolver,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/applytoken")) {
          return new Response(JSON.stringify({ status: true, code: "0", token: "token-value" }), { status: 200 });
        }
        return new Response(JSON.stringify({
          code: "PARAM_ERROR",
          errMsg: { scfj: "生成附件失败,fileValue:[{\"filePath\":\"JVBERi0xLjQK\",\"fileName\":\"报销单.pdf\"}]" },
        }), { status: 200 });
      },
    });
    await assert.rejects(
      client.createRequest({ workflowId: 602, requestName: "test", mainData: [] }, { requesterUserId: "13437" }),
      (error) => error.code === "PARAM_ERROR",
    );
    const rejected = lines.find((line) => line.includes("OA_CREATE_REJECTED"));
    assert.ok(rejected);
    assert.ok(rejected.includes("PARAM_ERROR"));
    assert.ok(rejected.includes("生成附件失败"));
    assert.ok(!rejected.includes("JVBERi0"));
    assert.ok(!rejected.includes("报销单"));
  } finally {
    console.log = originalLog;
  }
});

test("同一 OAClient 资料现查后再建单只 applytoken 一次", async () => {
  const { spki } = keys();
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/applytoken")) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ status: true, code: "0", token: "token-value" }), { status: 200 });
    }
    if (String(url).includes("getHrmSimpleInfo")) {
      return new Response(JSON.stringify({
        simpleInfo: { id: "13437", departmentid: "714", jobtitle: "636", locationid: "3" },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: "SUCCESS", data: { requestid: 778899 } }), { status: 200 });
  };
  const client = new OAClient({ config: config(spki), resolveSecrets: resolver, fetchImpl });
  await lookupRequesterProfile({ oaUserId: "13437", client });
  const created = await client.createRequest(
    { workflowId: 602, requestName: "test", mainData: [] },
    { requesterUserId: "13437" },
  );
  assert.equal(created.requestId, "778899");
  assert.equal(tokenCalls, 1);
});

test("并发 getToken 只打一次 applytoken", async () => {
  const { spki } = keys();
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/applytoken")) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      tokenCalls += 1;
      return new Response(JSON.stringify({ status: true, code: "0", token: "token-value" }), { status: 200 });
    }
    return new Response(JSON.stringify({
      simpleInfo: { id: "13437", departmentid: "714", jobtitle: "636", locationid: "3" },
    }), { status: 200 });
  };
  const client = new OAClient({ config: config(spki), resolveSecrets: resolver, fetchImpl });
  await Promise.all([
    lookupRequesterProfile({ oaUserId: "13437", client }),
    client.authenticatedRequest("/api/hrm/simpleinfo/getHrmSimpleInfo?userid=13437", {
      method: "GET",
      headerUserId: "13437",
    }),
  ]);
  assert.equal(tokenCalls, 1);
});

test("getSharedOAClient 跨两次提交复用 token 缓存", async (t) => {
  t.after(resetSharedOAClients);
  resetSharedOAClients();
  const { spki } = keys();
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/applytoken")) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ status: true, code: "0", token: "token-value" }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: "SUCCESS", data: { requestid: 778899 } }), { status: 200 });
  };
  const cfg = config(spki);
  const first = getSharedOAClient({ config: cfg, resolveSecrets: resolver, fetchImpl });
  const second = getSharedOAClient({ config: cfg, resolveSecrets: resolver, fetchImpl });
  assert.equal(first, second);
  await first.createRequest({ workflowId: 602, requestName: "a", mainData: [] }, { requesterUserId: "13437" });
  await second.createRequest({ workflowId: 602, requestName: "b", mainData: [] }, { requesterUserId: "13437" });
  assert.equal(tokenCalls, 1);
});

test("明文 OA 日志默认关闭，仅 OA_LOG_REQUEST_PLAINTEXT=1 打开", async () => {
  const { oaRequestPlaintextEnabled } = await import("../src/oa-client.mjs");
  const prev = process.env.OA_LOG_REQUEST_PLAINTEXT;
  const prevCtx = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.OA_LOG_REQUEST_PLAINTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    assert.equal(oaRequestPlaintextEnabled(), false);
    process.env.OA_LOG_REQUEST_PLAINTEXT = "1";
    assert.equal(oaRequestPlaintextEnabled(), true);
    process.env.OA_LOG_REQUEST_PLAINTEXT = "0";
    assert.equal(oaRequestPlaintextEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.OA_LOG_REQUEST_PLAINTEXT;
    else process.env.OA_LOG_REQUEST_PLAINTEXT = prev;
    if (prevCtx === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = prevCtx;
  }
});
