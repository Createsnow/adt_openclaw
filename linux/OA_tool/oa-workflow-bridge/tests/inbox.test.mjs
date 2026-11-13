import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureInbound, clearInboxItems, moveInboxToTicket, takeInboxNotices } from "../src/inbox.mjs";
import { inboxDirName, readInbox, stagingPaths } from "../src/store.mjs";
import { identityCode } from "../src/trust.mjs";
import { createTestStore } from "./helpers.mjs";

const CONFIG = { maxAttachmentBytes: 64, maxTotalAttachmentBytes: 100, inboxTtlMinutes: 30 };
const SENDER = "wo0vXZbQAAw1RkQccme3mRCuO0ChEJ9g";
const DM_KEY = `agent:itservicedeskagent:wecom:direct:${SENDER.toLowerCase()}`;

async function scratch(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-inbox-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const inbound = path.join(stateDir, "media", "inbound");
  const workspaceInbound = path.join(stateDir, "workspace", "media", "inbound");
  await mkdir(inbound, { recursive: true });
  await mkdir(workspaceInbound, { recursive: true });
  return { stateDir, inbound, workspaceInbound };
}

function capture(store, stateDir, source, attachments) {
  return captureInbound({ store, stateDir, config: CONFIG, source, attachments });
}

test("hook 一收到附件就落盘入库；多个 hook 与工具 ctx 重复上报只收一份", async (t) => {
  const { stateDir, inbound, workspaceInbound } = await scratch(t);
  const name = "shot---7a891af1-0fe6-41fe-a333-21d04595c497.png";
  await writeFile(path.join(inbound, name), "img");
  await writeFile(path.join(workspaceInbound, name), "img");
  const store = createTestStore();
  // message_received：只有 from.userid + sessionKey
  await capture(store, stateDir, { from: { userid: SENDER }, sessionKey: DM_KEY }, [{ localPath: path.join(inbound, name), fileName: "shot.png" }]);
  // before_prompt_build：同一张图的 workspace 副本
  await capture(store, stateDir, { requesterSenderId: SENDER, sessionKey: DM_KEY }, [{ localPath: path.join(workspaceInbound, name), fileName: "shot.png" }]);
  // 工具 ctx：带 sessionId，同一张图再报一次
  const { inbox } = await capture(store, stateDir, { requesterSenderId: SENDER, sessionKey: DM_KEY, sessionId: "sid-1" }, [{ localPath: path.join(inbound, name) }]);
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].fileName, "shot.png");
  const files = await readdir(path.join(stagingPaths(stateDir).stagingRoot, inboxDirName(identityCode(SENDER))));
  assert.deepEqual(files, ["01-shot.png"]);
});

test("单聊 hook 只有小写 sessionKey、没有发送人时也收得到，工具 ctx 的原始大小写对得上", async (t) => {
  const { stateDir, inbound } = await scratch(t);
  await writeFile(path.join(inbound, "a.png"), "img");
  const store = createTestStore();
  await capture(store, stateDir, { sessionKey: DM_KEY }, [{ localPath: path.join(inbound, "a.png") }]);
  const inbox = await readInbox(store, identityCode(SENDER));
  assert.equal(inbox.items.length, 1);
});

test("群聊 hook 没有发送人时不收（不会把同事的图记到别人名下）", async (t) => {
  const { stateDir, inbound } = await scratch(t);
  await writeFile(path.join(inbound, "g.png"), "img");
  const store = createTestStore();
  assert.equal(await capture(store, stateDir, { sessionKey: "agent:x:wecom:group:CHATID" }, [{ localPath: path.join(inbound, "g.png") }]), null);
});

test("同名不同内容算两份；字节相同的不同 uuid 副本算一份", async (t) => {
  const { stateDir, inbound } = await scratch(t);
  await writeFile(path.join(inbound, "shot---7a891af1-0fe6-41fe-a333-21d04595c497.png"), "same");
  await writeFile(path.join(inbound, "shot---8b902bf2-1ef7-52af-b444-32e15606d5a8.png"), "same");
  await writeFile(path.join(inbound, "shot---9c013cf3-2f08-63b0-c555-43f26717e6b9.png"), "other!");
  const store = createTestStore();
  const source = { requesterSenderId: SENDER, sessionId: "sid-1" };
  const { inbox } = await capture(store, stateDir, source, [
    { localPath: path.join(inbound, "shot---7a891af1-0fe6-41fe-a333-21d04595c497.png"), fileName: "shot.png" },
    { localPath: path.join(inbound, "shot---8b902bf2-1ef7-52af-b444-32e15606d5a8.png"), fileName: "shot.png" },
    { localPath: path.join(inbound, "shot---9c013cf3-2f08-63b0-c555-43f26717e6b9.png"), fileName: "shot.png" },
  ]);
  assert.equal(inbox.items.length, 2);
});

