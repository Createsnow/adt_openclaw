/**
 * 测试：现网建单并明文打印 doCreateRequest 参数。
 * LIVE_OA_CREATE=1 才会真正调 OA。
 */
import { loadBridgeConfig, loadSystems } from "../src/config.mjs";
import { OAClient } from "../src/oa-client.mjs";
import { lookupRequesterProfile } from "../src/hrm-profile.mjs";
import { buildCreatePayload, normalizeDraft } from "../src/mapping.mjs";

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

if (process.env.LIVE_OA_CREATE !== "1") {
  console.error(JSON.stringify({ ok: false, code: "LIVE_OA_CREATE_DISABLED" }));
  process.exit(2);
}

const config = await loadBridgeConfig();
const client = new OAClient({ config });
const { apiUserId } = await client.getCoreCredentials();
const requesterUserId = String(process.env.OA_TEST_REQUESTER_ID || apiUserId).trim();
const profile = await lookupRequesterProfile({ oaUserId: requesterUserId, client });
const draft = normalizeDraft({
  externalTicketId: `IT-${stamp()}-PRT1`,
  ticketType: "运维支持",
  systemName: "OA开发支持",
  summary: "明文参数联调请勿处理",
  problemDescription: "接口联调：打印 doCreateRequest 明文参数。请勿处理，可忽略。",
}, await loadSystems());
const payload = buildCreatePayload({
  config,
  draft,
  oaRequesterId: requesterUserId,
  profile,
});

const printed = {
  url: `${config.baseUrl}/api/workflow/paService/doCreateRequest`,
  method: "POST",
  headers: {
    appid: config.appId,
    userid: requesterUserId,
    token: "[redacted]",
    "content-type": "application/json",
  },
  body: payload,
};
console.log("===== doCreateRequest 明文参数 =====");
console.log(JSON.stringify(printed, null, 2));

const created = await client.createRequest(payload, { requesterUserId });
console.log("===== 建单结果 =====");
console.log(JSON.stringify({ ok: true, requestId: created.requestId }, null, 2));
