import assert from "node:assert/strict";
import test from "node:test";
import { lookupRequesterProfile, requireRequesterProfile } from "../src/hrm-profile.mjs";

function clientOf(body, { throwError } = {}) {
  return {
    authenticatedRequest: async (pathname, init = {}) => {
      assert.match(String(pathname), /\/api\/hrm\/simpleinfo\/getHrmSimpleInfo\?userid=4357$/);
      assert.equal(init.method, "GET");
      assert.equal(init.headerUserId, "4357");
      if (throwError) throw throwError;
      return body;
    },
  };
}

test("缺少认证客户端时拒绝匿名 GET", async () => {
  await assert.rejects(
    () => lookupRequesterProfile({
      oaUserId: "4357",
      baseUrl: "https://adtekoa.com",
    }),
    (error) => error.code === "OA_PROFILE_LOOKUP_FAILED",
  );
});

test("从 E9 simpleInfo 包裹取出资源 ID，忽略姓名字段", async () => {
  const profile = await lookupRequesterProfile({
    oaUserId: "4357",
    client: clientOf({
      simpleInfo: {
        id: "4357",
        lastname: "彭子康",
        departmentid: "714",
        departmentName: "IT信息B组",
        jobtitle: "636",
        jobtitleName: "越南信息主管",
        locationid: "3",
        locationName: "越南二厂",
        status: "1",
      },
      fieldInfo: [{ fieldlabel: "部门", fieldvalue: "IT信息B组" }],
      status: "1",
    }),
  });
  assert.deepEqual(profile, { departmentId: "714", jobTitleId: "636", locationId: "3" });
  assert.equal(JSON.stringify(profile).includes("彭子康"), false);
  assert.equal(JSON.stringify(profile).includes("IT信息B组"), false);
});

test("从 getHrmSimpleInfo 顶层字段取出部门、岗位、办公地点资源 ID", async () => {
  const profile = await lookupRequesterProfile({
    oaUserId: "4357",
    client: clientOf({
      departmentid: "714",
      jobtitle: "636",
      locationid: "3",
      lastname: "彭子康",
    }),
  });
  assert.deepEqual(profile, { departmentId: "714", jobTitleId: "636", locationId: "3" });
});

test("接受 data 包裹且不把姓名写进返回值", async () => {
  const profile = await lookupRequesterProfile({
    oaUserId: "4357",
    client: clientOf({
      code: "1",
      data: {
        departmentId: "714",
        jobtitleid: "636",
        locationId: "3",
        lastname: "彭子康",
        mobile: "13800000000",
      },
    }),
  });
  assert.deepEqual(profile, { departmentId: "714", jobTitleId: "636", locationId: "3" });
  assert.equal(JSON.stringify(profile).includes("彭子康"), false);
  assert.equal(JSON.stringify(profile).includes("13800000000"), false);
});

test("缺任一资源 ID 则 OA_PROFILE_INCOMPLETE，错误对象不含姓名", async () => {
  await assert.rejects(
    () => lookupRequesterProfile({
      oaUserId: "4357",
      client: clientOf({
        departmentid: "714",
        jobtitle: "",
        locationid: "3",
        lastname: "彭子康",
      }),
    }),
    (error) => {
      const dumped = JSON.stringify(error);
      assert.equal(error.code, "OA_PROFILE_INCOMPLETE");
      assert.equal(dumped.includes("彭子康"), false);
      return true;
    },
  );
});

test("网络失败不重试，返回 OA_PROFILE_LOOKUP_FAILED", async () => {
  let calls = 0;
  await assert.rejects(
    () => lookupRequesterProfile({
      oaUserId: "4357",
      client: {
        authenticatedRequest: async () => {
          calls += 1;
          throw new Error("network down");
        },
      },
    }),
    (error) => error.code === "OA_PROFILE_LOOKUP_FAILED",
  );
  assert.equal(calls, 1);
});

test("status false（含 errorCode 002）记 OA_PROFILE_LOOKUP_FAILED，不把 msg 写入错误对象", async () => {
  await assert.rejects(
    () => lookupRequesterProfile({
      oaUserId: "4357",
      client: clientOf({
        status: false,
        errorCode: "002",
        msg: "用户未登录",
      }),
    }),
    (error) => {
      const dumped = JSON.stringify(error);
      assert.equal(error.code, "OA_PROFILE_LOOKUP_FAILED");
      assert.equal(dumped.includes("用户未登录"), false);
      assert.equal(dumped.includes("002"), false);
      return true;
    },
  );
});

test("走 OAClient 认证 GET：Header 是申请人，query 是同一人员 id", async () => {
  const calls = [];
  const profile = await lookupRequesterProfile({
    oaUserId: "4357",
    client: {
      authenticatedRequest: async (pathname, options = {}) => {
        calls.push({ pathname, options });
        return {
          simpleInfo: {
            id: "4357",
            departmentid: "714",
            jobtitle: "636",
            locationid: "3",
            lastname: "彭子康",
          },
        };
      },
    },
  });
  assert.deepEqual(profile, { departmentId: "714", jobTitleId: "636", locationId: "3" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headerUserId, "4357");
  assert.match(calls[0].pathname, /\/api\/hrm\/simpleinfo\/getHrmSimpleInfo\?userid=4357$/);
  assert.equal(JSON.stringify(profile).includes("彭子康"), false);
});

test("返回的人员 id 与查询对象不一致则 LOOKUP_FAILED", async () => {
  await assert.rejects(
    () => lookupRequesterProfile({
      oaUserId: "4357",
      client: {
        authenticatedRequest: async () => ({
          simpleInfo: {
            id: "10001",
            departmentid: "714",
            jobtitle: "636",
            locationid: "3",
          },
        }),
      },
    }),
    (error) => error.code === "OA_PROFILE_LOOKUP_FAILED",
  );
});

test("requireRequesterProfile 缺地点则 INCOMPLETE", () => {
  assert.throws(
    () => requireRequesterProfile({ departmentId: "714", jobTitleId: "636" }),
    (error) => error.code === "OA_PROFILE_INCOMPLETE",
  );
});
