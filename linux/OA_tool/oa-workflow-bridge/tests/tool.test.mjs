import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupExpired, getActiveTicket, getLatestTicketByExternalId, getTicket, stagingPaths } from "../src/store.mjs";
import { createTestStore, expireNow, setStatus } from "./helpers.mjs";
import { OAClientError } from "../src/oa-client.mjs";
import { clearInboundMedia, mediaScope, rememberInboundMedia } from "../src/inbound-media.mjs";
import { createOAWorkflowToolFactory } from "../src/tool.mjs";

test.beforeEach(() => {
  clearInboundMedia();
});

function parse(result) {
  return JSON.parse(result.content[0].text);
}

function scfjAttachments(payload) {
  const field = payload.mainData.find((item) => item.fieldName === "scfj");
  assert.equal(typeof field?.fieldValue, "string");
  return JSON.parse(field.fieldValue);
}

function context(sender = "wecom-user-1", session = "room-1", extra = {}) {
  return { messageChannel: "wecom", requesterSenderId: sender, sessionKey: session, ...extra };
}

function draft(id = "IT-20260805-121500-A1B2") {
  return {
    externalTicketId: id,
    ticketType: "运维支持",
    systemName: "MES系统（越南B部）",
    summary: "MES终端无法登录",
    problemDescription: "越南A栋二楼MES终端提示登录失败。",
    impactScope: "一条生产线",
  };
}

const DEFAULT_IDENTITY = { adapter: "on" };
const DEFAULT_IDENTITY_ADAPTER = {
  resolve: async () => ({ oaUserId: "1001" }),
};

function dependencies({ active = true, createRequest, identity, identityAdapter, lookupRequesterProfile }) {
  const useDefaultAdapter = identity === undefined && identityAdapter === undefined;
  return {
    loadConfig: async () => ({
      active,
      baseUrl: "https://adtekoa.com",
      workflowId: 602,
      isnextflow: "0",
      attachmentFieldName: "scfj",
      pendingTtlHours: 24,
      maxAttachmentBytes: 1024 * 1024,
      maxTotalAttachmentBytes: 2 * 1024 * 1024,
      identity: identity || DEFAULT_IDENTITY,
    }),
    loadSystems: async () => ({
      options: new Map([["MES系统（越南B部）", 8], ["其他", 17]]),
      typeSystems: new Map([["运维支持", new Set(["MES系统（越南B部）", "其他"])], ["权限申请", new Set(["其他"])], ["IT需求", new Set(["其他"])]]),
      handlers: new Map([["MES系统（越南B部）", "18196,10251"], ["其他", "4280"]]),
    }),
    clientFactory: () => ({ createRequest }),
    lookupRequesterProfile: lookupRequesterProfile || (async () => ({
      departmentId: "714",
      jobTitleId: "636",
      locationId: "3",
    })),
    identityAdapter: useDefaultAdapter ? DEFAULT_IDENTITY_ADAPTER : identityAdapter,
  };
}

/** 只让「OA 成功后写 submitted」这一步失败，submit 前的 submitting 仍能写。 */
function failWhenWritingSubmitted(store) {
  const originalRun = store.db.run.bind(store.db);
  store.db.run = async (sql, params = []) => {
    if (/^UPDATE oa_ticket/.test(sql) && params.includes("submitted")) {
      throw new Error("db persist failed after OA create");
    }
    return originalRun(sql, params);
  };
}

test("本轮 inbound / ctx 有图时 prepare 自动暂存，模型不必传路径", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-auto-att-"));
  t.after(() => {
    clearInboundMedia();
    return rm(stateDir, { recursive: true, force: true });
  });
  const inbound = path.join(stateDir, "media", "inbound");
  await mkdir(inbound, { recursive: true });
  const first = path.join(inbound, "auto.png");
  const second = path.join(inbound, "extra.txt");
  await writeFile(first, "image-auto");
  await writeFile(second, "text-extra");
  rememberInboundMedia(mediaScope(context("wecom-user-1", "room-auto")), [{ localPath: first, fileName: "自动截图.png" }]);

  let capturedPayload;
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createTestStore(),
    dependencies: dependencies({
      createRequest: async (payload) => {
        capturedPayload = payload;
        return { requestId: "1492075" };
      },
    }),
  });
  const tool = factory(context("wecom-user-1", "room-auto"));
  const prepared = parse(await tool.execute("call-1", {
    action: "prepare",
    draft: draft("IT-20260907-163000-A1B2"),
  }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  assert.equal(prepared.summary.attachmentCount, 1);
  assert.equal(prepared.location, null);
  assert.equal(prepared.summary.location, null);

  const submitted = parse(await tool.execute("call-2", {
    action: "submit_confirmed",
    confirmationId: prepared.confirmationId,
    attachments: [{ localPath: second, fileName: "补充日志.txt" }],
  }));
  assert.equal(submitted.code, "SUBMITTED");
  assert.deepEqual(scfjAttachments(capturedPayload).map((item) => item.fileName), ["补充日志.txt"]);
  assert.match(scfjAttachments(capturedPayload)[0].filePath, /^base64:[A-Za-z0-9+/]+=*$/);
  const description = capturedPayload.mainData.find((field) => field.fieldName === "wtxqmskftp").fieldValue;
  assert.match(description, /<img src="data:image\/png;base64,/);
  assert.match(description, /alt="自动截图.png"/);
  assert.doesNotMatch(description, /补充日志/);
});

test("prepare 跳过已不存在的 inbound 路径，仍暂存当前截图", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-skip-stale-"));
  t.after(() => {
    clearInboundMedia();
    return rm(stateDir, { recursive: true, force: true });
  });
  const inbound = path.join(stateDir, "media", "inbound");
  await mkdir(inbound, { recursive: true });
  const current = path.join(inbound, "now.png");
  await writeFile(current, "image-now");
  rememberInboundMedia(mediaScope(context("wecom-user-1", "room-stale")), [
    { localPath: "<本地路径>", fileName: "placeholder.png" },
    { localPath: path.join(inbound, "missing-old.png"), fileName: "旧图.png" },
    { localPath: current, fileName: "当前截图.png" },
  ]);

  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createTestStore(),
    dependencies: dependencies({
      createRequest: async () => ({ requestId: "1492078" }),
    }),
  });
  const prepared = parse(await factory(context("wecom-user-1", "room-stale")).execute("call-1", {
    action: "prepare",
    draft: draft("IT-20260907-174400-S9T0"),
  }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  assert.equal(prepared.summary.attachmentCount, 1);
});

