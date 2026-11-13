import assert from "node:assert/strict";
import test from "node:test";
import { loadSystems } from "../src/config.mjs";
import { allocateExternalTicketId, buildCreatePayload, normalizeDraft, pendingFaultLocation, summarize } from "../src/mapping.mjs";

function oaConfig(overrides = {}) {
  return { workflowId: 602, attachmentFieldName: "", isnextflow: "0", ...overrides };
}

const systems = new Map([
  ["MES系统（越南B部）", 8],
  ["OA系统", 2],
  ["电脑/打印机/网络问题（智园）", 10],
  ["电脑/打印机/网络问题（越南）", 13],
  ["邮箱系统（国内）", 5],
]);

const typeSystems = new Map([
  ["运维支持", new Set(["MES系统（越南B部）", "OA系统", "电脑/打印机/网络问题（智园）", "电脑/打印机/网络问题（越南）", "邮箱系统（国内）"])],
  ["权限申请", new Set(["OA系统", "邮箱系统（国内）"])],
  ["IT需求", new Set(["OA系统"])],
]);

const handlers = new Map([
  ["MES系统（越南B部）", "18196,10251"],
  ["OA系统", "4280,8134"],
  ["电脑/打印机/网络问题（智园）", "938"],
  ["电脑/打印机/网络问题（越南）", "6161,8232,8254"],
  ["邮箱系统（国内）", "938"],
]);

const SYSTEMS = { options: systems, typeSystems, handlers };

const profile = { departmentId: "714", jobTitleId: "636", locationId: "3" };

test("运维支持映射到已批准的OA字段和选项值", () => {
  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120000-AB12",
    ticketType: "运维支持",
    systemName: "MES系统（越南B部）",
    summary: "生产线MES无法登录",
    problemDescription: "A栋二楼生产线MES无法登录。",
    impactScope: "一条生产线",
  }, SYSTEMS);
  const payload = buildCreatePayload({
    config: oaConfig(),
    draft,
    oaRequesterId: "1001",
    profile,
    supplement: "无需补充，确认提交",
  });

  assert.equal(payload.workflowId, 602);
  assert.equal(payload.otherParams.isnextflow, "0");
  assert.equal(payload.otherParams.delReqFlowFaild, "1");
  assert.equal(payload.otherParams.isVerifyPer, "1");
  assert.deepEqual(
    payload.mainData.slice(0, 6),
    [
      { fieldName: "xqsqr", fieldValue: "1001" },
      { fieldName: "xqsqbm", fieldValue: "714" },
      { fieldName: "gw", fieldValue: "636" },
      { fieldName: "bgdd", fieldValue: "3" },
      { fieldName: "sqlx", fieldValue: "0" },
      { fieldName: "wtlx", fieldValue: "8" },
    ],
  );
  const description = payload.mainData.find((field) => field.fieldName === "wtxqmskftp").fieldValue;
  assert.match(description, /最终补充：无需补充，确认提交/);
  assert.doesNotMatch(description, /xA工单编号/);
  assert.doesNotMatch(description, /IT-20260805-120000-AB12/);
  assert.equal(payload.mainData.find((field) => field.fieldName === "clry").fieldValue, "18196,10251");
  assert.equal(payload.requestName, "[IT-20260805-120000-AB12] A栋二楼生产线MES无法登录");
});

test("IT需求必须包含需求类型和月节约工时", () => {
  assert.throws(
    () => normalizeDraft({
      externalTicketId: "IT-20260805-120001-CD34",
      ticketType: "IT需求",
      systemName: "OA系统",
      summary: "流程优化",
      problemDescription: "希望减少重复录入。",
    }, SYSTEMS),
    /demandType/,
  );

  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120001-CD34",
    ticketType: "IT需求",
    systemName: "OA系统",
    summary: "流程优化",
    problemDescription: "希望减少重复录入。",
    demandType: "流程优化",
    monthlyHours: 12.5,
  }, SYSTEMS);
  const payload = buildCreatePayload({
    config: oaConfig(),
    draft,
    oaRequesterId: "1002",
    profile,
  });
  assert.deepEqual(payload.mainData.slice(-2), [
    { fieldName: "xqlx1", fieldValue: "1" },
    { fieldName: "yjygsh", fieldValue: "12.5" },
  ]);
});

