import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupExpired, getTicket, inboxDirName, insertTicket, setInbox, stagingPaths } from "../src/store.mjs";
import { createTestStore, setStatus } from "./helpers.mjs";

async function makeStagingDir(stateDir, name, ageMs = 0) {
  const { stagingRoot } = stagingPaths(stateDir);
  const dir = path.join(stagingRoot, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "01-附件.pdf"), "x");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await utimes(dir, when, when);
  }
  return dir;
}

async function listStaging(stateDir) {
  return (await readdir(stagingPaths(stateDir).stagingRoot)).sort();
}

let seq = 0;
async function addTicket(store, confirmationId, expiresAt) {
  seq += 1;
  await insertTicket(store, {
    confirmationId,
    identity: String(seq).padStart(24, "0"),
    session: "b".repeat(24),
    oaRequesterId: "1001",
    draft: { externalTicketId: `IT-20260101-000000-${String(seq).padStart(4, "0")}`, summary: "x" },
    staged: [],
    expiresAt,
  });
}

test("并发 prepare：刚落盘、工单尚未写入的目录不会被别人的 GC 删掉", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oa-gc-race-"));
  const store = createTestStore();
  await makeStagingDir(stateDir, "OA-SESSION-AAAAAAAA");
  await addTicket(store, "OA-SESSION-AAAAAAAA", Date.now() + 60_000);
  // 会话 B 正在 stageAttachments：目录已在磁盘上，工单还没落库。
  await makeStagingDir(stateDir, "OA-SESSION-BBBBBBBB");

  assert.equal(await cleanupExpired(store, stateDir, Date.now()), 0);
  assert.deepEqual(await listStaging(stateDir), ["OA-SESSION-AAAAAAAA", "OA-SESSION-BBBBBBBB"]);
});

test("真正的孤儿目录（库里没有且已超过宽限期）仍会被回收", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oa-gc-orphan-"));
  const store = createTestStore();
  await makeStagingDir(stateDir, "OA-ORPHAN-CCCCCCCC", 30 * 60 * 1000);

  assert.equal(await cleanupExpired(store, stateDir, Date.now()), 1);
  assert.deepEqual(await listStaging(stateDir), []);
});

test("inbox 目录跟着库里记录走：记录还在就留着，过期了才回收", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oa-gc-inbox-"));
  const store = createTestStore();
  const identity = "a".repeat(24);
  const session = "b".repeat(24);
  const live = inboxDirName(identity, session);
  const orphan = inboxDirName("c".repeat(24), "d".repeat(24));
  await makeStagingDir(stateDir, live);
  await makeStagingDir(stateDir, orphan, 30 * 60 * 1000);
  await setInbox(store, identity, session, [], 60_000);

  assert.equal(await cleanupExpired(store, stateDir, Date.now()), 1);
  assert.deepEqual(await listStaging(stateDir), [live]);
});

test("待确认到期：记 expired、清描述，目录照常回收，不受宽限期影响", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oa-gc-expired-"));
  const store = createTestStore();
  await makeStagingDir(stateDir, "OA-EXPIRED-DDDDDDDD");
  await addTicket(store, "OA-EXPIRED-DDDDDDDD", Date.now() - 1000);

  assert.equal(await cleanupExpired(store, stateDir, Date.now()), 1);
  assert.deepEqual(await listStaging(stateDir), []);
  const ticket = await getTicket(store, "OA-EXPIRED-DDDDDDDD");
  assert.equal(ticket.status, "expired");
  assert.equal(ticket.draft, null);
});

test("提交中或对账中的过期单不回收 staging，也不改状态", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oa-gc-inflight-"));
  const store = createTestStore();
  await makeStagingDir(stateDir, "OA-SUBMITTING-EEEEEEEE");
  await makeStagingDir(stateDir, "OA-UNKNOWN-FFFFFFFF");
  await addTicket(store, "OA-SUBMITTING-EEEEEEEE", Date.now() - 1000);
  await addTicket(store, "OA-UNKNOWN-FFFFFFFF", Date.now() - 1000);
  await setStatus(store, "OA-SUBMITTING-EEEEEEEE", "submitting");
  await setStatus(store, "OA-UNKNOWN-FFFFFFFF", "unknown");

  assert.equal(await cleanupExpired(store, stateDir, Date.now()), 0);
  assert.deepEqual(await listStaging(stateDir), ["OA-SUBMITTING-EEEEEEEE", "OA-UNKNOWN-FFFFFFFF"]);
  assert.equal((await getTicket(store, "OA-UNKNOWN-FFFFFFFF")).status, "unknown");
});

test("过期的身份缓存与 inbox 记录被删除", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oa-gc-rows-"));
  const store = createTestStore();
  await setInbox(store, "a".repeat(24), "b".repeat(24), [], 1000);
  await store.db.run("INSERT INTO oa_identity (mapping_code, oa_user_id, miss_code, expires_at) VALUES (?, ?, NULL, ?)", ["e".repeat(24), "1", Date.now() - 1]);
  store.now = () => Date.now() + 5000;
  await cleanupExpired(store, stateDir, Date.now());
  assert.equal((await store.db.query("SELECT COUNT(*) AS n FROM oa_inbox"))[0].n, 0);
  assert.equal((await store.db.query("SELECT COUNT(*) AS n FROM oa_identity"))[0].n, 0);
});

test("同一人同时只能有一张占名额的单：数据库唯一约束兜底", async () => {
  const store = createTestStore();
  const base = { identity: "f".repeat(24), session: "b".repeat(24), oaRequesterId: "1", staged: [], expiresAt: Date.now() + 60_000 };
  await insertTicket(store, { ...base, confirmationId: "OA-UNIQUE-AAAAAAAA", draft: { externalTicketId: "IT-20260101-000000-UQ01" } });
  await assert.rejects(
    insertTicket(store, { ...base, confirmationId: "OA-UNIQUE-BBBBBBBB", draft: { externalTicketId: "IT-20260101-000000-UQ02" } }),
    /UNIQUE/,
  );
  await setStatus(store, "OA-UNIQUE-AAAAAAAA", "submitted");
  await insertTicket(store, { ...base, confirmationId: "OA-UNIQUE-CCCCCCCC", draft: { externalTicketId: "IT-20260101-000000-UQ03" } });
});
