import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearInboundMedia, dropCancelRestoredInbound, mediaScope, peekInboundMedia, rememberInboundMedia } from "../src/inbound-media.mjs";
import { createMemoryStateStore } from "../src/redis-client.mjs";
import { inboxDirName, stagingPaths } from "../src/staging.mjs";
import { discardUnpreparedInbox } from "../src/inbox-lifecycle.mjs";
import { getInbox, getPending, getPersonPendingId, getSessionPendingId, commitTicketState, withStateLock } from "../src/state-store.mjs";
import { createOAWorkflowToolFactory } from "../src/tool.mjs";

test.beforeEach(() => {
  clearInboundMedia();
});

function parse(result) {
  return JSON.parse(result.content[0].text);
}

function context(sender = "wecom-user-1", session = "room-1", extra = {}) {
  return { messageChannel: "wecom", requesterSenderId: sender, sessionKey: session, ...extra };
}

/** 与 tool.mjs 一致：identity / session 都是 SHA-256 截前 24 位，原始 SenderId 不落盘。 */
function ownerOf(sender = "wecom-user-1", session = "room-1") {
  const digest = (value) => createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 24);
  return { identity: digest(sender), session: digest(session) };
}

function draft(id = "IT-20260908-121500-A1B2") {
  return {
    externalTicketId: id,
    ticketType: "运维支持",
    systemName: "电脑/打印机/网络问题（智园）",
    summary: "电脑死机",
    problemDescription: "电脑死机。",
  };
}

function dependencies({ createRequest } = {}) {
  return {
    loadConfig: async () => ({
      active: true,
      baseUrl: "https://adtekoa.com",
      workflowId: 602,
      isnextflow: "0",
      attachmentFieldName: "scfj",
      pendingTtlHours: 24,
      inboxTtlMinutes: 30,
      maxAttachmentBytes: 1024 * 1024,
      maxTotalAttachmentBytes: 2 * 1024 * 1024,
      identity: { adapter: "on", store: "redis" },
    }),
    loadOptions: async () => new Map([["电脑/打印机/网络问题（智园）", 11]]),
    loadTicketTypeSystems: async () => new Map([["运维支持", new Set(["电脑/打印机/网络问题（智园）"])]]),
    loadSystemHandlers: async () => new Map([["电脑/打印机/网络问题（智园）", "10251"]]),
    resolveSecrets: async (ids) => Object.fromEntries(ids.map((id) => [id, "1001"])),
    clientFactory: () => ({ createRequest: createRequest || (async () => ({ requestId: "1500001" })) }),
    lookupRequesterProfile: async () => ({ departmentId: "714", jobTitleId: "636", locationId: "3" }),
    identityAdapter: {
      getCachedOaUserId: async () => "1001",
      resolve: async () => ({ oaUserId: "1001" }),
    },
  };
}

async function scratch(t, label) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), `aidy-oa-${label}-`));
  t.after(() => {
    clearInboundMedia();
    return rm(stateDir, { recursive: true, force: true });
  });
  const inbound = path.join(stateDir, "media", "inbound");
  await mkdir(inbound, { recursive: true });
  return { stateDir, inbound };
}

function scfjAttachments(payload) {
  const field = payload.mainData.find((item) => item.fieldName === "scfj");
  return field ? JSON.parse(field.fieldValue) : [];
}