test("prepare 接受 workspace/media/inbound 通道原件，不静默丢掉", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-ws-in-"));
  t.after(() => {
    clearInboundMedia();
    return rm(stateDir, { recursive: true, force: true });
  });
  const configInbound = path.join(stateDir, "media", "inbound");
  const workspaceInbound = path.join(stateDir, "workspace", "media", "inbound");
  await mkdir(configInbound, { recursive: true });
  await mkdir(workspaceInbound, { recursive: true });
  const fromWorkspace = path.join(workspaceInbound, "channel.png");
  await writeFile(fromWorkspace, "image-workspace");
  rememberInboundMedia(mediaScope(context("wecom-user-1", "room-ws")), [
    { localPath: fromWorkspace, fileName: "通道截图.png" },
  ]);

  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createTestStore(),
    dependencies: dependencies({
      createRequest: async () => ({ requestId: "1492080" }),
    }),
  });
  const prepared = parse(await factory(context("wecom-user-1", "room-ws")).execute("call-1", {
    action: "prepare",
    draft: draft("IT-20260907-183000-WS01"),
  }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  assert.equal(prepared.summary.attachmentCount, 1);
});

test("prepare 跳过其他目录的 inbound 形路径，仍暂存当前截图", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-skip-outside-"));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "xa-oa-other-in-"));
  t.after(() => {
    clearInboundMedia();
    return Promise.all([
      rm(stateDir, { recursive: true, force: true }),
      rm(otherRoot, { recursive: true, force: true }),
    ]);
  });
  const inbound = path.join(stateDir, "media", "inbound");
  const otherInbound = path.join(otherRoot, "media", "inbound");
  await mkdir(inbound, { recursive: true });
  await mkdir(otherInbound, { recursive: true });
  const current = path.join(inbound, "now.png");
  const outsider = path.join(otherInbound, "resized.png");
  await writeFile(current, "image-now");
  await writeFile(outsider, "image-resized");
  rememberInboundMedia(mediaScope(context("wecom-user-1", "room-outside")), [
    { localPath: outsider, fileName: "resized.png" },
    { localPath: current, fileName: "当前截图.png" },
  ]);

  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createTestStore(),
    dependencies: dependencies({
      createRequest: async () => ({ requestId: "1492079" }),
    }),
  });
  const prepared = parse(await factory(context("wecom-user-1", "room-outside")).execute("call-1", {
    action: "prepare",
    draft: draft("IT-20260907-182700-OUT1"),
  }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  assert.equal(prepared.summary.attachmentCount, 1);
});

test("同一轮 ctx.mediaPaths 只在 prepare 暂存一次，submit 不重复", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-ctx-att-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const inbound = path.join(stateDir, "media", "inbound");
  await mkdir(inbound, { recursive: true });
  const first = path.join(inbound, "ctx.png");
  await writeFile(first, "image-ctx");

  let capturedPayload;
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createTestStore(),
    dependencies: dependencies({
      createRequest: async (payload) => {
        capturedPayload = payload;
        return { requestId: "1492076" };
      },
    }),
  });
  const tool = factory(context("wecom-user-1", "room-ctx", { mediaPaths: [first] }));
  const prepared = parse(await tool.execute("call-1", {
    action: "prepare",
    draft: draft("IT-20260907-163100-C3D4"),
  }));
  assert.equal(prepared.summary.attachmentCount, 1);
  const submitted = parse(await tool.execute("call-2", { action: "submit_confirmed", confirmationId: prepared.confirmationId }));
  assert.equal(submitted.code, "SUBMITTED");
  const attachmentField = capturedPayload.mainData.find((field) => field.fieldName === "scfj");
  assert.equal(attachmentField, undefined);
  const description = capturedPayload.mainData.find((field) => field.fieldName === "wtxqmskftp").fieldValue;
  assert.match(description, /<img src="data:image\/png;base64,/);
  assert.match(description, /alt="ctx.png"/);
});

