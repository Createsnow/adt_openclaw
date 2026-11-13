import { AsyncLocalStorage } from "node:async_hooks";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { inboxDirName, parseInboxDirName, stagingPaths } from "./staging.mjs";

/** pending 落 Redis 时多给的宽限，留给到期后的人工对账。 */
const PENDING_TTL_GRACE_MS = 60 * 1000;

/**
 * prepare 先把附件拷进 staging，再写 pending。这中间目录在磁盘上但 Redis 查不到，
 * 并发的另一次 prepare 触发 GC 时不能把它当孤儿删掉，所以新目录一律先放过。
 */
const STAGING_ORPHAN_GRACE_MS = 10 * 60 * 1000;

let stateQueue = Promise.resolve();
const stateLockContext = new AsyncLocalStorage();

function pendingKey(store, confirmationId) {
  return `${store.keyPrefix}:pending:${confirmationId}`;
}

function ledgerKey(store, externalTicketId) {
  return `${store.keyPrefix}:ledger:${externalTicketId}`;
}

function confirmationIndexKey(store, confirmationId) {
  return `${store.keyPrefix}:idx:confirmation:${confirmationId}`;
}

/** 同一提交人 + 同一 OpenClaw 会话的待确认索引（兼容旧 key）。 */
function sessionPendingKey(store, identity, session) {
  return `${store.keyPrefix}:pending-idx:${identity}:${session}`;
}

/** 同一提交人全局最多一张待确认单，跨 `/new` 仍可查状态、确认或取消。 */
function personPendingKey(store, identity) {
  return `${store.keyPrefix}:person-pending:${identity}`;
}

/** 该人最近工单状态（已提交 / 已取消 / 已过期等），不含草稿正文与附件路径。 */
function personTicketsKey(store, identity) {
  return `${store.keyPrefix}:person-tickets:${identity}`;
}

function inboxKey(store, identity, session) {
  return `${store.keyPrefix}:inbox:${identity}:${session}`;
}

/** 该人当前建单前 inbox 落在哪个 session 码上。换会话时用来清掉旧 inbox，避免 SCAN。 */
function personInboxKey(store, identity) {
  return `${store.keyPrefix}:person-inbox:${identity}`;
}