test("待确认期间 attach 追加附件：confirmationId 不变，提交时一并随单", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-pending");
  const shot = path.join(inbound, "shot.png");
  const doc = path.join(inbound, "log.txt");
  await writeFile(shot, "image-bytes");
  await writeFile(doc, "document-bytes");

  let capturedPayload;
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`attach-pending-${Date.now()}`),
    dependencies: dependencies({
      createRequest: async (payload) => {
        capturedPayload = payload;
        return { requestId: "1500002" };
      },
    }),
  });

  const prepared = parse(await factory(context()).execute("call-1", { action: "prepare", draft: draft() }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  assert.equal(prepared.summary.attachmentCount, 0);

  const withImage = parse(await factory(context("wecom-user-1", "room-1", { mediaPaths: [shot] })).execute("call-2", {
    action: "attach",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(withImage.code, "ATTACHED");
  assert.equal(withImage.addedCount, 1);
  assert.equal(withImage.attachmentCount, 1);
  assert.equal(withImage.imageCount, 1);
  assert.equal(withImage.confirmationId, prepared.confirmationId);

  const withDoc = parse(await factory(context("wecom-user-1", "room-1", { mediaPaths: [doc] })).execute("call-3", {
    action: "attach",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(withDoc.code, "ATTACHED");
  assert.equal(withDoc.attachmentCount, 2);
  assert.equal(withDoc.documentCount, 1);

  const submitted = parse(await factory(context()).execute("call-4", {
    action: "submit_confirmed",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(submitted.code, "SUBMITTED");
  assert.equal(submitted.attachmentCount, 2);
  assert.equal(submitted.imageCount, 1);
  assert.equal(submitted.documentCount, 1);
  assert.deepEqual(scfjAttachments(capturedPayload).map((item) => item.fileName), ["log.txt"]);
  const description = capturedPayload.mainData.find((field) => field.fieldName === "wtxqmskftp").fieldValue;
  assert.match(description, /alt="shot.png"/);
});

test("建单前 attach 把 openclaw-staged/input- 副本收成 1 份", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-staged-copy");
  const originalName = "企业微信截图_17896400538494---514a3be1-b1a3-4f9d-9ad0-43016a928718.png";
  const configPath = path.join(inbound, originalName);
  const stagedDir = path.join(stateDir, "workspace", "media", "inbound", "openclaw-staged-9f1c2e3a-4b5d-6789-abcd-ef0123456789");
  await mkdir(stagedDir, { recursive: true });
  const stagedPath = path.join(stagedDir, `input-${originalName}`);
  await writeFile(configPath, "image-bytes");
  await writeFile(stagedPath, "image-bytes");

  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`attach-staged-copy-${Date.now()}`),
    dependencies: dependencies(),
  });
  rememberInboundMedia(mediaScope(context()), [
    { localPath: configPath, fileName: "企业微信截图_17896400538494.png" },
    { localPath: stagedPath, fileName: `input-${originalName}` },
  ]);
  const buffered = parse(await factory(context()).execute("call-1", { action: "attach" }));
  assert.equal(buffered.code, "BUFFERED");
  assert.equal(buffered.addedCount, 1);
  assert.equal(buffered.imageCount, 1);
  assert.equal(buffered.hintZh, "📎 已收到 1份图片");
});

test("待确认期间同一张图的 inbound 与 workspace 副本只暂存一份", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-dup-copy");
  const workspaceInbound = path.join(stateDir, "workspace", "media", "inbound");
  await mkdir(workspaceInbound, { recursive: true });
  const name = "企业微信截图_1---7a891af1-0fe6-41fe-a333-21d04595c497.png";
  const configPath = path.join(inbound, name);
  const workspacePath = path.join(workspaceInbound, name);
  await writeFile(configPath, "image-bytes");
  await writeFile(workspacePath, "image-bytes");

  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`attach-dup-copy-${Date.now()}`),
    dependencies: dependencies(),
  });
  const prepared = parse(await factory(context()).execute("call-1", { action: "prepare", draft: draft() }));
  rememberInboundMedia(mediaScope(context()), [
    { localPath: configPath, fileName: "企业微信截图_1.png" },
    { localPath: workspacePath, fileName: "企业微信截图_1.png" },
  ]);
  const attached = parse(await factory(context()).execute("call-2", {
    action: "attach",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(attached.code, "ATTACHED");
  assert.equal(attached.addedCount, 1);
  assert.equal(attached.imageCount, 1);
  assert.equal(attached.hintZh, "📎 已收到 1份图片");
});

test("attach 没收到新文件时返回 NO_NEW_ATTACHMENT，不谎报已收下", async (t) => {
  const { stateDir } = await scratch(t, "attach-empty");
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`attach-empty-${Date.now()}`),
    dependencies: dependencies(),
  });
  const prepared = parse(await factory(context()).execute("call-1", { action: "prepare", draft: draft() }));
  const result = parse(await factory(context()).execute("call-2", {
    action: "attach",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(result.code, "NO_NEW_ATTACHMENT");
  assert.equal(result.addedCount, 0);
  assert.equal(result.attachmentCount, 0);
  assert.match(result.hintZh, /没有检测到新文件/);
});

test("prepare 之前 attach 落到会话 inbox，prepare 认领且不重复暂存", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-inbox");
  const doc = path.join(inbound, "报错截图.png");
  await writeFile(doc, "image-bytes");
  const stateStore = createMemoryStateStore(`attach-inbox-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  const pendingOwner = ownerOf();

  const buffered = parse(await factory(context("wecom-user-1", "room-1", { mediaPaths: [doc] })).execute("call-1", {
    action: "attach",
  }));
  assert.equal(buffered.code, "BUFFERED");
  assert.equal(buffered.addedCount, 1);
  assert.equal(buffered.attachmentCount, 1);
  assert.equal(buffered.confirmationId, undefined);
  assert.equal(buffered.hintZh, "📎 已收到 1份图片");

  // 员工补完地点才建单：本轮 ctx 已经没有媒体路径，附件只能来自 inbox。
  const prepared = parse(await factory(context()).execute("call-2", { action: "prepare", draft: draft() }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  assert.equal(prepared.summary.attachmentCount, 1);
  assert.equal(prepared.summary.imageCount, 1);

  // 认领之后 inbox 目录与 Redis 记录都不该再留下。
  const { stagingRoot } = stagingPaths(stateDir);
  await access(path.join(stagingRoot, prepared.confirmationId));
  await assert.rejects(() => access(path.join(stagingRoot, inboxDirName(pendingOwner.identity, pendingOwner.session))));
  assert.equal(await getInbox(stateStore, pendingOwner.identity, pendingOwner.session), null);
});

test("同会话已有 pending 时 attach 不带 confirmationId 并入该单", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-same-session");
  const shot = path.join(inbound, "late.png");
  await writeFile(shot, "image-bytes");
  const stateStore = createMemoryStateStore(`attach-same-session-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  const pendingOwner = ownerOf();

  const prepared = parse(await factory(context()).execute("call-1", { action: "prepare", draft: draft() }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  assert.equal(prepared.summary.attachmentCount, 0);

  const attached = parse(await factory(context("wecom-user-1", "room-1", { mediaPaths: [shot] })).execute("call-2", {
    action: "attach",
  }));
  assert.equal(attached.code, "ATTACHED");
  assert.notEqual(attached.code, "BUFFERED");
  assert.equal(attached.confirmationId, prepared.confirmationId);
  assert.equal(attached.addedCount, 1);
  assert.equal(attached.attachmentCount, 1);
  assert.equal(attached.imageCount, 1);

  const pending = await getPending(stateStore, prepared.confirmationId);
  assert.equal(pending.staged.length, 1);
  assert.equal(await getInbox(stateStore, pendingOwner.identity, pendingOwner.session), null);
});

test("同一轮里 ctx 与 inbox 指向同一文件时只暂存一次", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-dedupe");
  const shot = path.join(inbound, "same.png");
  await writeFile(shot, "image-bytes");
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`attach-dedupe-${Date.now()}`),
    dependencies: dependencies(),
  });
  const ctx = context("wecom-user-1", "room-1", { mediaPaths: [shot] });
  const buffered = parse(await factory(ctx).execute("call-1", { action: "attach" }));
  assert.equal(buffered.attachmentCount, 1);
  const prepared = parse(await factory(ctx).execute("call-2", { action: "prepare", draft: draft() }));
  assert.equal(prepared.summary.attachmentCount, 1);
});

test("cancel 之后改稿重新 prepare，已暂存的附件不会丢", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-recancel");
  const shot = path.join(inbound, "first.png");
  await writeFile(shot, "image-bytes");
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`attach-recancel-${Date.now()}`),
    dependencies: dependencies(),
  });

  const first = parse(await factory(context("wecom-user-1", "room-1", { mediaPaths: [shot] })).execute("call-1", {
    action: "prepare",
    draft: draft("IT-20260908-121500-AAAA"),
  }));
  assert.equal(first.summary.attachmentCount, 1);

  const cancelled = parse(await factory(context()).execute("call-2", {
    action: "cancel",
    confirmationId: first.confirmationId,
  }));
  assert.equal(cancelled.code, "CANCELLED");
  assert.equal(cancelled.attachmentCount, 1);

  // 改稿后的新单必须还带着那张图：cancel 已经把 staging 副本删了，靠回灌的源路径重新暂存。
  const second = parse(await factory(context()).execute("call-3", {
    action: "prepare",
    draft: { ...draft("IT-20260908-121500-BBBB"), problemDescription: "电脑死机，重启无效。" },
  }));
  assert.equal(second.code, "AWAITING_CONFIRMATION");
  assert.equal(second.summary.attachmentCount, 1);
  assert.equal(second.summary.imageCount, 1);
});