test("确认消息带新 inbound 会追加，prepare 已暂存的同一路径不重复", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-confirm-att-"));
  t.after(() => {
    clearInboundMedia();
    return rm(stateDir, { recursive: true, force: true });
  });
  const inbound = path.join(stateDir, "media", "inbound");
  await mkdir(inbound, { recursive: true });
  const first = path.join(inbound, "prepared.png");
  const extra = path.join(inbound, "confirm.txt");
  await writeFile(first, "image-prepared");
  await writeFile(extra, "text-confirm");

  let capturedPayload;
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createTestStore(),
    dependencies: dependencies({
      createRequest: async (payload) => {
        capturedPayload = payload;
        return { requestId: "1492077" };
      },
    }),
  });
  const prepared = parse(await factory(context("wecom-user-1", "room-confirm", { mediaPaths: [first] })).execute("call-1", {
    action: "prepare",
    draft: draft("IT-20260907-172900-E5F6"),
  }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  assert.equal(prepared.summary.attachmentCount, 1);

  const submitted = parse(await factory(context("wecom-user-1", "room-confirm", {
    mediaPaths: [first, extra],
  })).execute("call-2", {
    action: "submit_confirmed",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(submitted.code, "SUBMITTED");
  assert.deepEqual(scfjAttachments(capturedPayload).map((item) => item.fileName), ["confirm.txt"]);
  assert.match(scfjAttachments(capturedPayload)[0].filePath, /^base64:[A-Za-z0-9+/]+=*$/);
  const description = capturedPayload.mainData.find((field) => field.fieldName === "wtxqmskftp").fieldValue;
  assert.match(description, /alt="prepared.png"/);
});

test("只允许原企微会话一次确认并提交，追加附件不覆盖", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-tool-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const inbound = path.join(stateDir, "media", "inbound");
  await mkdir(inbound, { recursive: true });
  const first = path.join(inbound, "first.png");
  const second = path.join(inbound, "second.txt");
  await writeFile(first, "image-one");
  await writeFile(second, "attachment-two");

  const stateStore = createTestStore();
  let createCount = 0;
  let capturedPayload;
  let capturedRequesterUserId;
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({
      createRequest: async (payload, options) => {
        createCount += 1;
        capturedPayload = payload;
        capturedRequesterUserId = options?.requesterUserId;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { requestId: "889900" };
      },
    }),
  });
  const tool = factory(context());
  const prepared = parse(await tool.execute("call-1", {
    action: "prepare",
    draft: draft(),
    attachments: [{ localPath: first, fileName: "现场截图.png" }],
  }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");

  const otherTool = factory(context("wecom-user-2", "room-2"));
  const denied = parse(await otherTool.execute("call-2", { action: "status", confirmationId: prepared.confirmationId }));
  assert.equal(denied.code, "NOT_FOUND");

  const [submissionA, submissionB] = await Promise.all([
    tool.execute("call-3", {
      action: "submit_confirmed",
      confirmationId: prepared.confirmationId,
      supplement: "无需继续补充",
      attachments: [{ localPath: second, fileName: "诊断日志.txt" }],
    }),
    tool.execute("call-4", { action: "submit_confirmed", confirmationId: prepared.confirmationId }),
  ]).then((items) => items.map(parse));

  assert.equal(createCount, 1);
  assert.equal(capturedRequesterUserId, "1001");
  assert.equal(capturedPayload.mainData.find((field) => field.fieldName === "xqsqr")?.fieldValue, "1001");
  assert.equal(capturedPayload.mainData.find((field) => field.fieldName === "xqsqbm")?.fieldValue, "714");
  assert.equal(capturedPayload.mainData.find((field) => field.fieldName === "gw")?.fieldValue, "636");
  assert.equal(capturedPayload.mainData.find((field) => field.fieldName === "bgdd")?.fieldValue, "3");
  assert.equal(capturedPayload.mainData.find((field) => field.fieldName === "clry")?.fieldValue, "18196,10251");
  assert.equal([submissionA.code, submissionB.code].includes("SUBMITTED"), true);
  const winner = [submissionA, submissionB].find((item) => item.code === "SUBMITTED");
  const loser = [submissionA, submissionB].find((item) => item.code !== "SUBMITTED");
  assert.equal(loser.code, "ALREADY_SUBMITTED");
  assert.equal(loser.requestId, "889900");
  assert.equal(winner.requestId, "889900");
  assert.deepEqual(scfjAttachments(capturedPayload).map((item) => item.fileName), ["诊断日志.txt"]);
  assert.match(scfjAttachments(capturedPayload)[0].filePath, /^base64:[A-Za-z0-9+/]+=*$/);
  const description = capturedPayload.mainData.find((field) => field.fieldName === "wtxqmskftp").fieldValue;
  assert.match(description, /最终补充：无需继续补充/);
  assert.match(description, /alt="现场截图.png"/);
  assert.doesNotMatch(description, /xA工单编号/);
  assert.doesNotMatch(description, /IT-\d{8}-\d{6}-[A-Z0-9]{4}/);

  const repeated = parse(await tool.execute("call-5", { action: "submit_confirmed", confirmationId: prepared.confirmationId }));
  assert.equal(repeated.code, "ALREADY_SUBMITTED");
  assert.equal(repeated.requestId, "889900");
  assert.match(repeated.hintZh, /889900/);
  assert.equal(createCount, 1);
});

test("桥接未激活时仍校验确认单，错误 confirmationId 不是 INACTIVE", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-inactive-validate-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createTestStore(),
    dependencies: dependencies({ active: false, createRequest: async () => ({ requestId: "1" }) }),
  });
  const tool = factory(context());
  const missing = parse(await tool.execute("call-1", { action: "submit_confirmed", confirmationId: "OA-MISSING-0001" }));
  assert.equal(missing.code, "NOT_FOUND");

  const prepared = parse(await tool.execute("call-2", { action: "prepare", draft: draft("IT-20260805-121508-S7T8") }));
  const other = parse(await factory(context("wecom-user-2", "room-2")).execute("call-3", {
    action: "submit_confirmed",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(other.code, "SENDER_MISMATCH");
});

test("桥接未激活时确认不会调用OA", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-inactive-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  let createCount = 0;
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createTestStore(),
    dependencies: dependencies({ active: false, createRequest: async () => { createCount += 1; return { requestId: "1" }; } }),
  });
  const tool = factory(context());
  const prepared = parse(await tool.execute("call-1", { action: "prepare", draft: draft("IT-20260805-121501-C3D4") }));
  const result = parse(await tool.execute("call-2", { action: "submit_confirmed", confirmationId: prepared.confirmationId }));
  assert.equal(result.code, "OA_BRIDGE_INACTIVE");
  assert.equal(createCount, 0);
});

