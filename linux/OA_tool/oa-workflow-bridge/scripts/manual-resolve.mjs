#!/usr/bin/env node
/**
 * 手工排查：企微 open_userid → OA 人员 id。默认不读写数据库缓存；加 --write-cache 才写入 oa_identity。
 * 需要 WECOM_IDENTITY_CORPID / WECOM_IDENTITY_SECRET；--write-cache 另需 OA_MYSQL_PASSWORD。
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadBridgeConfig } from "../src/config.mjs";
import { createMysqlDb } from "../src/db.mjs";
import { createIdentityResolver } from "../src/identity/resolve.mjs";
import { createStore } from "../src/store.mjs";
import { identityCode } from "../src/trust.mjs";

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

/** 不写缓存时用一个永远 miss、写入丢弃的假库。 */
const noCacheDb = { query: async () => [], run: async () => 0, close: async () => {} };

const senderId = await readSenderId();
const mappingCode = senderId ? identityCode(senderId) : "";
if (!senderId) {
  console.log(JSON.stringify({ ok: false, mappingCode: "", aligned: false, found: false }));
  process.exit(1);
}

let db;
try {
  const config = await loadBridgeConfig();
  db = writeCache ? await createMysqlDb(config.mysql) : noCacheDb;
  const resolver = createIdentityResolver({
    store: createStore(db),
    oaBaseUrl: config.baseUrl,
    includePlainUserid: showUserid,
  });
  const result = await resolver.resolve(senderId);
  const payload = { ok: true, mappingCode: result.mappingCode, aligned: true, found: Boolean(result.oaUserId), oaUserId: result.oaUserId };
  if (showUserid && result.userid) payload.userid = result.userid;
  console.log(JSON.stringify(payload));
} catch (error) {
  console.log(JSON.stringify({ ok: false, mappingCode, aligned: false, found: false, code: error?.code || "OA_IDENTITY_LOOKUP_FAILED" }));
  process.exitCode = 1;
} finally {
  if (db?.close) await db.close();
}
