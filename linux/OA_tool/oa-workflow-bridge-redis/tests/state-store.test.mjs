import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryStateStore } from "../src/redis-client.mjs";
import {
  commitTicketState,
  getLedger,
  getLedgerByConfirmation,
  getPending,
  getPersonPendingId,
  getPersonTickets,
  withStateLock,
} from "../src/state-store.mjs";

test("按 key 读写 pending 与 ledger，不碰其它工单", async () => {
  const store = createMemoryStateStore("test-bridge");
  assert.equal(await getPending(store, "OA-TEST-1"), null);
  assert.equal(await getLedger(store, "IT-20260805-121500-A1B2"), null);

  await commitTicketState(store, {
    pending: {
      confirmationId: "OA-TEST-1",
      identity: "abc",
      session: "def",
      draft: { externalTicketId: "IT-20260805-121500-A1B2" },
      expiresAt: Date.now() + 60_000,
    },
    ledger: {
      status: "awaiting_confirmation",
      confirmationId: "OA-TEST-1",
      externalTicketId: "IT-20260805-121500-A1B2",
    },
  });
  await commitTicketState(store, {
    pending: {
      confirmationId: "OA-TEST-2",
      identity: "ghi",
      session: "jkl",
      draft: { externalTicketId: "IT-20260805-121500-C3D4" },
      expiresAt: Date.now() + 60_000,
    },
    ledger: {
      status: "awaiting_confirmation",
      confirmationId: "OA-TEST-2",
      externalTicketId: "IT-20260805-121500-C3D4",
    },
  });

  await commitTicketState(store, {
    pending: {
      confirmationId: "OA-TEST-1",
      identity: "abc",
      session: "def",
      draft: { externalTicketId: "IT-20260805-121500-A1B2" },
      expiresAt: Date.now() + 60_000,
      submissionState: "submitting",
    },
    ledger: {
      status: "submitting",
      confirmationId: "OA-TEST-1",
      externalTicketId: "IT-20260805-121500-A1B2",
    },
  });

  assert.equal((await getPending(store, "OA-TEST-1")).submissionState, "submitting");
  assert.equal((await getPending(store, "OA-TEST-2")).confirmationId, "OA-TEST-2");
  assert.equal((await getLedger(store, "IT-20260805-121500-C3D4")).status, "awaiting_confirmation");
  assert.equal((await getLedgerByConfirmation(store, "OA-TEST-2")).externalTicketId, "IT-20260805-121500-C3D4");
});

test("pending 带 Redis TTL，用户既不确认也不取消时自动回收", async () => {
  const store = createMemoryStateStore("test-ttl");
  await commitTicketState(store, {
    pending: {
      confirmationId: "OA-TTL-1",
      draft: { externalTicketId: "IT-20260805-121500-E5F6" },
      expiresAt: Date.now() + 40,
    },
    ledger: {
      status: "awaiting_confirmation",
      confirmationId: "OA-TTL-1",
      externalTicketId: "IT-20260805-121500-E5F6",
    },
  });
  assert.equal((await getPending(store, "OA-TTL-1")).confirmationId, "OA-TTL-1");
  assert.ok(await store.redis.get("test-ttl:pending:OA-TTL-1"));

  // TTL = expiresAt + 60s 宽限，到点后 key 不该再留在 Redis 里。
  store.redis.now = () => Date.now() + 40 + 60_000 + 10;
  assert.equal(await getPending(store, "OA-TTL-1"), null);
  // ledger 与 confirmation 索引不带 TTL，过期后仍可查到这张单的下落。
  assert.equal((await getLedger(store, "IT-20260805-121500-E5F6")).status, "awaiting_confirmation");
});

test("提交成功只删本张 pending，其它工单仍在", async () => {
  const store = createMemoryStateStore("test-delete-one");
  await commitTicketState(store, {
    pending: {
      confirmationId: "OA-KEEP",
      draft: { externalTicketId: "IT-20260805-121500-KEEP" },
    },
    ledger: {
      status: "awaiting_confirmation",
      confirmationId: "OA-KEEP",
      externalTicketId: "IT-20260805-121500-KEEP",
    },
  });
  await commitTicketState(store, {
    pending: {
      confirmationId: "OA-DROP",
      draft: { externalTicketId: "IT-20260805-121500-DROP" },
    },
    ledger: {
      status: "awaiting_confirmation",
      confirmationId: "OA-DROP",
      externalTicketId: "IT-20260805-121500-DROP",
    },
  });
  await commitTicketState(store, {
    removePendingId: "OA-DROP",
    ledger: {
      status: "submitted",
      confirmationId: "OA-DROP",
      externalTicketId: "IT-20260805-121500-DROP",
      requestId: "1",
    },
  });
  assert.equal(await getPending(store, "OA-DROP"), null);
  assert.equal((await getPending(store, "OA-KEEP")).confirmationId, "OA-KEEP");
  assert.equal((await getLedgerByConfirmation(store, "OA-DROP")).status, "submitted");
});

