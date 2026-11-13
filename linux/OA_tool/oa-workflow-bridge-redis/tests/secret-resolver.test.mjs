import assert from "node:assert/strict";
import test from "node:test";
import { OA_SECRET_REFS, resolveProtectedValues } from "../src/secret-resolver.mjs";

const ENV_KEYS = ["OA_API_USER_ID", "OA_APP_SECRET"];

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

async function withEnv(env, fn) {
  const snapshot = snapshotEnv();
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, env);
    return await fn();
  } finally {
    restoreEnv(snapshot);
  }
}

test("从环境变量读取 OA API 用户与 AppSecret", async () => {
  const values = await withEnv({
    OA_API_USER_ID: "1001",
    OA_APP_SECRET: "rotated-secret",
  }, () => resolveProtectedValues([OA_SECRET_REFS.apiUserId, OA_SECRET_REFS.appSecret]));
  assert.equal(values[OA_SECRET_REFS.apiUserId], "1001");
  assert.equal(values[OA_SECRET_REFS.appSecret], "rotated-secret");
});

test("未配置时核心凭据为空", async () => {
  const values = await withEnv({}, () => resolveProtectedValues([
    OA_SECRET_REFS.apiUserId,
    OA_SECRET_REFS.appSecret,
  ]));
  assert.deepEqual(values, {});
});
