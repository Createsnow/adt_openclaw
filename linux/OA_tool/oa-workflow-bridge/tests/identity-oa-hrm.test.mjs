import assert from "node:assert/strict";
import test from "node:test";
import { OaHrmClient } from "../src/identity/oa-hrm.mjs";

function person(overrides = {}) {
  return {
    id: "30538",
    workcode: "57999",
    status: "1",
    accounttype: "0",
    mobile: "13800000000",
    certificatenum: "secret-id-card",
    ...overrides,
  };
}

function client(fetchImpl) {
  return new OaHrmClient({ fetchImpl });
}

function hrResponse(dataList, totalSize = dataList.length) {
  return async (url, init = {}) => {
    assert.match(String(url), /\/api\/hrm\/resful\/getHrmUserInfoWithPage$/);
    assert.equal(init.method, "POST");
    const headers = init.headers || {};
    const headerKeys = Object.keys(headers).map((key) => key.toLowerCase());
    assert.equal(headerKeys.includes("token"), false);
    assert.equal(headerKeys.includes("appid"), false);
    assert.equal(headerKeys.includes("userid"), false);
    assert.equal(headerKeys.includes("secret"), false);
    assert.match(String(headers["content-type"] || headers["Content-Type"] || ""), /application\/json/);
    const payload = JSON.parse(init.body);
    assert.deepEqual(payload, { params: { workcode: "57999" } });
    return new Response(JSON.stringify({ code: "1", data: { totalSize, dataList } }));
  };
}

test("唯一在职返回数字 id", async () => {
  const hrm = client(hrResponse([person()]));
  assert.equal(await hrm.lookupUserIdByWorkcode("57999"), "30538");
});

test("人事点查不调 applytoken、不带认证 Header", async () => {
  const urls = [];
  const hrm = client(async (url, init) => {
    urls.push(url);
    return hrResponse([person()])(url, init);
  });
  await hrm.lookupUserIdByWorkcode("57999");
  assert.equal(urls.length, 1);
  assert.equal(String(urls[0]).includes("applytoken"), false);
});

test("多条视为歧义", async () => {
  const hrm = client(hrResponse([person(), person({ id: "30539" })], 2));
  await assert.rejects(() => hrm.lookupUserIdByWorkcode("57999"), (error) => error.code === "OA_IDENTITY_AMBIGUOUS");
});

test("离职拒绝", async () => {
  const hrm = client(hrResponse([person({ status: "5" })]));
  await assert.rejects(() => hrm.lookupUserIdByWorkcode("57999"), (error) => error.code === "OA_IDENTITY_INACTIVE");
});

test("次账号拒绝", async () => {
  const hrm = client(hrResponse([person({ accounttype: "1" })]));
  await assert.rejects(() => hrm.lookupUserIdByWorkcode("57999"), (error) => error.code === "OA_IDENTITY_INACTIVE");
});

test("错误对象不含 dataList / 手机 / 身份证", async () => {
  const hrm = client(hrResponse([person({ status: "5" })]));
  await assert.rejects(() => hrm.lookupUserIdByWorkcode("57999"), (error) => {
    const dumped = JSON.stringify(error);
    assert.equal(dumped.includes("dataList"), false);
    assert.equal(dumped.includes("13800000000"), false);
    assert.equal(dumped.includes("secret-id-card"), false);
    return error.code === "OA_IDENTITY_INACTIVE";
  });
});