test("过期后不能提交，cancel 也是 CONFIRMATION_EXPIRED", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-expire-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const stateStore = createTestStore();
  let createCount = 0;
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({
      createRequest: async () => {
        createCount += 1;
        return { requestId: "1" };
      },
    }),
  });
  const tool = factory(context());
  const prepared = parse(await tool.execute("call-1", { action: "prepare", draft: draft("IT-20260805-121502-E5F6") }));
  const pending = await getTicket(stateStore, prepared.confirmationId);
  await expireNow(stateStore, prepared.confirmationId);
  const expired = parse(await tool.execute("call-2", { action: "submit_confirmed", confirmationId: prepared.confirmationId }));
  assert.equal(expired.code, "CONFIRMATION_EXPIRED");
  assert.equal(createCount, 0);
  const cancelled = parse(await tool.execute("call-3", { action: "cancel", confirmationId: prepared.confirmationId }));
  assert.equal(cancelled.code, "CONFIRMATION_EXPIRED");
  const expiredStatus = parse(await tool.execute("call-4", { action: "status", confirmationId: prepared.confirmationId }));
  assert.equal(expiredStatus.code, "CONFIRMATION_EXPIRED");
  assert.match(expiredStatus.hintZh, /已过期/);
});

test("pending 仍在但已过期时 cancel 返回 CONFIRMATION_EXPIRED，不标 cancelled", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-cancel-expire-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const stateStore = createTestStore();
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({ createRequest: async () => ({ requestId: "1" }) }),
  });
  const tool = factory(context());
  const prepared = parse(await tool.execute("call-1", { action: "prepare", draft: draft("IT-20260805-121530-C9D0") }));
  const pending = await getTicket(stateStore, prepared.confirmationId);
  await expireNow(stateStore, prepared.confirmationId);
  const cancelled = parse(await tool.execute("call-2", { action: "cancel", confirmationId: prepared.confirmationId }));
  assert.equal(cancelled.code, "CONFIRMATION_EXPIRED");
  assert.notEqual(cancelled.code, "CANCELLED");
  assert.equal((await getTicket(stateStore, prepared.confirmationId)).status, "expired");
  assert.equal((await getLatestTicketByExternalId(stateStore, pending.externalTicketId)).status, "expired");
});

test("status 对过期 pending 返回 CONFIRMATION_EXPIRED，并清理 staging", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-status-expire-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const inbound = path.join(stateDir, "media", "inbound");
  await mkdir(inbound, { recursive: true });
  const shot = path.join(inbound, "shot.png");
  await writeFile(shot, "image");
  const stateStore = createTestStore();
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({ createRequest: async () => ({ requestId: "1" }) }),
  });
  const tool = factory(context());
  const prepared = parse(await tool.execute("call-1", {
    action: "prepare",
    draft: draft("IT-20260805-121511-Y3Z4"),
    attachments: [{ localPath: shot, fileName: "shot.png" }],
  }));
  const pending = await getTicket(stateStore, prepared.confirmationId);
  await expireNow(stateStore, prepared.confirmationId);
  const status = parse(await tool.execute("call-2", { action: "status", confirmationId: prepared.confirmationId }));
  assert.equal(status.code, "CONFIRMATION_EXPIRED");
  assert.equal(status.ok, true);
  const { access } = await import("node:fs/promises");
  await assert.rejects(() => access(path.join(stagingPaths(stateDir).stagingRoot, prepared.confirmationId)));
  const expired = await getTicket(stateStore, prepared.confirmationId);
  assert.equal(expired.status, "expired");
  assert.equal(expired.draft, null, "过期后描述清除");
  assert.deepEqual(expired.staged, [], "过期后附件清单清除");
});

async function prepareThenExpire(t, ticketId) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-expired-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const stateStore = createTestStore();
  let createCount = 0;
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({
      createRequest: async () => {
        createCount += 1;
        return { requestId: "1" };
      },
    }),
  });
  const tool = factory(context());
  const prepared = parse(await tool.execute("call-1", { action: "prepare", draft: draft(ticketId) }));
  await expireNow(stateStore, prepared.confirmationId);
  return { tool, stateStore, prepared, createCount: () => createCount };
}

