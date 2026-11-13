import { AsyncLocalStorage } from "node:async_hooks";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ACTIVE_TICKET_STATUSES } from "./db.mjs";
import { clearInboundMediaFor, senderIdOf } from "./inbound-media.mjs";
import { identityCode, sessionCode } from "./trust.mjs";

/**
 * 工单状态、建单前 inbox、身份缓存都在 MySQL；图片 / 文档字节在本机 staging，不进库。
 * store 形如 `{ db, now }`：db 见 db.mjs，now 只用于 inbox / 身份缓存的到期判断（测试可替换）。
 */
export function createStore(db, { now = () => Date.now() } = {}) {
  return { db, now };
}

export { ACTIVE_TICKET_STATUSES };
const ACTIVE = new Set(ACTIVE_TICKET_STATUSES);
/** 进入这些状态后清掉描述与附件清单，只留台账（单号、状态、时间）。 */
const TERMINAL = new Set(["submitted", "cancelled", "expired", "failed"]);
/** 查进度「最近记录」列出的状态与条数。 */
const RECENT_STATUSES = ["submitted", "cancelled", "expired", "failed", "unknown"];
const RECENT_LIMIT = 20;

/**
 * prepare 先把附件拷进 staging，再写工单行。这中间目录在磁盘上但库里查不到，
 * 并发的另一次 GC 不能把它当孤儿删掉，所以新目录一律先放过。
 */
const STAGING_ORPHAN_GRACE_MS = 10 * 60 * 1000;
const CONFIRMATION_DIR_RE = /^OA-[A-Z0-9-]{12,80}$/;
const INBOX_DIR_RE = /^inbox-([0-9a-f]{24})-([0-9a-f]{24})$/;

export function isActiveTicket(ticket) {
  return Boolean(ticket && ACTIVE.has(ticket.status));
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("OA ticket record is unreadable");
  }
}