test("明确取消后的下一轮 prepare 不再带旧单附件", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-abort");
  const shot = path.join(inbound, "old.png");
  await writeFile(shot, "image-bytes");
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`attach-abort-${Date.now()}`),
    dependencies: dependencies(),
  });

  const first = parse(await factory(context("wecom-user-1", "room-1", { mediaPaths: [shot] })).execute("call-1", {
    action: "prepare",
    draft: draft("IT-20260908-121500-AAAA"),
  }));
  assert.equal(first.summary.attachmentCount, 1);

  const cancelled = parse(await factory(context()).execute("call-2", {
    action: "cancel",
    confirmationId: first.confirmationId,
  }));
  assert.equal(cancelled.code, "CANCELLED");
  assert.equal(cancelled.attachmentCount, 1);

  // 模拟员工下一句「帮我提交」：message_received 先丢掉 cancel 回灌的旧图。
  assert.equal(dropCancelRestoredInbound(mediaScope(context())), 1);

  const second = parse(await factory(context()).execute("call-3", {
    action: "prepare",
    draft: draft("IT-20260908-121500-BBBB"),
  }));
  assert.equal(second.code, "AWAITING_CONFIRMATION");
  assert.equal(second.summary.attachmentCount, 0);
  assert.equal(second.summary.imageCount, 0);
});

test("同一人同一会话已有待确认单时，另开一张单被 ALREADY_PENDING 挡住", async (t) => {
  const { stateDir } = await scratch(t, "attach-single");
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`attach-single-${Date.now()}`),
    dependencies: dependencies(),
  });
  const first = parse(await factory(context()).execute("call-1", {
    action: "prepare",
    draft: draft("IT-20260908-121500-CCCC"),
  }));
  const second = parse(await factory(context()).execute("call-2", {
    action: "prepare",
    draft: draft("IT-20260908-121600-DDDD"),
  }));
  assert.equal(second.ok, false);
  assert.equal(second.code, "ALREADY_PENDING");
  assert.equal(second.confirmationId, first.confirmationId);
  assert.equal(second.externalTicketId, first.summary.externalTicketId);
  assert.equal(second.summary, "电脑死机");
  assert.equal(second.location, "智园");
  assert.equal(first.location, "智园");
  assert.equal(first.summary.location, "智园");

  // 群聊里另一位同事在同一会话建单不受影响。
  const other = parse(await factory(context("wecom-user-2", "room-1")).execute("call-3", {
    action: "prepare",
    draft: draft("IT-20260908-121700-EEEE"),
  }));
  assert.equal(other.code, "AWAITING_CONFIRMATION");

  // 取消之后同一人可以重新建单。
  parse(await factory(context()).execute("call-4", { action: "cancel", confirmationId: first.confirmationId }));
  const third = parse(await factory(context()).execute("call-5", {
    action: "prepare",
    draft: draft("IT-20260908-121800-FFFF"),
  }));
  assert.equal(third.code, "AWAITING_CONFIRMATION");
});

test("同一条企微消息重复 prepare 时，ALREADY_PENDING 回执仍带 confirmationId", async (t) => {
  const { stateDir } = await scratch(t, "attach-same-message");
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`attach-same-message-${Date.now()}`),
    dependencies: dependencies(),
  });
  // messageId + WeComReceivedAt 固定，两轮算出同一个内部幂等号，走 ledger 幂等拦截而不是 person-pending。
  const ctx = context("wecom-user-1", "room-1", {
    messageId: "af41832830918c2415b6fdbe47eaafd9",
    WeComReceivedAt: "2026-09-08 16:19:19",
  });
  const first = parse(await factory(ctx).execute("call-1", { action: "prepare", draft: draft() }));
  assert.equal(first.code, "AWAITING_CONFIRMATION");

  const retry = parse(await factory(ctx).execute("call-2", { action: "prepare", draft: draft() }));
  assert.equal(retry.ok, false);
  assert.equal(retry.code, "ALREADY_PENDING");
  // 没有这些字段模型既出不了确认卡也出不了拦截卡。
  assert.equal(retry.confirmationId, first.confirmationId);
  assert.equal(retry.externalTicketId, first.summary.externalTicketId);
  assert.equal(retry.sameSession, true);
  assert.equal(retry.summary, "电脑死机");
  assert.equal(retry.location, "智园");
  assert.equal(retry.retentionHours, 24);
  assert.equal(typeof retry.expiresAt, "string");
});

test("并发 prepare 抢锁失败的一方，ALREADY_PENDING 回执同样带 confirmationId", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-race");
  const shot = path.join(inbound, "race.png");
  await writeFile(shot, "image-bytes");
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`attach-race-${Date.now()}`),
    dependencies: dependencies(),
  });
  // 两个不同 messageId，绕开 ledger 幂等，冲突只能在锁内被发现。带附件才会建 staging 目录。
  const ctxOf = (messageId) => context("wecom-user-1", "room-1", {
    messageId,
    WeComReceivedAt: "2026-09-08 16:20:00",
    mediaPaths: [shot],
  });
  const [a, b] = (await Promise.all([
    factory(ctxOf("1111111111111111111111111111aaaa")).execute("call-1", { action: "prepare", draft: draft() }),
    factory(ctxOf("2222222222222222222222222222bbbb")).execute("call-2", { action: "prepare", draft: draft() }),
  ])).map(parse);

  const winner = a.code === "AWAITING_CONFIRMATION" ? a : b;
  const loser = winner === a ? b : a;
  assert.equal(winner.code, "AWAITING_CONFIRMATION");
  assert.equal(loser.ok, false);
  assert.equal(loser.code, "ALREADY_PENDING");
  assert.equal(loser.confirmationId, winner.confirmationId);
  assert.equal(loser.sameSession, true);
  assert.equal(loser.retentionHours, 24);

  // 抢锁失败的一方在锁内才发现冲突，此时它已经建好自己的 staging 目录，必须被回收。
  const { stagingRoot } = stagingPaths(stateDir);
  const leftovers = await readdir(stagingRoot).catch(() => []);
  assert.deepEqual(leftovers.filter((name) => name.startsWith("OA-")), [winner.confirmationId]);
});