test("到期未回收的待确认单：status 返回 CONFIRMATION_EXPIRED 并记 expired", async (t) => {
  const { tool, stateStore, prepared } = await prepareThenExpire(t, "IT-20260805-121520-T1A1");
  const status = parse(await tool.execute("call-2", { action: "status", confirmationId: prepared.confirmationId }));
  assert.equal(status.ok, true);
  assert.equal(status.code, "CONFIRMATION_EXPIRED");
  assert.match(status.hintZh, /已过期/);
  assert.equal((await getTicket(stateStore, prepared.confirmationId)).status, "expired");
  const again = parse(await tool.execute("call-3", { action: "status", confirmationId: prepared.confirmationId }));
  assert.equal(again.code, "CONFIRMATION_EXPIRED");
});

test("到期未回收的待确认单：submit_confirmed 返回 CONFIRMATION_EXPIRED 且不调 OA", async (t) => {
  const { tool, stateStore, prepared, createCount } = await prepareThenExpire(t, "IT-20260805-121521-T2B2");
  const submitted = parse(await tool.execute("call-2", { action: "submit_confirmed", confirmationId: prepared.confirmationId }));
  assert.equal(submitted.code, "CONFIRMATION_EXPIRED");
  assert.equal(submitted.ok, false);
  const again = parse(await tool.execute("call-3", { action: "submit_confirmed", confirmationId: prepared.confirmationId }));
  assert.equal(again.code, "CONFIRMATION_EXPIRED");
  assert.equal(createCount(), 0);
  assert.equal((await getTicket(stateStore, prepared.confirmationId)).status, "expired");
});

test("到期未回收的待确认单：cancel 返回 CONFIRMATION_EXPIRED，不标 cancelled", async (t) => {
  const { tool, stateStore, prepared } = await prepareThenExpire(t, "IT-20260805-121522-T3C3");
  const cancelled = parse(await tool.execute("call-2", { action: "cancel", confirmationId: prepared.confirmationId }));
  assert.equal(cancelled.code, "CONFIRMATION_EXPIRED");
  const again = parse(await tool.execute("call-3", { action: "cancel", confirmationId: prepared.confirmationId }));
  assert.equal(again.code, "CONFIRMATION_EXPIRED");
  assert.equal((await getTicket(stateStore, prepared.confirmationId)).status, "expired");
});

test("定时回收：没人调用工具时，到期待确认单也会记 expired 并删 staging", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-sweep-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const inbound = path.join(stateDir, "media", "inbound");
  await mkdir(inbound, { recursive: true });
  const shot = path.join(inbound, "sweep.png");
  await writeFile(shot, "image");
  const stateStore = createTestStore();
  const factory = createOAWorkflowToolFactory({ stateDir, stateStore, dependencies: dependencies({ createRequest: async () => ({ requestId: "1" }) }) });
  const prepared = parse(await factory(context("wecom-user-1", "room-1", { mediaPaths: [shot] })).execute("call-1", {
    action: "prepare",
    draft: draft("IT-20260805-121523-SW01"),
  }));
  await expireNow(stateStore, prepared.confirmationId);
  await cleanupExpired(stateStore, stateDir);
  const ticket = await getTicket(stateStore, prepared.confirmationId);
  assert.equal(ticket.status, "expired");
  assert.equal(ticket.draft, null);
  await assert.rejects(() => access(path.join(stagingPaths(stateDir).stagingRoot, prepared.confirmationId)));
});

test("status 对 unknown pending 返回 RECONCILIATION_REQUIRED，不报待确认", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-status-unknown-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const stateStore = createTestStore();
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({ createRequest: async () => ({ requestId: "1" }) }),
  });
  const tool = factory(context());
  const prepared = parse(await tool.execute("call-1", { action: "prepare", draft: draft("IT-20260805-121512-A5B6") }));
  await setStatus(stateStore, prepared.confirmationId, "unknown");
  const status = parse(await tool.execute("call-2", { action: "status", confirmationId: prepared.confirmationId }));
  assert.equal(status.code, "RECONCILIATION_REQUIRED");
  assert.notEqual(status.code, "AWAITING_CONFIRMATION");

  const person = parse(await tool.execute("call-3", { action: "status" }));
  assert.equal(person.code, "RECONCILIATION_REQUIRED");
  assert.notEqual(person.code, "PERSON_STATUS");
  assert.equal(person.pending?.code, "RECONCILIATION_REQUIRED");
  assert.equal(person.confirmationId, prepared.confirmationId);
  assert.match(String(person.hintZh || ""), /人工核对/);
});