function rowToTicket(row) {
  if (!row) return null;
  return {
    confirmationId: row.confirmation_id,
    externalTicketId: row.external_ticket_id,
    identity: row.sender_code,
    session: row.session_code,
    status: row.status,
    oaRequesterId: row.oa_requester_id || "",
    draft: parseJson(row.draft_json, null),
    staged: parseJson(row.staged_json, []),
    requestId: row.request_id || null,
    errorCode: row.error_code || null,
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// ---------- 工单 ----------

export async function getTicket(store, confirmationId) {
  if (!confirmationId) return null;
  const rows = await store.db.query("SELECT * FROM oa_ticket WHERE confirmation_id = ?", [String(confirmationId)]);
  return rowToTicket(rows[0]);
}

/** 同一内部幂等号最近的一张单（同号取消 / 过期后允许重新 prepare，所以可能有多行）。 */
export async function getLatestTicketByExternalId(store, externalTicketId) {
  if (!externalTicketId) return null;
  const rows = await store.db.query(
    "SELECT * FROM oa_ticket WHERE external_ticket_id = ? ORDER BY created_at DESC LIMIT 1",
    [externalTicketId],
  );
  return rowToTicket(rows[0]);
}

/** 此人当前占着「全局一张待确认」名额的单（待确认 / 提交中 / 待对账）。 */
export async function getActiveTicket(store, identity) {
  if (!identity) return null;
  const rows = await store.db.query("SELECT * FROM oa_ticket WHERE active_sender = ?", [identity]);
  return rowToTicket(rows[0]);
}

export async function listRecentTickets(store, identity) {
  if (!identity) return [];
  const rows = await store.db.query(
    `SELECT confirmation_id, status, request_id, updated_at FROM oa_ticket
      WHERE sender_code = ? AND status IN (${RECENT_STATUSES.map(() => "?").join(",")})
      ORDER BY updated_at DESC LIMIT ${RECENT_LIMIT}`,
    [identity, ...RECENT_STATUSES],
  );
  return rows.map((row) => ({
    confirmationId: row.confirmation_id,
    status: row.status,
    requestId: row.request_id || null,
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  }));
}

export async function insertTicket(store, ticket) {
  const now = Date.now();
  await store.db.run(
    `INSERT INTO oa_ticket (confirmation_id, external_ticket_id, sender_code, session_code, status, active_sender,
      oa_requester_id, draft_json, staged_json, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'awaiting_confirmation', ?, ?, ?, ?, ?, ?, ?)`,
    [
      ticket.confirmationId,
      ticket.draft.externalTicketId,
      ticket.identity,
      ticket.session,
      ticket.identity,
      ticket.oaRequesterId,
      JSON.stringify(ticket.draft),
      JSON.stringify(ticket.staged || []),
      ticket.expiresAt,
      now,
      now,
    ],
  );
}

/**
 * 改一张单的状态 / 附件清单 / OA 结果。进入终态时清空描述与附件清单。
 * `expectStatus` 给了就只在当前状态匹配时才改，返回是否改到。
 */
export async function updateTicket(store, confirmationId, { status, staged, requestId, errorCode, expectStatus } = {}) {
  const sets = ["updated_at = ?"];
  const params = [Date.now()];
  if (status) {
    sets.push("status = ?", ACTIVE.has(status) ? "active_sender = sender_code" : "active_sender = NULL");
    params.push(status);
    if (TERMINAL.has(status)) sets.push("draft_json = NULL", "staged_json = NULL");
  }
  if (staged && !TERMINAL.has(status)) {
    sets.push("staged_json = ?");
    params.push(JSON.stringify(staged));
  }
  if (requestId) {
    sets.push("request_id = ?");
    params.push(String(requestId));
  }
  if (errorCode) {
    sets.push("error_code = ?");
    params.push(String(errorCode).slice(0, 64));
  }
  let sql = `UPDATE oa_ticket SET ${sets.join(", ")} WHERE confirmation_id = ?`;
  params.push(confirmationId);
  if (expectStatus) {
    sql += " AND status = ?";
    params.push(expectStatus);
  }
  return (await store.db.run(sql, params)) > 0;
}

// ---------- 建单前 inbox（每人一行，按 session 判断归属） ----------

export async function getInbox(store, identity, session) {
  if (!identity || !session) return null;
  const rows = await store.db.query(
    "SELECT items_json, updated_at FROM oa_inbox WHERE sender_code = ? AND session_code = ? AND expires_at > ?",
    [identity, session, store.now()],
  );
  if (!rows[0]) return null;
  return {
    items: parseJson(rows[0].items_json, []),
    updatedAt: new Date(Number(rows[0].updated_at)).toISOString(),
  };
}

/** 该人当前 inbox 落在哪个会话（已过期的也算，方便换会话时把旧目录一起清掉）。 */
export async function getInboxSession(store, identity) {
  if (!identity) return "";
  const rows = await store.db.query("SELECT session_code FROM oa_inbox WHERE sender_code = ?", [identity]);
  return rows[0]?.session_code || "";
}

export async function setInbox(store, identity, session, items, ttlMs) {
  const now = store.now();
  await store.db.run(
    "REPLACE INTO oa_inbox (sender_code, session_code, items_json, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [identity, session, JSON.stringify(items), now + Math.max(1000, Math.ceil(ttlMs)), now],
  );
}

/** 删该人在这个会话的 inbox（记录 + 目录）。inbox 已换到别的会话时不动。 */
export async function dropInbox(store, stateDir, identity, session) {
  if (!identity || !session) return;
  await store.db.run("DELETE FROM oa_inbox WHERE sender_code = ? AND session_code = ?", [identity, session]);
  await removeStagingDir(stateDir, inboxDirName(identity, session)).catch(() => {});
}

/** 丢掉该人尚未 prepare 的 inbox（记录 + 目录，含 extraSession 的目录）。不碰工单。 */
export async function wipePersonInbox(store, stateDir, identity, extraSession) {
  if (!identity) return [];
  const sessions = new Set([await getInboxSession(store, identity), extraSession].filter(Boolean));
  await store.db.run("DELETE FROM oa_inbox WHERE sender_code = ?", [identity]);
  for (const session of sessions) await removeStagingDir(stateDir, inboxDirName(identity, session));
  return [...sessions];
}

/**
 * `/new`、群聊 session_end：丢掉尚未 prepare 的附件（进程内 inbound + inbox 记录 + 目录）。
 * 不碰已 prepare 的待确认单（那张仍按人留 24 小时）。
 */
export async function discardUnpreparedInbox({ store, stateDir, source, logger }) {
  const sender = senderIdOf(source);
  if (!sender || !store) {
    clearInboundMediaFor(source);
    return { wiped: [] };
  }
  return withStateLock(store, async () => {
    clearInboundMediaFor(source);
    const wiped = await wipePersonInbox(store, stateDir, identityCode(sender), sessionCode(source));
    if (wiped.length) logger?.info?.(`[oa-workflow-bridge] discarded unprepared inbox sessions=${wiped.length}`);
    return { wiped };
  });
}

// ---------- 身份缓存 ----------

export async function getIdentityCache(store, mappingCode) {
  if (!/^[a-f0-9]{24}$/.test(String(mappingCode))) return { oaUserId: "", missCode: "" };
  const rows = await store.db.query(
    "SELECT oa_user_id, miss_code FROM oa_identity WHERE mapping_code = ? AND expires_at > ?",
    [mappingCode, store.now()],
  );
  return { oaUserId: rows[0]?.oa_user_id || "", missCode: rows[0]?.miss_code || "" };
}

export async function setIdentityCache(store, mappingCode, { oaUserId = null, missCode = null }, ttlMs) {
  if (!/^[a-f0-9]{24}$/.test(String(mappingCode))) return;
  await store.db.run(
    "REPLACE INTO oa_identity (mapping_code, oa_user_id, miss_code, expires_at) VALUES (?, ?, ?, ?)",
    [mappingCode, oaUserId, missCode, store.now() + ttlMs],
  );
}

// ---------- 进程内锁（单 Gateway） ----------

let stateQueue = Promise.resolve();
const stateLockContext = new AsyncLocalStorage();

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

// ---------- 本机 staging ----------

export function stagingPaths(stateDir) {
  const root = path.join(stateDir, "oa-workflow-bridge");
  return { root, stagingRoot: path.join(root, "staging") };
}

/** `attach` 在 prepare 之前落盘用的会话目录，和 `staging/{confirmationId}/` 同级。 */
export function inboxDirName(identity, session) {
  if (!/^[0-9a-f]{24}$/.test(String(identity)) || !/^[0-9a-f]{24}$/.test(String(session))) {
    throw new Error("Invalid OA inbox owner");
  }
  return `inbox-${identity}-${session}`;
}

async function removeStagingDir(stateDir, name) {
  const { stagingRoot } = stagingPaths(stateDir);
  const resolvedRoot = path.resolve(stagingRoot);
  const resolvedTarget = path.resolve(stagingRoot, name);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Invalid staging path");
  await rm(resolvedTarget, { recursive: true, force: true });
}

export async function removeStagingDirectory(stateDir, confirmationId) {
  if (!CONFIRMATION_DIR_RE.test(String(confirmationId))) return;
  await removeStagingDir(stateDir, confirmationId);
}

// ---------- 到期回收 ----------

/** 待确认窗口到期：工单记 expired（清描述 / 附件清单），删该会话 inbox 与本单 staging。 */
export async function expireTicket(store, stateDir, ticket) {
  const expired = await withStateLock(store, async () => {
    const current = await getTicket(store, ticket.confirmationId);
    if (!isActiveTicket(current) || current.expiresAt > Date.now()) return false;
    await updateTicket(store, current.confirmationId, { status: "expired" });
    await dropInbox(store, stateDir, current.identity, current.session);
    return true;
  });
  await removeStagingDirectory(stateDir, ticket.confirmationId).catch(() => {});
  return expired;
}

/**
 * 定时与工具调用后顺带执行：到期待确认单记 expired、删过期 inbox / 身份缓存、回收孤儿 staging 目录。
 * 提交中 / 待对账的单不在这里过期，留给人工对账。
 */
export async function cleanupExpired(store, stateDir, now = Date.now()) {
  const overdue = await store.db.query(
    "SELECT * FROM oa_ticket WHERE status = 'awaiting_confirmation' AND expires_at <= ?",
    [now],
  );
  for (const row of overdue) await expireTicket(store, stateDir, rowToTicket(row));
  await withStateLock(store, () => store.db.run("DELETE FROM oa_inbox WHERE expires_at <= ?", [store.now()]));
  await store.db.run("DELETE FROM oa_identity WHERE expires_at <= ?", [store.now()]);
  return overdue.length + await cleanupStagingDirs(store, stateDir, now);
}

async function cleanupStagingDirs(store, stateDir, now) {
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
    const inboxOwner = INBOX_DIR_RE.exec(name);
    let keep;
    if (inboxOwner) {
      keep = Boolean(await getInbox(store, inboxOwner[1], inboxOwner[2]));
    } else if (CONFIRMATION_DIR_RE.test(name)) {
      const ticket = await getTicket(store, name);
      keep = isActiveTicket(ticket) && (ticket.expiresAt > now || ticket.status !== "awaiting_confirmation");
    } else {
      continue;
    }
    if (keep || await isFreshDir(path.join(stagingRoot, name), now)) continue;
    await removeStagingDir(stateDir, name);
    removed += 1;
  }
  return removed;
}

async function isFreshDir(dir, now) {
  try {
    return now - (await stat(dir)).mtimeMs < STAGING_ORPHAN_GRACE_MS;
  } catch {
    return false;
  }
}