test("同一工单号重新 prepare 后旧 confirmation 不串到新单", async () => {
  const store = createMemoryStateStore("test-reuse");
  await commitTicketState(store, {
    pending: {
      confirmationId: "OA-OLD",
      draft: { externalTicketId: "IT-20260805-121500-REUSE" },
    },
    ledger: {
      status: "cancelled",
      confirmationId: "OA-OLD",
      identity: "abc",
      session: "def",
      externalTicketId: "IT-20260805-121500-REUSE",
    },
  });
  await commitTicketState(store, {
    pending: {
      confirmationId: "OA-NEW",
      draft: { externalTicketId: "IT-20260805-121500-REUSE" },
    },
    ledger: {
      status: "awaiting_confirmation",
      confirmationId: "OA-NEW",
      identity: "abc",
      session: "def",
      externalTicketId: "IT-20260805-121500-REUSE",
    },
  });

  assert.equal(await getLedgerByConfirmation(store, "OA-OLD"), null);
  assert.equal((await getLedgerByConfirmation(store, "OA-NEW")).status, "awaiting_confirmation");
  assert.equal(await getPending(store, "OA-OLD"), null);
  assert.equal((await getPending(store, "OA-NEW")).confirmationId, "OA-NEW");
  assert.equal(await store.redis.get("test-reuse:idx:confirmation:OA-OLD"), null);
  assert.equal(await store.redis.get("test-reuse:idx:confirmation:OA-NEW"), "IT-20260805-121500-REUSE");
});

test("取消后仍可用原 confirmationId 查 cancelled", async () => {
  const store = createMemoryStateStore("test-cancel-idx");
  await commitTicketState(store, {
    pending: {
      confirmationId: "OA-CANCEL",
      draft: { externalTicketId: "IT-20260805-121500-CANC" },
    },
    ledger: {
      status: "awaiting_confirmation",
      confirmationId: "OA-CANCEL",
      identity: "abc",
      session: "def",
      externalTicketId: "IT-20260805-121500-CANC",
    },
  });
  await commitTicketState(store, {
    removePendingId: "OA-CANCEL",
    ledger: {
      status: "cancelled",
      confirmationId: "OA-CANCEL",
      identity: "abc",
      session: "def",
      externalTicketId: "IT-20260805-121500-CANC",
    },
  });
  assert.equal(await getPending(store, "OA-CANCEL"), null);
  assert.equal((await getLedgerByConfirmation(store, "OA-CANCEL")).status, "cancelled");
});

test("person-pending 跨会话共用，提交后写入 person-tickets", async () => {
  const store = createMemoryStateStore("test-person");
  await commitTicketState(store, {
    pending: {
      confirmationId: "OA-PERSON-1",
      identity: "abc",
      session: "sess-a",
      draft: { externalTicketId: "IT-20260910-120000-P1" },
      expiresAt: Date.now() + 60_000,
    },
    ledger: {
      status: "awaiting_confirmation",
      confirmationId: "OA-PERSON-1",
      identity: "abc",
      session: "sess-a",
      externalTicketId: "IT-20260910-120000-P1",
    },
  });
  assert.equal(await getPersonPendingId(store, "abc"), "OA-PERSON-1");
  assert.deepEqual(await getPersonTickets(store, "abc"), []);

  await commitTicketState(store, {
    removePendingId: "OA-PERSON-1",
    removeSessionRef: { identity: "abc", session: "sess-a" },
    ledger: {
      status: "submitted",
      confirmationId: "OA-PERSON-1",
      identity: "abc",
      session: "sess-a",
      externalTicketId: "IT-20260910-120000-P1",
      requestId: "1500001",
      updatedAt: "2026-09-10T04:00:00.000Z",
    },
  });
  assert.equal(await getPersonPendingId(store, "abc"), "");
  assert.equal((await getPersonTickets(store, "abc"))[0].requestId, "1500001");
  assert.equal((await getPersonTickets(store, "abc"))[0].status, "submitted");
});

test("同进程锁串行化写入", async () => {
  const store = createMemoryStateStore("test-lock");
  const order = [];
  await Promise.all([
    withStateLock(store, async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("a-end");
    }),
    withStateLock(store, async () => {
      order.push("b-start");
      order.push("b-end");
    }),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

test("withStateLock 可重入，嵌套调用不会死等自己", async () => {
  const store = createMemoryStateStore("test-reentrant-lock");
  const result = await Promise.race([
    withStateLock(store, async () => withStateLock(store, async () => "nested-ok")),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("withStateLock nested call deadlocked")), 200);
    }),
  ]);
  assert.equal(result, "nested-ok");
});
