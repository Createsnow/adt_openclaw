import path from "node:path";

/** `attach` 在 prepare 之前落盘用的会话目录，和 `staging/{confirmationId}/` 同级，便于同一套 GC 回收。 */
const INBOX_DIR_RE = /^inbox-([0-9a-f]{24})-([0-9a-f]{24})$/;

export function stagingPaths(stateDir) {
  const root = path.join(stateDir, "oa-workflow-bridge-redis");
  return { root, stagingRoot: path.join(root, "staging") };
}

export function inboxDirName(identity, session) {
  if (!/^[0-9a-f]{24}$/.test(String(identity)) || !/^[0-9a-f]{24}$/.test(String(session))) {
    throw new Error("Invalid OA inbox owner");
  }
  return `inbox-${identity}-${session}`;
}

export function parseInboxDirName(name) {
  const match = INBOX_DIR_RE.exec(String(name || ""));
  return match ? { identity: match[1], session: match[2] } : null;
}