test("换了会话（会话码对不上）先清掉旧 inbox，旧图不串进新会话", async (t) => {
  const { stateDir, inbound } = await scratch(t);
  await writeFile(path.join(inbound, "old.png"), "old");
  await writeFile(path.join(inbound, "new.png"), "new");
  const store = createTestStore();
  await capture(store, stateDir, { requesterSenderId: SENDER, sessionId: "sid-old" }, [{ localPath: path.join(inbound, "old.png") }]);
  const { inbox } = await capture(store, stateDir, { requesterSenderId: SENDER, sessionId: "sid-new" }, [{ localPath: path.join(inbound, "new.png") }]);
  assert.deepEqual(inbox.items.map((item) => item.fileName), ["new.png"]);
});

test("超过单件 / 合计上限的文件不收，记一次超限待报", async (t) => {
  const { stateDir, inbound } = await scratch(t);
  await writeFile(path.join(inbound, "big.bin"), "x".repeat(65));
  await writeFile(path.join(inbound, "ok.png"), "x".repeat(60));
  await writeFile(path.join(inbound, "ok2.png"), "x".repeat(60));
  const store = createTestStore();
  const source = { requesterSenderId: SENDER, sessionId: "sid-1" };
  const { inbox } = await capture(store, stateDir, source, [
    { localPath: path.join(inbound, "big.bin") },
    { localPath: path.join(inbound, "ok.png") },
    { localPath: path.join(inbound, "ok2.png") },
  ]);
  assert.deepEqual(inbox.items.map((item) => item.fileName), ["ok.png"]);
  assert.equal(inbox.rejected, 2);
  const notices = await takeInboxNotices(store, identityCode(SENDER), inbox, CONFIG);
  assert.equal(notices.rejected, 2);
  assert.equal((await readInbox(store, identityCode(SENDER))).rejected, 0);
});

test("30 分钟没动的 inbox 清掉附件，下一次回执提示已过期", async (t) => {
  const { stateDir, inbound } = await scratch(t);
  await writeFile(path.join(inbound, "late.png"), "img");
  const store = createTestStore();
  const started = Date.now();
  const source = { requesterSenderId: SENDER, sessionId: "sid-1" };
  await capture(store, stateDir, source, [{ localPath: path.join(inbound, "late.png") }]);
  store.now = () => started + 31 * 60 * 1000;
  const { inbox } = await capture(store, stateDir, source, []);
  assert.equal(inbox.items.length, 0);
  assert.equal(inbox.expiredNotice, true);
  assert.equal((await takeInboxNotices(store, identityCode(SENDER), inbox, CONFIG)).expired, true);
});

test("搬进工单后 inbox 只留去重键：同一张图再报也不会重复收", async (t) => {
  const { stateDir, inbound } = await scratch(t);
  await writeFile(path.join(inbound, "a.png"), "img");
  const store = createTestStore();
  const source = { requesterSenderId: SENDER, sessionId: "sid-1" };
  const { identity, inbox } = await capture(store, stateDir, source, [{ localPath: path.join(inbound, "a.png") }]);
  const moved = await moveInboxToTicket({ store, stateDir, config: CONFIG, identity, inbox, confirmationId: "OA-TEST-AAAAAAAAAAAA", staged: [] });
  assert.equal(moved.length, 1);
  await clearInboxItems(store, identity, inbox, CONFIG);
  assert.deepEqual(await readdir(path.join(stagingPaths(stateDir).stagingRoot, "OA-TEST-AAAAAAAAAAAA")), ["01-a.png"]);
  const again = await capture(store, stateDir, source, [{ localPath: path.join(inbound, "a.png") }]);
  assert.equal(again.inbox.items.length, 0);
});

test("搬进工单会超工单上限时整批丢弃并报超限，工单不变", async (t) => {
  const { stateDir, inbound } = await scratch(t);
  await writeFile(path.join(inbound, "a.png"), "x".repeat(60));
  const store = createTestStore();
  const source = { requesterSenderId: SENDER, sessionId: "sid-1" };
  const { identity, inbox } = await capture(store, stateDir, source, [{ localPath: path.join(inbound, "a.png") }]);
  await assert.rejects(
    moveInboxToTicket({ store, stateDir, config: CONFIG, identity, inbox, confirmationId: "OA-TEST-BBBBBBBBBBBB", staged: [{ size: 60 }] }),
    (error) => error.code === "ATTACHMENT_LIMIT_EXCEEDED",
  );
  assert.equal((await readInbox(store, identity)).items.length, 0);
});
