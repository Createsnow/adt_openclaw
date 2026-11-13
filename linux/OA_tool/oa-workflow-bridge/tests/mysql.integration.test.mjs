/**
 * 真实 MySQL / MariaDB 集成测试。默认跳过；设置下面的环境变量后才跑（会清空测试库里的三张表）：
 *   OA_MYSQL_TEST_HOST / OA_MYSQL_TEST_PORT / OA_MYSQL_TEST_USER / OA_MYSQL_TEST_DATABASE / OA_MYSQL_PASSWORD
 * 不要指向生产库。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkSchema, createMysqlDb, ensureSchema, TABLES } from "../src/db.mjs";
import { cleanupExpired, createStore, getTicket, listRecentTickets } from "../src/store.mjs";
import { createOAWorkflowToolFactory } from "../src/tool.mjs";

const host = process.env.OA_MYSQL_TEST_HOST;
const skip = host ? false : "set OA_MYSQL_TEST_HOST to run against a real MySQL";

function parse(result) {
  return JSON.parse(result.content[0].text);
}

function context(sender, extra = {}) {
  return { messageChannel: "wecom", requesterSenderId: sender, sessionKey: `room-${sender}`, ...extra };
}

const draft = {
  ticketType: "运维支持",
  systemName: "OA系统",
  summary: "OA 待办打不开",
  problemDescription: "OA 待办打不开，点进去一直转圈。",
};

test("MySQL：建表幂等、完整走一遍待确认 → 补图 → 提交 / 取消 / 过期 / 兜底", { skip }, async (t) => {
  const db = await createMysqlDb({
    host,
    port: Number(process.env.OA_MYSQL_TEST_PORT || 3306),
    user: process.env.OA_MYSQL_TEST_USER || "xa_oa",
    database: process.env.OA_MYSQL_TEST_DATABASE || "xa_oa",
  });
  t.after(() => db.close());
  await ensureSchema(db);
  await ensureSchema(db);
  await checkSchema(db);
  for (const table of TABLES) await db.run(`DELETE FROM ${table}`);

  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-mysql-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const inbound = path.join(stateDir, "media", "inbound");
  await mkdir(inbound, { recursive: true });
  const shot = path.join(inbound, "shot.png");
  await writeFile(shot, "image-bytes");

  const store = createStore(db);
  const payloads = [];
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: store,
    dependencies: {
      loadConfig: async () => ({
        active: true,
        workflowId: 602,
        isnextflow: "0",
        attachmentFieldName: "scfj",
        pendingTtlHours: 24,
        inboxTtlMinutes: 30,
        maxAttachmentBytes: 1024 * 1024,
        maxTotalAttachmentBytes: 2 * 1024 * 1024,
        identity: { adapter: "on" },
      }),
      clientFactory: () => ({
        createRequest: async (payload) => {
          payloads.push(payload);
          return { requestId: String(1600000 + payloads.length) };
        },
      }),
      lookupRequesterProfile: async () => ({ departmentId: "714", jobTitleId: "636", locationId: "3" }),
      identityAdapter: { resolve: async () => ({ oaUserId: "1001" }) },
    },
  });

  // 先 attach 进 inbox，再 prepare 认领，再确认提交。
  const buffered = parse(await factory(context("u1", { mediaPaths: [shot] })).execute("1", { action: "attach" }));
  assert.equal(buffered.code, "BUFFERED");
  const prepared = parse(await factory(context("u1")).execute("2", { action: "prepare", draft }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  assert.equal(prepared.summary.imageCount, 1);
  // 同一人在另一个对话里报新问题：作废上一张、按新问题建单。
  const replacing = parse(await factory(context("u1", { sessionKey: "other-room" })).execute("3", {
    action: "prepare",
    draft: { ...draft, problemDescription: "又一个问题。" },
  }));
  assert.equal(replacing.code, "AWAITING_CONFIRMATION");
  assert.equal(replacing.replacedPrevious, true);
  assert.equal((await getTicket(store, prepared.confirmationId)).status, "cancelled");
  const submitted = parse(await factory(context("u1", { sessionKey: "other-room" })).execute("4", { action: "submit_confirmed", confirmationId: replacing.confirmationId }));
  assert.equal(submitted.code, "SUBMITTED");
  assert.equal(submitted.requestId, "1600001");
  assert.match(submitted.replyZh, /^✅ \*\*已提交到 OA\*\*/);
  const stored = await getTicket(store, replacing.confirmationId);
  assert.equal(stored.status, "submitted");
  assert.equal(stored.draft, null);

  // 未命中兜底：不传类型和系统。
  const fallback = parse(await factory(context("u2")).execute("5", {
    action: "prepare",
    draft: { summary: "帮我把流程退回", problemDescription: "帮我把流程退回。" },
  }));
  assert.equal(fallback.code, "AWAITING_CONFIRMATION");
  assert.equal(fallback.summary.ticketType, "运维支持");
  assert.equal(fallback.summary.systemName, "其他");
  const cancelled = parse(await factory(context("u2")).execute("6", { action: "cancel", confirmationId: fallback.confirmationId }));
  assert.equal(cancelled.code, "CANCELLED");

  // 过期：定时回收记 expired。
  const expiring = parse(await factory(context("u3")).execute("7", { action: "prepare", draft }));
  await db.run("UPDATE oa_ticket SET expires_at = ? WHERE confirmation_id = ?", [Date.now() - 1000, expiring.confirmationId]);
  await cleanupExpired(store, stateDir);
  assert.equal((await getTicket(store, expiring.confirmationId)).status, "expired");

  const person = parse(await factory(context("u1")).execute("8", { action: "status" }));
  assert.equal(person.code, "PERSON_STATUS");
  assert.equal(person.submittedCount, 1);
  assert.equal((await listRecentTickets(store, stored.identity))[0].requestId, "1600001");

  // 唯一约束：同一人第二张占名额的单在库层面也写不进去。
  const again = parse(await factory(context("u4")).execute("9", { action: "prepare", draft }));
  await assert.rejects(
    db.run(
      `INSERT INTO oa_ticket (confirmation_id, external_ticket_id, sender_code, session_code, status, active_sender, expires_at, created_at, updated_at)
       SELECT 'OA-DUP-TEST-000000', 'IT-X', sender_code, session_code, 'awaiting_confirmation', sender_code, 1, 1, 1 FROM oa_ticket WHERE confirmation_id = ?`,
      [again.confirmationId],
    ),
    (error) => error.code === "ER_DUP_ENTRY",
  );
});