test("确认时本地 staging 丢失则明确报错，不调 OA，仍可取消", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-staging-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const inbound = path.join(stateDir, "media", "inbound");
  await mkdir(inbound, { recursive: true });
  const first = path.join(inbound, "first.png");
  await writeFile(first, "image-one");
  const stateStore = createTestStore();
  let createCount = 0;
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({
      createRequest: async () => {
        createCount += 1;
        return { requestId: "2" };
      },
    }),
  });
  const tool = factory(context());
  const prepared = parse(await tool.execute("call-1", {
    action: "prepare",
    draft: draft("IT-20260805-121503-G7H8"),
    attachments: [{ localPath: first, fileName: "现场截图.png" }],
  }));
  await rm(path.join(stagingPaths(stateDir).stagingRoot, prepared.confirmationId), { recursive: true, force: true });
  const missing = parse(await tool.execute("call-2", { action: "submit_confirmed", confirmationId: prepared.confirmationId }));
  assert.equal(missing.code, "STAGING_MISSING");
  assert.equal(createCount, 0);
  const cancelled = parse(await tool.execute("call-3", { action: "cancel", confirmationId: prepared.confirmationId }));
  assert.equal(cancelled.code, "CANCELLED");
});

test("申请人资料查不到则不调 OA，pending 退回待确认", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-profile-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const stateStore = createTestStore();
  let createCount = 0;
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({
      createRequest: async () => {
        createCount += 1;
        return { requestId: "4" };
      },
      lookupRequesterProfile: async () => {
        throw new OAClientError("OA requester profile is incomplete", { code: "OA_PROFILE_INCOMPLETE" });
      },
    }),
  });
  const tool = factory(context());
  const prepared = parse(await tool.execute("call-1", { action: "prepare", draft: draft("IT-20260805-121510-W1X2") }));
  const failed = parse(await tool.execute("call-2", { action: "submit_confirmed", confirmationId: prepared.confirmationId }));
  assert.equal(failed.code, "OA_PROFILE_INCOMPLETE");
  assert.equal(createCount, 0);
  const pending = await getTicket(stateStore, prepared.confirmationId);
  assert.equal(pending.status, "awaiting_confirmation");
  const status = parse(await tool.execute("call-3", { action: "status", confirmationId: prepared.confirmationId }));
  assert.equal(status.code, "AWAITING_CONFIRMATION");
});

test("同一工单号取消后再 prepare，旧 confirmationId 的 status 不串到新单", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-reuse-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const stateStore = createTestStore();
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({ createRequest: async () => ({ requestId: "3" }) }),
  });
  const tool = factory(context("wecom-user-1", "room-1", {
    messageId: "j9k0xxxx",
    WeComReceivedAt: "2026-08-05 12:15:04",
  }));
  const first = parse(await tool.execute("call-1", { action: "prepare", draft: draft() }));
  assert.equal(first.code, "AWAITING_CONFIRMATION");
  assert.equal(first.summary.externalTicketId, "IT-20260805-121504-J9K0");
  const cancelled = parse(await tool.execute("call-2", { action: "cancel", confirmationId: first.confirmationId }));
  assert.equal(cancelled.code, "CANCELLED");
  const afterCancel = parse(await tool.execute("call-3", { action: "status", confirmationId: first.confirmationId }));
  assert.equal(afterCancel.code, "CANCELLED");

  const second = parse(await tool.execute("call-4", { action: "prepare", draft: draft() }));
  assert.equal(second.code, "AWAITING_CONFIRMATION");
  assert.notEqual(second.confirmationId, first.confirmationId);

  // 旧确认号仍按它自己的真实状态回答，不会串成新单的待确认。
  const stale = parse(await tool.execute("call-5", { action: "status", confirmationId: first.confirmationId }));
  assert.equal(stale.code, "CANCELLED");
  const current = parse(await tool.execute("call-6", { action: "status", confirmationId: second.confirmationId }));
  assert.equal(current.code, "AWAITING_CONFIRMATION");
});

test("adapter=off 且未映射时仍返回 OA_IDENTITY_MAPPING_REQUIRED", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-mapoff-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createTestStore(),
    dependencies: dependencies({
      createRequest: async () => ({ requestId: "1" }),
      identity: { adapter: "off" },
    }),
  });
  const result = parse(await factory(context()).execute("call-1", { action: "prepare", draft: draft("IT-20260805-121505-L1M2") }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "OA_IDENTITY_MAPPING_REQUIRED");
  assert.equal(result.mappingCode, undefined);
});

test("adapter=on 时 fake resolve 返回数字 id 后 prepare 落库", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-adapon-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const stateStore = createTestStore();
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({
      createRequest: async () => ({ requestId: "1" }),
      identity: { adapter: "on" },
      identityAdapter: {
        resolve: async () => ({ mappingCode: "abc", oaUserId: "30538" }),
      },
    }),
  });
  const prepared = parse(await factory(context()).execute("call-1", { action: "prepare", draft: draft("IT-20260805-121506-N3P4") }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  const pending = await getTicket(stateStore, prepared.confirmationId);
  assert.equal(pending.oaRequesterId, "30538");
  assert.equal(JSON.stringify(pending).includes("wecom-user-1"), false);
});

test("adapter=on 且 ALIGN_MISMATCH 时不写 pending", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-align-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const stateStore = createTestStore();
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({
      createRequest: async () => ({ requestId: "1" }),
      identity: { adapter: "on" },
      identityAdapter: {
        resolve: async () => {
          const error = new Error("align mismatch");
          error.code = "WECOM_IDENTITY_ALIGN_MISMATCH";
          throw error;
        },
      },
    }),
  });
  const result = parse(await factory(context()).execute("call-1", { action: "prepare", draft: draft("IT-20260805-121507-Q5R6") }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "WECOM_IDENTITY_ALIGN_MISMATCH");
  assert.equal(result.confirmationId, undefined);
});