test("有文档附件但未确认OA附件字段时拒绝生成请求", () => {
  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120002-EF56",
    ticketType: "权限申请",
    systemName: "OA系统",
    summary: "申请查询权限",
    problemDescription: "申请只读查询权限。",
  }, SYSTEMS);
  assert.throws(
    () => buildCreatePayload({
      config: oaConfig(),
      draft,
      oaRequesterId: "1003",
      profile,
      attachments: [{ filePath: "base64", fileName: "evidence.pdf" }],
    }),
    /attachment field is not configured/,
  );
});

test("拒绝当前工单类型不允许的所属系统", () => {
  assert.throws(
    () => normalizeDraft({
      externalTicketId: "IT-20260805-120003-GH78",
      ticketType: "权限申请",
      systemName: "电脑/打印机/网络问题（越南）",
      summary: "电脑开不了机",
      problemDescription: "工位电脑无法开机。",
    }, SYSTEMS),
    /not allowed for this ticket type/,
  );

  assert.throws(
    () => normalizeDraft({
      externalTicketId: "IT-20260805-120004-JK90",
      ticketType: "IT需求",
      systemName: "邮箱系统（国内）",
      summary: "邮箱改造",
      problemDescription: "希望改造邮箱流程。",
      demandType: "流程优化",
      monthlyHours: 1,
    }, SYSTEMS),
    /not allowed for this ticket type/,
  );
});

test("缺少申请人资料资源 ID 时拒绝生成请求", () => {
  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120006-NP34",
    ticketType: "运维支持",
    systemName: "MES系统（越南B部）",
    summary: "MES无法登录",
    problemDescription: "终端提示登录失败。",
  }, SYSTEMS);
  assert.throws(
    () => buildCreatePayload({
      config: oaConfig(),
      draft,
      oaRequesterId: "1001",
    }),
    (error) => error.code === "OA_PROFILE_INCOMPLETE",
  );
});

test("规则未命中：不传类型和系统时兜底为运维支持 / 其他", async () => {
  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120005-LM12",
    summary: "帮我把流程退回",
    problemDescription: "帮我把流程退回。",
  }, await loadSystems());
  assert.equal(draft.ticketType, "运维支持");
  assert.equal(draft.systemName, "其他");
  assert.equal(draft.systemOptionId, 17);
  assert.equal(draft.handlerIds, "4280");
});

test("类型已命中、系统未命中：保留类型，系统兜底为其他", async () => {
  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120005-LM13",
    ticketType: "权限申请",
    summary: "申请开通权限",
    problemDescription: "申请开通某系统权限。",
  }, await loadSystems());
  assert.equal(draft.ticketType, "权限申请");
  assert.equal(draft.systemName, "其他");
});

test("兜底不放过非法组合：传了系统名但类型不允许仍拒绝", async () => {
  assert.throws(
    () => normalizeDraft({
      externalTicketId: "IT-20260805-120005-LM14",
      ticketType: "权限申请",
      systemName: "OA开发支持",
      summary: "x",
      problemDescription: "x",
    }, SYSTEMS),
    (error) => error.code === "SYSTEM_NOT_ALLOWED",
  );
});

test("systems.json 的类型白名单与原清单一致", async () => {
  const loaded = (await loadSystems()).typeSystems;
  assert.equal(loaded.get("权限申请").has("电脑/打印机/网络问题（越南）"), false);
  assert.equal(loaded.get("IT需求").has("邮箱系统（国内）"), false);
  assert.equal(loaded.get("运维支持").has("MES系统（越南B部）"), true);
  assert.equal(loaded.get("运维支持").has("邮箱系统（国内）"), true);
  assert.equal(loaded.get("运维支持").has("文件管理系统（国内）"), true);
  assert.equal(loaded.get("运维支持").has("MES系统（越南）"), false);
  assert.equal(loaded.get("运维支持").has("邮箱系统"), false);
  assert.equal(loaded.get("运维支持").has("文件管理系统"), false);
  assert.equal(loaded.get("权限申请").has("OA系统"), true);
  assert.equal(loaded.get("运维支持").has("MES系统（越南C部）"), true);
  assert.equal(loaded.get("运维支持").has("法大大电子签平台"), true);
  assert.equal(loaded.get("权限申请").has("MES系统（越南C部）"), true);
  assert.equal(loaded.get("权限申请").has("法大大电子签平台"), true);
  assert.equal(loaded.get("IT需求").has("MES系统（越南C部）"), true);
  assert.equal(loaded.get("IT需求").has("法大大电子签平台"), true);
});