test("attach 只认原提交人，别人的 confirmationId 拿不到附件通道", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-sender");
  const shot = path.join(inbound, "other.png");
  await writeFile(shot, "image-bytes");
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`attach-sender-${Date.now()}`),
    dependencies: dependencies(),
  });
  const prepared = parse(await factory(context()).execute("call-1", { action: "prepare", draft: draft() }));
  const denied = parse(await factory(context("wecom-user-2", "room-2", { mediaPaths: [shot] })).execute("call-2", {
    action: "attach",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "SENDER_MISMATCH");
  assert.match(denied.hintZh, /原提交人/);
});

test("附件超过上限时 attach 当场报 ATTACHMENT_LIMIT_EXCEEDED，不等到提交", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-limit");
  const big = path.join(inbound, "big.bin");
  await writeFile(big, Buffer.alloc(2048, 1));
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`attach-limit-${Date.now()}`),
    dependencies: {
      ...dependencies(),
      loadConfig: async () => ({
        active: true,
        baseUrl: "https://adtekoa.com",
        workflowId: 602,
        isnextflow: "0",
        attachmentFieldName: "scfj",
        pendingTtlHours: 24,
        inboxTtlMinutes: 30,
        maxAttachmentBytes: 1024,
        maxTotalAttachmentBytes: 4096,
        identity: { adapter: "on", store: "redis" },
      }),
    },
  });
  const prepared = parse(await factory(context()).execute("call-1", { action: "prepare", draft: draft() }));
  const rejected = parse(await factory(context("wecom-user-1", "room-1", { mediaPaths: [big] })).execute("call-2", {
    action: "attach",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "ATTACHMENT_LIMIT_EXCEEDED");
  assert.match(rejected.hintZh, /10MB/);
});

test("inbox 默认 30 分钟过期，不会跟着 pending 活 24 小时", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-ttl");
  const shot = path.join(inbound, "ttl.png");
  await writeFile(shot, "image-bytes");
  const stateStore = createMemoryStateStore("attach-ttl");
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  const buffered = parse(await factory(context("wecom-user-1", "room-1", { mediaPaths: [shot] })).execute("call-1", {
    action: "attach",
  }));
  assert.equal(buffered.code, "BUFFERED");

  const started = Date.now();
  stateStore.redis.now = () => started + 29 * 60 * 1000;
  assert.ok(await getInbox(stateStore, ownerOf().identity, ownerOf().session));

  stateStore.redis.now = () => started + 30 * 60 * 1000 + 1000;
  const prepared = parse(await factory(context()).execute("call-2", { action: "prepare", draft: draft() }));
  assert.equal(prepared.summary.attachmentCount, 0);
});