test("identity.adapter 省略时默认走适配器", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-adadef-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const stateStore = createTestStore();
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({
      createRequest: async () => ({ requestId: "1" }),
      identity: {},
      identityAdapter: {
        resolve: async () => ({ mappingCode: "abc", oaUserId: "30538" }),
      },
    }),
  });
  const prepared = parse(await factory(context()).execute("call-1", { action: "prepare", draft: draft("IT-20260805-121508-S7T8") }));
  assert.equal(prepared.code, "AWAITING_CONFIRMATION");
  const pending = await getTicket(stateStore, prepared.confirmationId);
  assert.equal(pending.oaRequesterId, "30538");
});

test("identity.adapter 省略且无适配器时返回 OA_IDENTITY_NOT_FOUND", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-adanone-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const result = parse(await createOAWorkflowToolFactory({
    stateDir,
    stateStore: createTestStore(),
    dependencies: dependencies({
      createRequest: async () => ({ requestId: "1" }),
      identity: {},
    }),
  })(context()).execute("call-1", { action: "prepare", draft: draft("IT-20260805-121509-U9V0") }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "OA_IDENTITY_NOT_FOUND");
  assert.match(result.hintZh, /还不能提交到 OA/);
});

test("prepare 不要求模型传工单号，且忽略模型传入的非法或自编编号", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-alloc-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createTestStore(),
    dependencies: dependencies({ createRequest: async () => ({ requestId: "1" }) }),
  });
  const ctx = context("wecom-user-1", "room-1", {
    messageId: "af41832830918c2415b6fdbe47eaafd9",
    WeComReceivedAt: "2026-09-08 16:19:19",
  });
  const tool = factory(ctx);
  const omitted = parse(await tool.execute("call-1", {
    action: "prepare",
    draft: {
      ticketType: "运维支持",
      systemName: "MES系统（越南B部）",
      summary: "MES终端无法登录",
      problemDescription: "越南A栋二楼MES终端提示登录失败。",
      impactScope: "一条生产线",
    },
  }));
  assert.equal(omitted.code, "AWAITING_CONFIRMATION");
  assert.equal(omitted.summary.externalTicketId, "IT-20260908-161919-AF41");

  parse(await tool.execute("call-2", { action: "cancel", confirmationId: omitted.confirmationId }));
  const ignored = parse(await tool.execute("call-3", {
    action: "prepare",
    draft: {
      externalTicketId: "not-a-ticket",
      ticketType: "运维支持",
      systemName: "MES系统（越南B部）",
      summary: "MES终端无法登录",
      problemDescription: "越南A栋二楼MES终端提示登录失败。",
    },
  }));
  assert.equal(ignored.code, "AWAITING_CONFIRMATION");
  assert.equal(ignored.summary.externalTicketId, "IT-20260908-161919-AF41");
});

test("prepare 类型与系统不匹配时带可行动 hintZh，不是泛化请稍后重试", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-system-hint-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createTestStore(),
    dependencies: dependencies({ createRequest: async () => ({ requestId: "1" }) }),
  });
  const result = parse(await factory(context()).execute("call-1", {
    action: "prepare",
    draft: { ...draft(), systemName: "电脑/打印机/网络问题（智园）" },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "SYSTEM_NOT_ALLOWED");
  assert.match(result.hintZh, /类型和所属系统对不上/);
  assert.doesNotMatch(result.hintZh, /请稍后重试/);
});