test("systems.json 选项 ID 与处理人对齐 OA 调用步骤 v3.0 系统名", async () => {
  const { options, handlers: loadedHandlers } = await loadSystems();
  assert.equal(options.get("邮箱系统（国内）"), 5);
  assert.equal(options.get("MES系统（越南B部）"), 8);
  assert.equal(options.get("文件管理系统（国内）"), 9);
  assert.equal(options.get("MES系统（越南C部）"), 23);
  assert.equal(options.get("法大大电子签平台"), 24);
  assert.equal(options.has("邮箱系统"), false);
  assert.equal(options.has("MES系统（越南）"), false);
  assert.equal(options.has("文件管理系统"), false);
  assert.equal([...options.values()].includes(22), false);
  assert.equal(loadedHandlers.get("MES系统（越南B部）"), "18196,10251");
  assert.equal(loadedHandlers.get("MES系统（越南C部）"), "18196,27697,27507,27338,9777");
  assert.equal(loadedHandlers.get("法大大电子签平台"), "9673");
  for (const name of options.keys()) {
    assert.match(loadedHandlers.get(name) || "", /^[1-9]\d{0,17}(,[1-9]\d{0,17})*$/);
  }
});

test("已配置 scfj 时文档附件写入 mainData", () => {
  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120007-QR56",
    ticketType: "权限申请",
    systemName: "OA系统",
    summary: "申请查询权限",
    problemDescription: "申请只读查询权限。",
  }, SYSTEMS);
  const payload = buildCreatePayload({
    config: oaConfig({ attachmentFieldName: "scfj" }),
    draft,
    oaRequesterId: "1003",
    profile,
    attachments: [{ filePath: "base64", fileName: "evidence.pdf" }],
  });
  const attachmentField = payload.mainData.find((field) => field.fieldName === "scfj");
  assert.equal(typeof attachmentField.fieldValue, "string");
  assert.deepEqual(
    JSON.parse(attachmentField.fieldValue),
    [{ filePath: "base64", fileName: "evidence.pdf" }],
  );
  assert.equal(payload.mainData.find((field) => field.fieldName === "clry").fieldValue, "4280,8134");
});

test("图片嵌入 wtxqmskftp，不写入 scfj；无文档时不要求附件字段", () => {
  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120009-UV90",
    ticketType: "权限申请",
    systemName: "OA系统",
    summary: "申请查询权限",
    problemDescription: "申请只读查询权限。",
    impactScope: "财务只读",
  }, SYSTEMS);
  const payload = buildCreatePayload({
    config: oaConfig(),
    draft,
    oaRequesterId: "1003",
    profile,
    images: [{ fileName: "evidence.png", dataUri: "data:image/jpeg;base64,abc" }],
  });
  const description = payload.mainData.find((field) => field.fieldName === "wtxqmskftp").fieldValue;
  assert.match(description, /申请只读查询权限。/);
  assert.match(description, /<img src="data:image\/jpeg;base64,abc" alt="evidence.png" \/>/);
  assert.match(description, /影响范围：财务只读/);
  assert.equal(payload.mainData.find((field) => field.fieldName === "scfj"), undefined);
});

test("无图也转义描述并把换行写成 br，不把员工原文当 HTML", () => {
  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120010-WX12",
    ticketType: "运维支持",
    systemName: "OA系统",
    summary: "报错弹窗",
    problemDescription: "第一行 <script>alert(1)</script>\n第二行 A&B",
    impactScope: "<b>整个部门</b>",
  }, SYSTEMS);
  const payload = buildCreatePayload({
    config: oaConfig(),
    draft,
    oaRequesterId: "1001",
    profile,
  });
  const description = payload.mainData.find((field) => field.fieldName === "wtxqmskftp").fieldValue;
  assert.doesNotMatch(description, /<script>/);
  assert.match(description, /&lt;script&gt;/);
  assert.match(description, /A&amp;B/);
  assert.match(description, /第一行[^]*?<br\/>第二行/);
  assert.match(description, /影响范围：&lt;b&gt;整个部门&lt;\/b&gt;/);
  assert.doesNotMatch(description, /\n/);
});

test("有图时描述同样转义，img 标签本身不被转义", () => {
  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120011-YZ34",
    ticketType: "运维支持",
    systemName: "OA系统",
    summary: "报错弹窗",
    problemDescription: "描述 <script>alert(1)</script>",
  }, SYSTEMS);
  const payload = buildCreatePayload({
    config: oaConfig(),
    draft,
    oaRequesterId: "1001",
    profile,
    images: [{ fileName: "a<b>.png", dataUri: "data:image/jpeg;base64,abc" }],
  });
  const description = payload.mainData.find((field) => field.fieldName === "wtxqmskftp").fieldValue;
  assert.doesNotMatch(description, /<script>/);
  assert.match(description, /<img src="data:image\/jpeg;base64,abc" alt="a&lt;b&gt;\.png" \/>/);
});

