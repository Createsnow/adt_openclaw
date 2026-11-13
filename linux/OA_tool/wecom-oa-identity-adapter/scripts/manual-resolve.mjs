#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createIdentityResolverFromFiles, mappingCodeOf } from "../src/resolve.mjs";

const showUserid = process.argv.includes("--show-userid");
const writeCache = process.argv.includes("--write-cache");

async function readSenderId() {
  const fromArg = process.argv.find((item, index) => index > 1 && !item.startsWith("--"));
  if (fromArg) return fromArg;
  if (input.isTTY) {
    const rl = createInterface({ input, output });
    const value = await rl.question("open_userid: ");
    rl.close();
    return value.trim();
  }
  const chunks = [];
  for await (const chunk of input) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim().split(/\r?\n/)[0] || "";
}

async function resolveRedis() {
  if (!writeCache) {
    return { get: async () => null, set: async () => "OK" };
  }
  const url = process.env.OA_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
  if (!url) {
    throw new Error("--write-cache requires OA_REDIS_URL or REDIS_URL");
  }
  const { createClient } = await import("redis");
  const client = createClient({ url });
  await client.connect();
  return client;
}

const senderId = await readSenderId();
const mappingCode = senderId ? mappingCodeOf(senderId) : "";
if (!senderId) {
  console.log(JSON.stringify({ ok: false, mappingCode: "", aligned: false, found: false }));
  process.exit(1);
}

let redis;
try {
  redis = await resolveRedis();
  const resolver = await createIdentityResolverFromFiles({
    redis,
    includePlainUserid: showUserid,
  });
  const result = await resolver.resolve(senderId);
  const payload = {
    ok: true,
    mappingCode: result.mappingCode,
    aligned: true,
    found: Boolean(result.oaUserId),
    oaUserId: result.oaUserId,
  };
  if (showUserid && result.userid) payload.userid = result.userid;
  console.log(JSON.stringify(payload));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    mappingCode,
    aligned: false,
    found: false,
    code: error?.code || "OA_IDENTITY_LOOKUP_FAILED",
  }));
  process.exitCode = 1;
} finally {
  if (redis?.quit) await redis.quit();
}