test("OA 明确拒绝 PARAM_ERROR 带回执 hintZh，禁止模型只看到英文", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-param-hint-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createTestStore(),
    dependencies: dependencies({
      createRequest: async () => {
        throw new OAClientError("OA rejected the workflow request", { code: "PARAM_ERROR" });
      },
    }),
  });
  const tool = factory(context());
  const prepared = parse(await tool.execute("call-1", { action: "prepare", draft: draft("IT-20260805-121520-P1A2") }));
  const rejected = parse(await tool.execute("call-2", {
    action: "submit_confirmed",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(rejected.code, "PARAM_ERROR");
  assert.match(rejected.hintZh, /OA 拒绝了这张单/);
});

test("OA 明确拒绝后结束确认单：查进度不再待确认，同号不能再交，可开新单", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-param-close-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const stateStore = createTestStore();
  let createCount = 0;
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({
      createRequest: async () => {
        createCount += 1;
        throw new OAClientError("OA rejected the workflow request", { code: "PARAM_ERROR" });
      },
    }),
  });
  const tool = factory(context());
  const prepared = parse(await tool.execute("call-1", { action: "prepare", draft: draft("IT-20260805-121521-P1A3") }));
  const pendingBefore = await getTicket(stateStore, prepared.confirmationId);
  const identity = pendingBefore.identity;
  const rejected = parse(await tool.execute("call-2", {
    action: "submit_confirmed",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(rejected.code, "PARAM_ERROR");
  assert.equal(createCount, 1);
  assert.equal(await getActiveTicket(stateStore, identity), null);
  const failedTicket = await getTicket(stateStore, prepared.confirmationId);
  assert.equal(failedTicket.status, "failed");
  assert.equal(failedTicket.errorCode, "PARAM_ERROR");
  assert.equal(failedTicket.draft, null);
  await assert.rejects(() => access(path.join(stagingPaths(stateDir).stagingRoot, prepared.confirmationId)));

  const byId = parse(await tool.execute("call-3", { action: "status", confirmationId: prepared.confirmationId }));
  assert.equal(byId.code, "OA_CREATE_REJECTED");
  const person = parse(await tool.execute("call-4", { action: "status" }));
  assert.equal(person.code, "PERSON_STATUS");
  assert.equal(person.pending, null);
  assert.equal(person.recent[0].status, "failed");

  const retry = parse(await tool.execute("call-5", {
    action: "submit_confirmed",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(retry.code, "OA_CREATE_REJECTED");
  assert.equal(createCount, 1);

  const nextTool = factory(context("wecom-user-1", "room-1", {
    messageId: "n3xtxxxx",
    WeComReceivedAt: "2026-08-05 12:17:00",
  }));
  const next = parse(await nextTool.execute("call-6", { action: "prepare", draft: draft("IT-20260805-121700-N3XT") }));
  assert.equal(next.code, "AWAITING_CONFIRMATION");
  assert.notEqual(next.confirmationId, prepared.confirmationId);
});

test("OA 已成功后库里写 submitted 失败时不改判 failed，重提不调 OA", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-c1-persist-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const stateStore = createTestStore();
  failWhenWritingSubmitted(stateStore);
  let createCount = 0;
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({
      createRequest: async () => {
        createCount += 1;
        return { requestId: "1509001" };
      },
    }),
  });
  const tool = factory(context());
  const prepared = parse(await tool.execute("call-1", { action: "prepare", draft: draft("IT-20260805-121540-C1A1") }));
  const first = parse(await tool.execute("call-2", {
    action: "submit_confirmed",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(createCount, 1);
  assert.notEqual(first.code, "OA_CREATE_REJECTED");
  assert.notEqual(first.code, "PARAM_ERROR");
  assert.equal(first.requestId, "1509001");
  const ledger = await getTicket(stateStore, prepared.confirmationId);
  assert.equal(ledger.status, "unknown");
  assert.equal(ledger.requestId, "1509001", "OA 单号留在待对账记录里");

  const nextPrepare = parse(await tool.execute("call-3", { action: "prepare", draft: draft("IT-20260805-121541-C1N1") }));
  assert.equal(nextPrepare.code, "ALREADY_PENDING");
  assert.equal(createCount, 1);

  const retry = parse(await tool.execute("call-4", {
    action: "submit_confirmed",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(retry.code, "RECONCILIATION_REQUIRED");
  assert.equal(createCount, 1);
});

test("OA 已成功且已记 submitted 后，staging 清理失败仍返回 SUBMITTED", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-c1-staging-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const stateStore = createTestStore();
  let createCount = 0;
  let cleanupCalls = 0;
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: {
      ...dependencies({
        createRequest: async () => {
          createCount += 1;
          return { requestId: "1509002" };
        },
      }),
      removeStagingDirectory: async () => {
        cleanupCalls += 1;
        throw new Error("staging directory busy");
      },
    },
  });
  const tool = factory(context());
  const prepared = parse(await tool.execute("call-1", { action: "prepare", draft: draft("IT-20260805-121542-C1B2") }));
  const submitted = parse(await tool.execute("call-2", {
    action: "submit_confirmed",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(submitted.code, "SUBMITTED");
  assert.equal(submitted.requestId, "1509002");
  assert.equal(createCount, 1);
  assert.equal(cleanupCalls, 1);
  const submittedTicket = await getTicket(stateStore, prepared.confirmationId);
  assert.equal(submittedTicket.status, "submitted");
  assert.equal(submittedTicket.requestId, "1509002");
  assert.equal(submittedTicket.draft, null, "提交后不留描述，只留台账");

  const retry = parse(await tool.execute("call-3", {
    action: "submit_confirmed",
    confirmationId: prepared.confirmationId,
  }));
  assert.equal(retry.code, "ALREADY_SUBMITTED");
  assert.equal(retry.requestId, "1509002");
  assert.equal(createCount, 1);
});

test("数据库断连记 DB_UNAVAILABLE 而不是 VALIDATION_ERROR", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-down-hint-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const stateStore = createTestStore();
  stateStore.db.query = async () => {
    const error = new Error("connect ECONNREFUSED 10.0.0.5:3306");
    error.code = "ECONNREFUSED";
    throw error;
  };
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore,
    dependencies: dependencies({ createRequest: async () => ({ requestId: "1" }) }),
  });
  const result = parse(await factory(context()).execute("call-1", { action: "prepare", draft: draft() }));
  assert.equal(result.code, "DB_UNAVAILABLE");
  assert.match(result.hintZh, /请稍后重试/);
});

test("cancel 缺 confirmationId 返回 MISSING_CONFIRMATION_ID 与中文 hintZh", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "xa-oa-missing-id-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, "media", "inbound"), { recursive: true });
  const factory = createOAWorkflowToolFactory({
    stateDir,
    stateStore: createTestStore(),
    dependencies: dependencies({ createRequest: async () => ({ requestId: "1" }) }),
  });
  const result = parse(await factory(context()).execute("call-1", { action: "cancel" }));
  assert.equal(result.code, "MISSING_CONFIRMATION_ID");
  assert.match(result.hintZh, /确认号/);
});