test("缺少处理人 id 时拒绝建单", () => {
  assert.throws(
    () => normalizeDraft({
      externalTicketId: "IT-20260805-120008-ST78",
      ticketType: "运维支持",
      systemName: "MES系统（越南B部）",
      summary: "MES无法登录",
      problemDescription: "终端提示登录失败。",
    }, { ...SYSTEMS, handlers: new Map() }),
    /handler IDs are not configured/,
  );
  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120008-ST79",
    ticketType: "运维支持",
    systemName: "MES系统（越南B部）",
    summary: "MES无法登录",
    problemDescription: "终端提示登录失败。",
  }, SYSTEMS);
  assert.throws(
    () => buildCreatePayload({ config: oaConfig(), draft: { ...draft, handlerIds: "" }, oaRequesterId: "1001", profile }),
    /handler IDs are not configured/,
  );
});

test("插件按 WeComReceivedAt 与 message_id 生成内部幂等号", () => {
  const id = allocateExternalTicketId({
    messageId: "af41832830918c2415b6fdbe47eaafd9",
    WeComReceivedAt: "2026-09-08 16:19:19",
    sessionKey: "room-1",
  });
  assert.equal(id, "IT-20260908-161919-AF41");
});

test("同一 message_id 与收到时间得到同一内部幂等号", () => {
  const ctx = {
    messageId: "b9fe8106e2631110fa473fbc377ba11e",
    WeComReceivedAt: "2026-09-08 16:32:12",
    sessionKey: "room-1",
  };
  assert.equal(allocateExternalTicketId(ctx, 1), allocateExternalTicketId(ctx, 9_999_999));
  assert.equal(allocateExternalTicketId(ctx), "IT-20260908-163212-B9FE");
});

test("无 message_id 时后缀由会话种子补齐，格式仍合法", () => {
  const id = allocateExternalTicketId({ sessionKey: "room-1" }, Date.parse("2026-09-08T09:19:19Z"));
  assert.match(id, /^IT-20260908-161919-[A-Z0-9]{4}$/);
});

test("短或空 message_id 时同秒两次 prepare 仍得到不同内部号", () => {
  const now = Date.parse("2026-09-08T09:19:19Z");
  const short = {
    messageId: "ab",
    WeComReceivedAt: "2026-09-08 16:19:19",
    sessionKey: "room-1",
    requesterSenderId: "wecom-user-1",
  };
  const empty = {
    WeComReceivedAt: "2026-09-08 16:19:19",
    sessionKey: "room-1",
    requesterSenderId: "wecom-user-1",
  };
  assert.notEqual(allocateExternalTicketId(short, now), allocateExternalTicketId(short, now));
  assert.notEqual(allocateExternalTicketId(empty, now), allocateExternalTicketId(empty, now));
  assert.match(allocateExternalTicketId(short, now), /^IT-20260908-161919-[A-Z0-9]{4}$/);
  assert.match(allocateExternalTicketId(empty, now), /^IT-20260908-161919-[A-Z0-9]{4}$/);
});

test("电脑类系统名兑底故障地点；模型传入 location 则原样保存", () => {
  const derived = normalizeDraft({
    externalTicketId: "IT-20260911-090000-LOC1",
    ticketType: "运维支持",
    systemName: "电脑/打印机/网络问题（智园）",
    summary: "电脑死机",
    problemDescription: "电脑死机。",
  }, SYSTEMS);
  assert.equal(derived.location, "智园");

  const explicit = normalizeDraft({
    externalTicketId: "IT-20260911-090001-LOC2",
    ticketType: "运维支持",
    systemName: "电脑/打印机/网络问题（智园）",
    location: "智园",
    summary: "电脑死机",
    problemDescription: "电脑死机。",
  }, SYSTEMS);
  assert.equal(explicit.location, "智园");
});

test("邮箱国内后缀和 MES 越南B部不兑成故障地点", () => {
  const mailbox = normalizeDraft({
    externalTicketId: "IT-20260911-090002-LOC3",
    ticketType: "运维支持",
    systemName: "邮箱系统（国内）",
    summary: "邮箱进不去",
    problemDescription: "邮箱进不去。",
  }, SYSTEMS);
  assert.equal(mailbox.location, "");

  const mes = normalizeDraft({
    externalTicketId: "IT-20260911-090003-LOC4",
    ticketType: "运维支持",
    systemName: "MES系统（越南B部）",
    summary: "MES无法登录",
    problemDescription: "终端提示登录失败。",
  }, SYSTEMS);
  assert.equal(mes.location, "");
});