test("只 attach 未 prepare 时换 sessionId，新会话 prepare 不得认领旧附件", async (t) => {
  const { stateDir, inbound } = await scratch(t, "inbox-rotate");
  const shot = path.join(inbound, "old.png");
  const doc = path.join(inbound, "old.txt");
  await writeFile(shot, "image-bytes");
  await writeFile(doc, "document-bytes");
  const stateStore = createMemoryStateStore(`inbox-rotate-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  const sessionKey = "agent:itservicedeskagent:wecom:direct:wecom-user-1";
  const buffered = parse(await factory(context("wecom-user-1", sessionKey, {
    sessionId: "session-aaa",
    mediaPaths: [shot, doc],
  })).execute("call-1", { action: "attach" }));
  assert.equal(buffered.code, "BUFFERED");
  assert.equal(buffered.imageCount, 1);
  assert.equal(buffered.documentCount, 1);

  const prepared = parse(await factory(context("wecom-user-1", sessionKey, {
    sessionId: "session-bbb",
  })).execute("call-2", { action: "prepare", draft: draft("IT-20260911-110000-NEW1") }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  assert.equal(prepared.summary.attachmentCount, 0);
  assert.equal(await getInbox(stateStore, ownerOf("wecom-user-1", "session-aaa").identity, ownerOf("wecom-user-1", "session-aaa").session), null);
});

test("/new 清掉尚未 prepare 的 inbox，同一 sessionKey 再 prepare 也带不上旧文件", async (t) => {
  const { stateDir, inbound } = await scratch(t, "inbox-new");
  const shot = path.join(inbound, "before-new.png");
  await writeFile(shot, "image-bytes");
  const stateStore = createMemoryStateStore(`inbox-new-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  const sessionKey = "agent:itservicedeskagent:wecom:direct:wecom-user-1";
  const ctx = context("wecom-user-1", sessionKey, { mediaPaths: [shot] });
  const buffered = parse(await factory(ctx).execute("call-1", { action: "attach" }));
  assert.equal(buffered.code, "BUFFERED");

  const wiped = await discardUnpreparedInbox({ store: stateStore, stateDir, source: ctx });
  assert.ok(wiped.wiped.length >= 1);

  const prepared = parse(await factory(context("wecom-user-1", sessionKey)).execute("call-2", {
    action: "prepare",
    draft: draft("IT-20260911-110100-NEW2"),
  }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  assert.equal(prepared.summary.attachmentCount, 0);
});

test("discardUnpreparedInbox 必须等 inbox 写入锁结束，不能并行清目录", async (t) => {
  const { stateDir } = await scratch(t, "inbox-lock-wait");
  const stateStore = createMemoryStateStore(`inbox-lock-wait-${Date.now()}`);
  const order = [];
  await Promise.all([
    withStateLock(stateStore, async () => {
      order.push("writer-start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("writer-end");
    }),
    discardUnpreparedInbox({
      store: stateStore,
      stateDir,
      source: context("wecom-user-1", "room-1"),
      logger: { info() { order.push("wipe-ran"); } },
    }),
  ]);
  assert.deepEqual(order, ["writer-start", "writer-end", "wipe-ran"]);
});

test("discardUnpreparedInbox 不删已经 prepare 的待确认单", async (t) => {
  const { stateDir, inbound } = await scratch(t, "inbox-keep-pending");
  const shot = path.join(inbound, "kept.png");
  await writeFile(shot, "image-bytes");
  const stateStore = createMemoryStateStore(`inbox-keep-pending-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  const ctx = context("wecom-user-1", "room-1", { mediaPaths: [shot] });
  const prepared = parse(await factory(ctx).execute("call-1", { action: "prepare", draft: draft() }));
  assert.equal(prepared.summary.imageCount, 1);

  await discardUnpreparedInbox({ store: stateStore, stateDir, source: ctx });

  const status = parse(await factory(context()).execute("call-2", { action: "status" }));
  assert.equal(status.code, "PERSON_STATUS");
  assert.equal(status.pending.code, "AWAITING_CONFIRMATION");
  assert.equal(status.pending.imageCount, 1);
});

test("getInbox 只按提交人 + 会话点查，不串到别人", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-scope");
  const shot = path.join(inbound, "scope.png");
  await writeFile(shot, "image-bytes");
  const stateStore = createMemoryStateStore(`attach-scope-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  await factory(context("wecom-user-1", "room-1", { mediaPaths: [shot] })).execute("call-1", { action: "attach" });
  assert.equal(await getInbox(stateStore, "0".repeat(24), "0".repeat(24)), null);
  const prepared = parse(await factory(context("wecom-user-2", "room-1")).execute("call-2", {
    action: "prepare",
    draft: draft("IT-20260908-122000-GGGG"),
  }));
  assert.equal(prepared.summary.attachmentCount, 0);
});

test("同一人换 OpenClaw sessionId 后旧图不串，但能查待确认状态", async (t) => {
  const { stateDir, inbound } = await scratch(t, "session-isolate");
  const shot = path.join(inbound, "old-session.png");
  await writeFile(shot, "image-bytes");
  const stateStore = createMemoryStateStore(`session-isolate-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  const firstCtx = context("wecom-user-1", "wecom:direct:peer", {
    sessionId: "session-aaa",
    mediaPaths: [shot],
  });
  const first = parse(await factory(firstCtx).execute("call-1", { action: "prepare", draft: draft("IT-20260910-110000-AAAA") }));
  assert.equal(first.code, "AWAITING_CONFIRMATION");
  assert.equal(first.summary.imageCount, 1);

  const newCtx = context("wecom-user-1", "wecom:direct:peer", { sessionId: "session-bbb" });
  const blocked = parse(await factory(newCtx).execute("call-2", { action: "prepare", draft: draft("IT-20260910-110100-BBBB") }));
  assert.equal(blocked.code, "ALREADY_PENDING");
  assert.equal(blocked.confirmationId, first.confirmationId);

  const person = parse(await factory(newCtx).execute("call-3", { action: "status" }));
  assert.equal(person.code, "PERSON_STATUS");
  assert.equal(person.pending.confirmationId, first.confirmationId);
  assert.equal(person.pending.code, "AWAITING_CONFIRMATION");
  assert.equal(person.pending.summary, "电脑死机");
  assert.equal(person.pending.location, "智园");
  assert.equal(person.pending.problemDescription, undefined);
  assert.equal(person.hintZh, undefined);

  const cancelled = parse(await factory(newCtx).execute("call-4", {
    action: "cancel",
    confirmationId: first.confirmationId,
  }));
  assert.equal(cancelled.code, "CANCELLED");
  assert.equal(cancelled.summary, "电脑死机");
  assert.equal(cancelled.location, "智园");

  const afterCancel = parse(await factory(newCtx).execute("call-5", {
    action: "prepare",
    draft: draft("IT-20260910-110200-CCCC"),
  }));
  assert.equal(afterCancel.code, "AWAITING_CONFIRMATION");
  assert.equal(afterCancel.summary.attachmentCount, 0);
});

test("新会话不能给上一会话的待确认单补附件，确认时也不并入新图", async (t) => {
  const { stateDir, inbound } = await scratch(t, "session-lock");
  const oldShot = path.join(inbound, "old-session.png");
  const newShot = path.join(inbound, "new-session.png");
  await writeFile(oldShot, "image-old");
  await writeFile(newShot, "image-new");
  let capturedPayload;
  const stateStore = createMemoryStateStore(`session-lock-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({
      createRequest: async (payload) => {
        capturedPayload = payload;
        return { requestId: "1500009" };
      },
    }),
  });
  const firstCtx = context("wecom-user-1", "wecom:direct:peer", {
    sessionId: "session-aaa",
    mediaPaths: [oldShot],
  });
  const first = parse(await factory(firstCtx).execute("call-1", {
    action: "prepare",
    draft: draft("IT-20260910-130000-LOCK"),
  }));
  assert.equal(first.code, "AWAITING_CONFIRMATION");
  assert.equal(first.retentionHours, 24);
  assert.equal(first.sameSession, true);
  assert.equal(first.summary.imageCount, 1);

  const newCtx = context("wecom-user-1", "wecom:direct:peer", {
    sessionId: "session-bbb",
    mediaPaths: [newShot],
  });
  rememberInboundMedia(mediaScope(newCtx), [{ localPath: newShot, fileName: "new-session.png" }]);
  const blockedPrepare = parse(await factory(newCtx).execute("call-2", {
    action: "prepare",
    draft: draft("IT-20260910-130100-NEW"),
  }));
  assert.equal(blockedPrepare.code, "ALREADY_PENDING");
  assert.equal(blockedPrepare.sameSession, false);
  assert.equal(blockedPrepare.retentionHours, 24);
  assert.equal(blockedPrepare.confirmationId, first.confirmationId);
  assert.equal(blockedPrepare.summary, "电脑死机");
  assert.equal(blockedPrepare.location, "智园");
  assert.equal(blockedPrepare.imageCount, 1);
  assert.ok(blockedPrepare.expiresAt);

  const blockedAttach = parse(await factory(newCtx).execute("call-3", {
    action: "attach",
    confirmationId: first.confirmationId,
  }));
  assert.equal(blockedAttach.code, "ALREADY_PENDING");
  assert.equal(blockedAttach.sameSession, false);
  assert.equal(blockedAttach.retentionHours, 24);

  const blockedInbox = parse(await factory(newCtx).execute("call-4", { action: "attach" }));
  assert.equal(blockedInbox.code, "ALREADY_PENDING");
  assert.equal(blockedInbox.sameSession, false);

  const person = parse(await factory(newCtx).execute("call-5", { action: "status" }));
  assert.equal(person.pending.sameSession, false);
  assert.equal(person.pending.retentionHours, 24);
  assert.equal(person.pending.imageCount, 1);

  const submitted = parse(await factory(newCtx).execute("call-6", {
    action: "submit_confirmed",
    confirmationId: first.confirmationId,
  }));
  assert.equal(submitted.code, "SUBMITTED");
  assert.equal(submitted.summary, "电脑死机");
  assert.equal(submitted.location, "智园");
  assert.equal(submitted.imageCount, 1);
  const description = capturedPayload.mainData.find((field) => field.fieldName === "wtxqmskftp").fieldValue;
  assert.match(description, /alt="old-session.png"/);
  assert.doesNotMatch(description, /new-session\.png/);

  const ownerA = ownerOf("wecom-user-1", "session-aaa");
  assert.equal(await getPersonPendingId(stateStore, ownerA.identity), "");
  assert.equal(await getSessionPendingId(stateStore, ownerA.identity, ownerA.session), "");
  assert.equal(peekInboundMedia(mediaScope(newCtx)).some((item) => item.localPath === newShot), true);

  const nextCtx = context("wecom-user-1", "wecom:direct:peer", { sessionId: "session-bbb" });
  const next = parse(await factory(nextCtx).execute("call-7", {
    action: "prepare",
    draft: draft("IT-20260910-130200-NEXT"),
  }));
  assert.equal(next.code, "AWAITING_CONFIRMATION");
  assert.equal(next.summary.imageCount, 1);
});

test("同一会话待确认期间仍可 attach，确认卡时限为 24 小时", async (t) => {
  const { stateDir, inbound } = await scratch(t, "same-session-attach");
  const shot = path.join(inbound, "same.png");
  await writeFile(shot, "image-bytes");
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`same-session-attach-${Date.now()}`),
    dependencies: dependencies(),
  });
  const prepared = parse(await factory(context()).execute("call-1", { action: "prepare", draft: draft() }));
  assert.equal(prepared.retentionHours, 24);
  const attached = parse(await factory(context("wecom-user-1", "room-1", { mediaPaths: [shot] })).execute("call-2", {
    action: "attach",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(attached.code, "ATTACHED");
  assert.equal(attached.imageCount, 1);
});

test("群聊同一会话里两人的 inbound 图不互串", async (t) => {
  const { stateDir, inbound } = await scratch(t, "group-isolate");
  const shotA = path.join(inbound, "a.png");
  const shotB = path.join(inbound, "b.png");
  await writeFile(shotA, "image-a");
  await writeFile(shotB, "image-b");
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`group-isolate-${Date.now()}`),
    dependencies: dependencies(),
  });
  const groupId = "session-group-1";
  parse(await factory(context("wecom-user-1", "wecom:group:room", {
    sessionId: groupId,
    mediaPaths: [shotA],
  })).execute("call-1", { action: "attach" }));
  const preparedB = parse(await factory(context("wecom-user-2", "wecom:group:room", {
    sessionId: groupId,
    mediaPaths: [shotB],
  })).execute("call-2", { action: "prepare", draft: draft("IT-20260910-111000-BBBB") }));
  assert.equal(preparedB.code, "AWAITING_CONFIRMATION");
  assert.equal(preparedB.summary.imageCount, 1);
  assert.equal(preparedB.summary.attachmentCount, 1);
});

test("未确认过期后删 pending 与 staging，下一轮 prepare 不带旧图", async (t) => {
  const { stateDir, inbound } = await scratch(t, "expire-wipe");
  const shot = path.join(inbound, "expired.png");
  await writeFile(shot, "image-bytes");
  const stateStore = createMemoryStateStore(`expire-wipe-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  const ctx = context("wecom-user-1", "room-1", { mediaPaths: [shot] });
  const prepared = parse(await factory(ctx).execute("call-1", { action: "prepare", draft: draft("IT-20260910-120000-EX01") }));
  const pending = await getPending(stateStore, prepared.confirmationId);
  await commitTicketState(stateStore, {
    pending: { ...pending, expiresAt: Date.now() - 1000 },
    ledger: {
      status: "awaiting_confirmation",
      confirmationId: prepared.confirmationId,
      identity: pending.identity,
      session: pending.session,
      externalTicketId: pending.draft.externalTicketId,
    },
  });
  const person = parse(await factory(context()).execute("call-2", { action: "status" }));
  assert.equal(person.code, "PERSON_STATUS");
  assert.equal(person.pending, null);
  assert.equal(person.recent[0].status, "expired");
  const next = parse(await factory(context()).execute("call-3", { action: "prepare", draft: draft("IT-20260910-120100-EX02") }));
  assert.equal(next.code, "AWAITING_CONFIRMATION");
  assert.equal(next.summary.attachmentCount, 0);
});

test("attach 能并入 hook 按单聊 sessionKey 记住的 inbound，即使工具 ctx 带了 sessionId", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-scope-mismatch");
  const shot = path.join(inbound, "hook.png");
  await writeFile(shot, "image-bytes");
  const sender = "wo0vXZbQAAw1RkQccme3mRCuO0ChEJ9g";
  const sessionKey = `agent:itservicedeskagent:wecom:direct:${sender.toLowerCase()}`;
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`attach-scope-mismatch-${Date.now()}`),
    dependencies: dependencies(),
  });
  const ctx = context(sender, sessionKey, { sessionId: "sid-uuid" });
  const prepared = parse(await factory(ctx).execute("call-1", { action: "prepare", draft: draft() }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  rememberInboundMedia(sessionKey, [{ localPath: shot, fileName: "hook.png" }]);
  const attached = parse(await factory(ctx).execute("call-2", {
    action: "attach",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(attached.code, "ATTACHED");
  assert.equal(attached.addedCount, 1);
  assert.equal(attached.imageCount, 1);
});

test("inbound 文件暂存失败时不丢掉 hook 缓冲", async (t) => {
  const { stateDir } = await scratch(t, "attach-keep-buffer");
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`attach-keep-buffer-${Date.now()}`),
    dependencies: dependencies(),
  });
  const ctx = context();
  const prepared = parse(await factory(ctx).execute("call-1", { action: "prepare", draft: draft() }));
  const missing = path.join(stateDir, "media", "inbound", "gone.png");
  rememberInboundMedia(mediaScope(ctx), [{ localPath: missing, fileName: "gone.png" }]);
  const result = parse(await factory(ctx).execute("call-2", {
    action: "attach",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(result.code, "NO_NEW_ATTACHMENT");
  assert.equal(result.addedCount, 0);
  assert.equal(peekInboundMedia(mediaScope(ctx)).length, 1);
});

test("旧 pending 没有 location 时 status 仍从 systemName 兑底园区", async (t) => {
  const { stateDir } = await scratch(t, "legacy-location");
  const stateStore = createMemoryStateStore(`legacy-location-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  const prepared = parse(await factory(context()).execute("call-1", { action: "prepare", draft: draft("IT-20260911-090000-OLD") }));
  const pending = await getPending(stateStore, prepared.confirmationId);
  const { location: _dropped, ...draftWithoutLocation } = pending.draft;
  await commitTicketState(stateStore, {
    pending: { ...pending, draft: draftWithoutLocation },
  });
  const person = parse(await factory(context()).execute("call-2", { action: "status" }));
  assert.equal(person.pending.summary, "电脑死机");
  assert.equal(person.pending.location, "智园");
  assert.equal(draftWithoutLocation.location, undefined);

  const byId = parse(await factory(context()).execute("call-3", {
    action: "status",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(byId.location, "智园");
  assert.equal(byId.summary, "电脑死机");
});

test("查进度无待确认：列出已提交条数和最近 5 条单号，不查 OA 进度", async (t) => {
  const { stateDir } = await scratch(t, "person-status-list");
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createMemoryStateStore(`person-status-list-${Date.now()}`),
    dependencies: dependencies({ createRequest: async () => ({ requestId: "1504371" }) }),
  });
  const empty = parse(await factory(context()).execute("call-0", { action: "status" }));
  assert.equal(empty.code, "PERSON_STATUS");
  assert.equal(empty.pending, null);
  assert.equal(empty.submittedCount, 0);
  assert.match(empty.hintZh, /没有待确认或已提交的记录/);

  const prepared = parse(await factory(context()).execute("call-1", { action: "prepare", draft: draft() }));
  parse(await factory(context()).execute("call-2", {
    action: "submit_confirmed",
    confirmationId: prepared.confirmationId,
  }));
  const listed = parse(await factory(context()).execute("call-3", { action: "status" }));
  assert.equal(listed.pending, null);
  assert.equal(listed.submittedCount, 1);
  assert.equal(listed.submitted[0].requestId, "1504371");
  assert.match(listed.hintZh, /已提交 1 条：/);
  assert.match(listed.hintZh, /1504371/);
  assert.doesNotMatch(listed.hintZh, /处理人/);
});

test("prepare 之前两轮 attach 重叠时两张图都进 inbox，不互相覆盖", async (t) => {
  const { stateDir, inbound } = await scratch(t, "attach-inbox-race");
  const blue = path.join(inbound, "blue-screen.png");
  const wiring = path.join(inbound, "wiring.png");
  await writeFile(blue, "blue-bytes");
  await writeFile(wiring, "wiring-bytes");
  const stateStore = createMemoryStateStore(`attach-inbox-race-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  const pendingOwner = ownerOf();

  const [first, second] = await Promise.all([
    factory(context("wecom-user-1", "room-1", { mediaPaths: [blue] })).execute("call-a", { action: "attach" }),
    factory(context("wecom-user-1", "room-1", { mediaPaths: [wiring] })).execute("call-b", { action: "attach" }),
  ]);
  const results = [parse(first), parse(second)];
  assert.deepEqual(results.map((item) => item.code).sort(), ["BUFFERED", "BUFFERED"]);
  assert.equal(results.reduce((sum, item) => sum + item.addedCount, 0), 2);

  const inbox = await getInbox(stateStore, pendingOwner.identity, pendingOwner.session);
  const fileNames = (inbox?.items || []).map((item) => item.fileName).sort();
  assert.deepEqual(fileNames, ["blue-screen.png", "wiring.png"]);
  const storedNames = (inbox?.items || []).map((item) => item.storedName);
  assert.equal(new Set(storedNames).size, 2);

  const inboxDir = path.join(stagingPaths(stateDir).stagingRoot, inboxDirName(pendingOwner.identity, pendingOwner.session));
  const stagedFiles = (await readdir(inboxDir)).sort();
  assert.equal(stagedFiles.length, 2);

  const prepared = parse(await factory(context()).execute("call-prepare", { action: "prepare", draft: draft() }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  assert.equal(prepared.summary.attachmentCount, 2);
  assert.equal(prepared.summary.imageCount, 2);
});

test("prepare 与 attach 并发：快照之后落库的那张图不会被收尾的 removeInbox 吞掉", async (t) => {
  const { stateDir, inbound } = await scratch(t, "prepare-attach-race");
  const blue = path.join(inbound, "blue-screen.png");
  const wiring = path.join(inbound, "wiring.png");
  await writeFile(blue, "blue-bytes");
  await writeFile(wiring, "wiring-bytes");
  const stateStore = createMemoryStateStore(`prepare-attach-race-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  const pendingOwner = ownerOf();

  const seeded = parse(await factory(context("wecom-user-1", "room-1", { mediaPaths: [blue] })).execute("call-seed", { action: "attach" }));
  assert.equal(seeded.code, "BUFFERED");

  // 在测试外层插入 attach：prepare 读 inbox 时暂停，等 attach 排队后再放行。
  // 同 ALS 里直接 execute(attach) 会重入锁，打不出真实的跨请求窗口。
  const originalGet = stateStore.redis.get.bind(stateStore.redis);
  let intercepted = false;
  let resumeInboxGet;
  const inboxGetGate = new Promise((resolve) => {
    resumeInboxGet = resolve;
  });
  let inboxHitResolve;
  const inboxHit = new Promise((resolve) => {
    inboxHitResolve = resolve;
  });
  stateStore.redis.get = async (key) => {
    const value = await originalGet(key);
    if (!intercepted && String(key).includes(":inbox:")) {
      intercepted = true;
      inboxHitResolve();
      await inboxGetGate;
    }
    return value;
  };

  const preparePromise = factory(context()).execute("call-prepare", { action: "prepare", draft: draft() });
  await inboxHit;
  const attachPromise = factory(context("wecom-user-1", "room-1", { mediaPaths: [wiring] })).execute("call-attach", { action: "attach" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  resumeInboxGet();
  const prepared = parse(await preparePromise);
  const attached = parse(await attachPromise);
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  assert.equal(attached.ok, true);
  assert.ok(["BUFFERED", "ATTACHED"].includes(attached.code), `unexpected attach code ${attached.code}`);

  const pending = await getPending(stateStore, prepared.confirmationId);
  assert.deepEqual((pending?.staged || []).map((item) => item.fileName).sort(), ["blue-screen.png", "wiring.png"]);
  assert.equal(new Set((pending?.staged || []).map((item) => item.storedName)).size, 2);

  const stagedFiles = await readdir(path.join(stagingPaths(stateDir).stagingRoot, prepared.confirmationId));
  assert.equal(stagedFiles.length, 2);

  assert.equal(await getInbox(stateStore, pendingOwner.identity, pendingOwner.session), null);
});

test("prepare 已写入 pending 后 inbox 清理失败不得删 staging，仍返回待确认", async (t) => {
  const { stateDir, inbound } = await scratch(t, "prepare-commit-keep-staging");
  const shot = path.join(inbound, "keep-me.png");
  await writeFile(shot, "keep-bytes");
  const stateStore = createMemoryStateStore(`prepare-commit-keep-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  const pendingOwner = ownerOf();

  const seeded = parse(await factory(context("wecom-user-1", "room-1", { mediaPaths: [shot] })).execute("call-seed", {
    action: "attach",
  }));
  assert.equal(seeded.code, "BUFFERED");

  const originalMulti = stateStore.redis.multi.bind(stateStore.redis);
  let execCount = 0;
  stateStore.redis.multi = () => {
    const chain = originalMulti();
    const originalExec = chain.exec.bind(chain);
    chain.exec = async () => {
      execCount += 1;
      if (execCount >= 2) throw new Error("inbox cleanup failed after pending commit");
      return originalExec();
    };
    return chain;
  };

  const prepared = parse(await factory(context()).execute("call-prepare", { action: "prepare", draft: draft() }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  assert.equal(prepared.summary.attachmentCount, 1);

  const pending = await getPending(stateStore, prepared.confirmationId);
  assert.equal(pending?.identity, pendingOwner.identity);
  assert.equal((pending?.staged || []).length, 1);
  const keptFiles = await readdir(path.join(stagingPaths(stateDir).stagingRoot, prepared.confirmationId));
  assert.equal(keptFiles.length, 1);
});

test("cancel 释放 pending 后，同会话新 attach 的 inbox 不能被旧单收尾清掉", async (t) => {
  const { stateDir, inbound } = await scratch(t, "cancel-inbox-race");
  const oldShot = path.join(inbound, "old.png");
  const nextShot = path.join(inbound, "next.png");
  await writeFile(oldShot, "old-bytes");
  await writeFile(nextShot, "next-bytes");
  const stateStore = createMemoryStateStore(`cancel-inbox-race-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  const pendingOwner = ownerOf();

  const prepared = parse(await factory(context("wecom-user-1", "room-1", { mediaPaths: [oldShot] })).execute("call-1", {
    action: "prepare",
    draft: draft(),
  }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");

  const originalGet = stateStore.redis.get.bind(stateStore.redis);
  let intercepted = false;
  let resumeInboxGet;
  const inboxGetGate = new Promise((resolve) => {
    resumeInboxGet = resolve;
  });
  let inboxHitResolve;
  const inboxHit = new Promise((resolve) => {
    inboxHitResolve = resolve;
  });
  stateStore.redis.get = async (key) => {
    const value = await originalGet(key);
    if (!intercepted && String(key).includes(":person-inbox:")) {
      intercepted = true;
      inboxHitResolve();
      await inboxGetGate;
    }
    return value;
  };

  const cancelPromise = factory(context()).execute("call-cancel", {
    action: "cancel",
    confirmationId: prepared.confirmationId,
  });
  await inboxHit;
  const attachPromise = factory(context("wecom-user-1", "room-1", { mediaPaths: [nextShot] })).execute("call-attach", {
    action: "attach",
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  resumeInboxGet();
  const cancelled = parse(await cancelPromise);
  const attached = parse(await attachPromise);
  assert.equal(cancelled.code, "CANCELLED");
  assert.equal(attached.code, "BUFFERED");
  assert.equal(attached.addedCount, 1);

  const inbox = await getInbox(stateStore, pendingOwner.identity, pendingOwner.session);
  assert.deepEqual((inbox?.items || []).map((item) => item.fileName), ["next.png"]);
  const inboxDir = path.join(stagingPaths(stateDir).stagingRoot, inboxDirName(pendingOwner.identity, pendingOwner.session));
  assert.deepEqual((await readdir(inboxDir)).sort(), ["01-next.png"]);
});

test("过期回收在锁外清 inbox 时，不得删掉随后写入的新附件", async (t) => {
  const { stateDir, inbound } = await scratch(t, "expire-inbox-race");
  const oldShot = path.join(inbound, "expired.png");
  const nextShot = path.join(inbound, "fresh.png");
  await writeFile(oldShot, "expired-bytes");
  await writeFile(nextShot, "fresh-bytes");
  const stateStore = createMemoryStateStore(`expire-inbox-race-${Date.now()}`);
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies() });
  const pendingOwner = ownerOf();

  const prepared = parse(await factory(context("wecom-user-1", "room-1", { mediaPaths: [oldShot] })).execute("call-1", {
    action: "prepare",
    draft: draft("IT-20260917-121500-EXP1"),
  }));
  const pending = await getPending(stateStore, prepared.confirmationId);
  await commitTicketState(stateStore, {
    pending: { ...pending, expiresAt: Date.now() - 1000 },
    ledger: {
      status: "awaiting_confirmation",
      confirmationId: prepared.confirmationId,
      identity: pending.identity,
      session: pending.session,
      externalTicketId: pending.draft.externalTicketId,
    },
  });

  const originalGet = stateStore.redis.get.bind(stateStore.redis);
  let intercepted = false;
  let resumeInboxGet;
  const inboxGetGate = new Promise((resolve) => {
    resumeInboxGet = resolve;
  });
  let inboxHitResolve;
  const inboxHit = new Promise((resolve) => {
    inboxHitResolve = resolve;
  });
  stateStore.redis.get = async (key) => {
    const value = await originalGet(key);
    if (!intercepted && String(key).includes(":person-inbox:")) {
      intercepted = true;
      inboxHitResolve();
      await inboxGetGate;
    }
    return value;
  };

  const statusPromise = factory(context()).execute("call-status", { action: "status" });
  await inboxHit;
  const attachPromise = factory(context("wecom-user-1", "room-1", { mediaPaths: [nextShot] })).execute("call-attach", {
    action: "attach",
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  resumeInboxGet();
  const status = parse(await statusPromise);
  const attached = parse(await attachPromise);
  assert.equal(status.code, "PERSON_STATUS");
  assert.equal(status.pending, null);
  assert.equal(attached.code, "BUFFERED");

  const inbox = await getInbox(stateStore, pendingOwner.identity, pendingOwner.session);
  assert.deepEqual((inbox?.items || []).map((item) => item.fileName), ["fresh.png"]);
});
