import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryStateStore } from "../src/redis-client.mjs";
import { inboxDirName, stagingPaths } from "../src/staging.mjs";
import { cleanupExpiredStaging, commitTicketState, setInbox } from "../src/state-store.mjs";

async function makeStagingDir(stateDir, confirmationId, ageMs = 0) {
  const { stagingRoot } = stagingPaths(stateDir);
  const dir = path.join(stagingRoot, confirmationId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "01-附件.pdf"), "x");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await utimes(dir, when, when);
  }
  return dir;
}

async function listStaging(stateDir) {
  const { stagingRoot } = stagingPaths(stateDir);
  return (await readdir(stagingRoot)).sort();
}

test("并发 prepare：刚落盘、pending 尚未写入的目录不会被别人的 GC 删掉", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oa-gc-race-"));
  const store = createMemoryStateStore("gc-race");

  // 会话 A 已经 prepare 完成，pending 有效。
  await makeStagingDir(stateDir, "OA-SESSION-AAAAAAAA");
  await commitTicketState(store, {
    pending: {
      confirmationId: "OA-SESSION-AAAAAAAA",
      draft: { externalTicketId: "IT-A" },
      expiresAt: Date.now() + 60_000,
    },
    ledger: { status: "awaiting_confirmation", confirmationId: "OA-SESSION-AAAAAAAA", externalTicketId: "IT-A" },
  });

  // 会话 B 正在 stageAttachments：目录已在磁盘上，pending 还没进 Redis。
  await makeStagingDir(stateDir, "OA-SESSION-BBBBBBBB");

  const removed = await cleanupExpiredStaging(store, stateDir, Date.now());

  assert.equal(removed, 0);
  assert.deepEqual(await listStaging(stateDir), ["OA-SESSION-AAAAAAAA", "OA-SESSION-BBBBBBBB"]);
});

test("真正的孤儿目录（无 pending 且已超过宽限期）仍会被回收", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oa-gc-orphan-"));
  const store = createMemoryStateStore("gc-orphan");
  await makeStagingDir(stateDir, "OA-ORPHAN-CCCCCCCC", 30 * 60 * 1000);

  const removed = await cleanupExpiredStaging(store, stateDir, Date.now());

  assert.equal(removed, 1);
  assert.deepEqual(await listStaging(stateDir), []);
});

test("inbox 目录跟着 Redis 记录走：记录还在就留着，过期了才回收", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oa-gc-inbox-"));
  const store = createMemoryStateStore("gc-inbox");
  const identity = "a".repeat(24);
  const session = "b".repeat(24);
  const live = inboxDirName(identity, session);
  const orphan = inboxDirName("c".repeat(24), "d".repeat(24));
  await makeStagingDir(stateDir, live);
  await makeStagingDir(stateDir, orphan, 30 * 60 * 1000);
  await setInbox(store, identity, session, { items: [] }, 60_000);

  const removed = await cleanupExpiredStaging(store, stateDir, Date.now());

  assert.equal(removed, 1);
  assert.deepEqual(await listStaging(stateDir), [live]);
});

test("pending 已过期的目录照常回收，不受宽限期影响", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oa-gc-expired-"));
  const store = createMemoryStateStore("gc-expired");
  await makeStagingDir(stateDir, "OA-EXPIRED-DDDDDDDD");
  await commitTicketState(store, {
    pending: {
      confirmationId: "OA-EXPIRED-DDDDDDDD",
      draft: { externalTicketId: "IT-D" },
      expiresAt: Date.now() - 1000,
    },
    ledger: { status: "awaiting_confirmation", confirmationId: "OA-EXPIRED-DDDDDDDD", externalTicketId: "IT-D" },
  });

  const removed = await cleanupExpiredStaging(store, stateDir, Date.now());

  assert.equal(removed, 1);
  assert.deepEqual(await listStaging(stateDir), []);
});

test("提交中或对账中的过期 pending 不回收 staging", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oa-gc-inflight-"));
  const store = createMemoryStateStore("gc-inflight");
  await makeStagingDir(stateDir, "OA-SUBMITTING-EEEEEEEE");
  await makeStagingDir(stateDir, "OA-UNKNOWN-FFFFFFFF");
  await commitTicketState(store, {
    pending: {
      confirmationId: "OA-SUBMITTING-EEEEEEEE",
      draft: { externalTicketId: "IT-E" },
      expiresAt: Date.now() - 1000,
      submissionState: "submitting",
    },
    ledger: { status: "submitting", confirmationId: "OA-SUBMITTING-EEEEEEEE", externalTicketId: "IT-E" },
  });
  await commitTicketState(store, {
    pending: {
      confirmationId: "OA-UNKNOWN-FFFFFFFF",
      draft: { externalTicketId: "IT-F" },
      expiresAt: Date.now() - 1000,
      submissionState: "unknown",
    },
    ledger: { status: "unknown", confirmationId: "OA-UNKNOWN-FFFFFFFF", externalTicketId: "IT-F" },
  });

  const removed = await cleanupExpiredStaging(store, stateDir, Date.now());

  assert.equal(removed, 0);
  assert.deepEqual(await listStaging(stateDir), ["OA-SUBMITTING-EEEEEEEE", "OA-UNKNOWN-FFFFFFFF"]);
});