test("非法 location 或与系统名园区不一致时拒绝", () => {
  assert.throws(
    () => normalizeDraft({
      externalTicketId: "IT-20260911-090004-LOC5",
      ticketType: "运维支持",
      systemName: "电脑/打印机/网络问题（智园）",
      location: "深圳",
      summary: "电脑死机",
      problemDescription: "电脑死机。",
    }, SYSTEMS),
    /location must be A–F or one of/,
  );
  assert.throws(
    () => normalizeDraft({
      externalTicketId: "IT-20260911-090005-LOC6",
      ticketType: "运维支持",
      systemName: "电脑/打印机/网络问题（智园）",
      location: "深汕",
      summary: "电脑死机",
      problemDescription: "电脑死机。",
    }, SYSTEMS),
    /location does not match systemName/,
  );
});

test("旧 pending 无 location 字段时从 systemName 兑底", () => {
  assert.equal(pendingFaultLocation({
    draft: { systemName: "电脑/打印机/网络问题（大磡）", summary: "打印机卡纸" },
  }), "大磡");
  assert.equal(pendingFaultLocation({
    draft: { systemName: "OA系统", summary: "流程卡住" },
  }), "");
});

test("isnextflow 按 bridge-config 写入 otherParams，1 也会原样发出", () => {
  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120000-AB12",
    ticketType: "运维支持",
    systemName: "OA系统",
    summary: "OA 待办打不开",
    problemDescription: "OA 待办打不开。",
  }, SYSTEMS);
  const payload = buildCreatePayload({
    config: oaConfig({ isnextflow: "1" }),
    draft,
    oaRequesterId: "1001",
    profile,
  });
  assert.equal(payload.otherParams.isnextflow, "1");
  assert.equal(payload.otherParams.delReqFlowFaild, "1");
  assert.equal(payload.otherParams.isVerifyPer, "1");
});

test("缺少或非法 isnextflow 时拒绝生成请求", () => {
  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120000-AB12",
    ticketType: "运维支持",
    systemName: "OA系统",
    summary: "OA 待办打不开",
    problemDescription: "OA 待办打不开。",
  }, SYSTEMS);
  assert.throws(
    () => buildCreatePayload({
      config: { workflowId: 602, attachmentFieldName: "" },
      draft,
      oaRequesterId: "1001",
      profile,
    }),
    /isnextflow must be "0" or "1"/,
  );
  assert.throws(
    () => buildCreatePayload({
      config: oaConfig({ isnextflow: "true" }),
      draft,
      oaRequesterId: "1001",
      profile,
    }),
    /isnextflow must be "0" or "1"/,
  );
});

test("问题预览由插件从员工原话截取，模型传的 summary 不再使用", () => {
  assert.equal(summarize("电脑死机。"), "电脑死机");
  assert.equal(summarize("4 个厂区同时用一套系统接单号，目前在文件系统里操作。数据会丢。"), "4 个厂区同时用一套系统接单号...");
  assert.equal(summarize("这是一段非常非常非常非常非常非常长没有标点的描述内容啊啊啊"), "这是一段非常非常非常非常非常非常长没有标...");
  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120000-SUM1",
    ticketType: "运维支持",
    systemName: "OA系统",
    summary: "模型改写过的另一句",
    problemDescription: "OA 待办打不开。",
  }, SYSTEMS);
  assert.equal(draft.summary, "OA 待办打不开");
});

test("地点可传字母 A–F，插件翻译成园区名", () => {
  const draft = normalizeDraft({
    externalTicketId: "IT-20260805-120000-LOCA",
    ticketType: "运维支持",
    systemName: "电脑/打印机/网络问题（智园）",
    location: "a",
    problemDescription: "电脑死机。",
  }, SYSTEMS);
  assert.equal(draft.location, "智园");
  assert.throws(() => normalizeDraft({
    externalTicketId: "IT-20260805-120000-LOCB",
    ticketType: "运维支持",
    systemName: "电脑/打印机/网络问题（智园）",
    location: "1",
    problemDescription: "电脑死机。",
  }, SYSTEMS), (error) => error.code === "INVALID_LOCATION");
});