const PERSON_TICKET_LIMIT = 20;
const PERSON_TICKET_STATUSES = new Set(["submitted", "cancelled", "expired", "failed", "unknown"]);

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is unreadable`);
  }
}

export async function getPending(store, confirmationId) {
  if (!confirmationId) return null;
  const raw = await store.redis.get(pendingKey(store, confirmationId));
  return raw === null ? null : parseJson(raw, "OA pending record");
}

export async function getLedger(store, externalTicketId) {
  if (!externalTicketId) return null;
  const raw = await store.redis.get(ledgerKey(store, externalTicketId));
  return raw === null ? null : parseJson(raw, "OA ledger record");
}

export async function getSessionPendingId(store, identity, session) {
  if (!identity || !session) return "";
  return (await store.redis.get(sessionPendingKey(store, identity, session))) || "";
}

export async function getPersonPendingId(store, identity) {
  if (!identity) return "";
  return (await store.redis.get(personPendingKey(store, identity))) || "";
}

export async function getPersonTickets(store, identity) {
  if (!identity) return [];
  const raw = await store.redis.get(personTicketsKey(store, identity));
  if (!raw) return [];
  const parsed = parseJson(raw, "OA person tickets");
  return Array.isArray(parsed) ? parsed : [];
}

function upsertPersonTickets(list, entry) {
  if (!entry?.confirmationId) return list;
  return [entry, ...list.filter((item) => item.confirmationId !== entry.confirmationId)].slice(0, PERSON_TICKET_LIMIT);
}

export async function getInbox(store, identity, session) {
  if (!identity || !session) return null;
  const raw = await store.redis.get(inboxKey(store, identity, session));
  return raw === null ? null : parseJson(raw, "OA inbox record");
}

export async function getPersonInboxSession(store, identity) {
  if (!identity) return "";
  return (await store.redis.get(personInboxKey(store, identity))) || "";
}

export async function setInbox(store, identity, session, entry, ttlMs) {
  const px = { PX: Math.max(1000, Math.ceil(ttlMs)) };
  const multi = store.redis.multi();
  multi.set(inboxKey(store, identity, session), JSON.stringify(entry), px);
  multi.set(personInboxKey(store, identity), session, px);
  await multi.exec();
}

export async function removeInbox(store, identity, session) {
  if (!identity || !session) return;
  const pointed = await getPersonInboxSession(store, identity);
  const multi = store.redis.multi();
  multi.del(inboxKey(store, identity, session));
  if (!pointed || pointed === session) {
    multi.del(personInboxKey(store, identity));
  }
  await multi.exec();
}

/**
 * 丢掉该人尚未 prepare 的 inbox（Redis + 本机目录）。
 * `/new`、空闲自动新会话、或 sessionId 已变时调用。不碰 pending。
 */
export async function wipePersonInbox(store, stateDir, identity, extraSession) {
  if (!identity) return [];
  const sessions = new Set();
  const pointed = await getPersonInboxSession(store, identity);
  if (pointed) sessions.add(pointed);
  if (extraSession) sessions.add(extraSession);
  const wiped = [];
  for (const session of sessions) {
    await store.redis.del(inboxKey(store, identity, session));
    await removeInboxDirectory(stateDir, identity, session);
    wiped.push(session);
  }
  if (identity) await store.redis.del(personInboxKey(store, identity));
  return wiped;
}

export async function getLedgerByConfirmation(store, confirmationId) {
  if (!confirmationId) return null;
  const ticketId = await store.redis.get(confirmationIndexKey(store, confirmationId));
  if (!ticketId) return null;
  const ledger = await getLedger(store, ticketId);
  if (!ledger || ledger.confirmationId !== confirmationId) return null;
  return ledger;
}

/** 用户既不确认也不取消时，靠 Redis TTL 自动回收 pending，不留常驻 key。 */
function pendingSetOptions(pending, now = Date.now()) {
  const expiresAt = Number(pending?.expiresAt);
  if (!Number.isFinite(expiresAt)) return undefined;
  return { PX: Math.max(1000, Math.ceil(expiresAt - now + PENDING_TTL_GRACE_MS)) };
}

export async function commitTicketState(store, { pending, ledger, removePendingId, removeSessionRef } = {}) {
  const staleIndexIds = [];
  if (ledger?.externalTicketId && ledger.confirmationId) {
    const previous = await getLedger(store, ledger.externalTicketId);
    if (previous?.confirmationId && previous.confirmationId !== ledger.confirmationId) {
      staleIndexIds.push(previous.confirmationId);
    }
  }
  const personIdentity = ledger?.identity || pending?.identity || removeSessionRef?.identity;
  let nextPersonTickets;
  if (personIdentity && ledger && PERSON_TICKET_STATUSES.has(ledger.status)) {
    nextPersonTickets = upsertPersonTickets(await getPersonTickets(store, personIdentity), {
      confirmationId: ledger.confirmationId,
      status: ledger.status,
      requestId: ledger.requestId || null,
      updatedAt: ledger.updatedAt,
    });
  }
  const currentPersonPending = personIdentity ? await getPersonPendingId(store, personIdentity) : "";
  const multi = store.redis.multi();
  if (removePendingId) {
    multi.del(pendingKey(store, removePendingId));
  }
  if (removeSessionRef?.identity && removeSessionRef?.session) {
    multi.del(sessionPendingKey(store, removeSessionRef.identity, removeSessionRef.session));
  }
  if (removePendingId && personIdentity && currentPersonPending === removePendingId) {
    multi.del(personPendingKey(store, personIdentity));
  }
  if (pending) {
    multi.set(pendingKey(store, pending.confirmationId), JSON.stringify(pending), pendingSetOptions(pending));
    const ticketId = pending.draft?.externalTicketId;
    if (ticketId) {
      multi.set(confirmationIndexKey(store, pending.confirmationId), ticketId);
    }
    if (pending.identity && pending.session) {
      multi.set(
        sessionPendingKey(store, pending.identity, pending.session),
        pending.confirmationId,
        pendingSetOptions(pending),
      );
    }
    if (pending.identity) {
      multi.set(
        personPendingKey(store, pending.identity),
        pending.confirmationId,
        pendingSetOptions(pending),
      );
    }
  }
  if (ledger) {
    const ticketId = ledger.externalTicketId;
    if (!ticketId) throw new Error("Ledger record requires externalTicketId");
    multi.set(ledgerKey(store, ticketId), JSON.stringify(ledger));
    if (ledger.confirmationId) {
      multi.set(confirmationIndexKey(store, ledger.confirmationId), ticketId);
    }
  }
  if (nextPersonTickets && personIdentity) {
    multi.set(personTicketsKey(store, personIdentity), JSON.stringify(nextPersonTickets));
  }
  for (const confirmationId of staleIndexIds) {
    multi.del(confirmationIndexKey(store, confirmationId));
    if (confirmationId !== pending?.confirmationId && confirmationId !== removePendingId) {
      multi.del(pendingKey(store, confirmationId));
    }
  }
  await multi.exec();
}

export async function withStateLock(_store, callback) {
  if (stateLockContext.getStore()) return callback();
  const previous = stateQueue;
  let release;
  stateQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await stateLockContext.run(true, callback);
  } finally {
    release();
  }
}

export async function removeStagingDirectory(stateDir, confirmationId) {
  if (!/^OA-[A-Z0-9-]{12,80}$/.test(confirmationId)) return;
  await removeStagingDirByName(stateDir, confirmationId);
}

export async function removeInboxDirectory(stateDir, identity, session) {
  await removeStagingDirByName(stateDir, inboxDirName(identity, session));
}

async function removeStagingDirByName(stateDir, name) {
  const { stagingRoot } = stagingPaths(stateDir);
  const target = path.join(stagingRoot, name);
  const resolvedRoot = path.resolve(stagingRoot);
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Invalid staging path");
  await rm(resolvedTarget, { recursive: true, force: true });
}

export async function cleanupExpiredStaging(store, stateDir, now = Date.now()) {
  const { stagingRoot } = stagingPaths(stateDir);
  let names;
  try {
    names = await readdir(stagingRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    const inboxOwner = parseInboxDirName(name);
    if (inboxOwner) {
      // inbox 的权威是那条带 TTL 的 Redis key；key 一过期，目录就是孤儿。
      const inbox = await getInbox(store, inboxOwner.identity, inboxOwner.session);
      if (inbox || await isFreshStagingDir(stagingRoot, name, now)) continue;
      await removeStagingDirByName(stateDir, name);
      removed += 1;
      continue;
    }
    if (!/^OA-[A-Z0-9-]{12,80}$/.test(name)) continue;
    const pending = await getPending(store, name);
    if (pending) {
      if (Number(pending.expiresAt) > now) continue;
      const state = String(pending.submissionState || "").toLowerCase();
      if (state === "submitting" || state === "unknown") continue;
    } else if (await isFreshStagingDir(stagingRoot, name, now)) {
      continue;
    }
    await removeStagingDirectory(stateDir, name);
    removed += 1;
  }
  return removed;
}

async function isFreshStagingDir(stagingRoot, name, now) {
  try {
    const info = await stat(path.join(stagingRoot, name));
    return now - info.mtimeMs < STAGING_ORPHAN_GRACE_MS;
  } catch {
    return false;
  }
}
