import { getIdentityCache, setIdentityCache } from "../store.mjs";
import { identityCode } from "../trust.mjs";
import { IDENTITY_CODES, IdentityError } from "./errors.mjs";
import { OaHrmClient } from "./oa-hrm.mjs";
import { WecomClient } from "./wecom-client.mjs";

/** 命中缓存 24 小时；查不到 / 不对齐的负缓存 10 分钟，避免反复打企微和人事接口。 */
export const IDENTITY_HIT_TTL_MS = 24 * 60 * 60 * 1000;
export const IDENTITY_MISS_TTL_MS = 10 * 60 * 1000;

/** 企微明文 userid 就是 OA 工号；扩展属性「工号」若存在必须相等。 */
export function alignWorkcode({ userid, extattrJobNumber }) {
  const plain = String(userid || "").trim();
  const ext = String(extattrJobNumber || "").trim();
  if (!plain) {
    throw new IdentityError("WeCom userid is empty", { code: IDENTITY_CODES.OPENUSERID_INVALID });
  }
  if (ext && ext !== plain) {
    throw new IdentityError("WeCom userid does not match job number attribute", { code: IDENTITY_CODES.ALIGN_MISMATCH });
  }
  return plain;
}

/**
 * 企微加密 SenderId → OA 人员 id。查找键 mappingCode = SHA-256(SenderId) 截前 24 位（与工单 sender_code 相同）。
 * 明文 userid / 工号不落库、不打日志。企微 / 人事 HTTP 不重试。
 */
export function createIdentityResolver({
  store,
  oaBaseUrl,
  fetchImpl = globalThis.fetch,
  wecomClient,
  hrmClient,
  includePlainUserid = false,
} = {}) {
  const wecom = wecomClient || new WecomClient({ fetchImpl });
  const hrm = hrmClient || new OaHrmClient({ baseUrl: oaBaseUrl, fetchImpl });

  async function resolve(senderId) {
    const raw = String(senderId || "").trim();
    if (!raw) {
      throw new IdentityError("WeCom sender id is required", { code: IDENTITY_CODES.INVALID_SENDER });
    }
    const mappingCode = identityCode(raw);
    const cached = await getIdentityCache(store, mappingCode);
    if (cached.oaUserId) return { mappingCode, oaUserId: cached.oaUserId };
    if (cached.missCode) {
      throw new IdentityError("WeCom identity lookup recently failed", { code: cached.missCode });
    }

    try {
      const lookedUp = await wecom.lookupUserid(raw);
      const workcode = alignWorkcode(lookedUp);
      const oaUserId = await hrm.lookupUserIdByWorkcode(workcode);
      await setIdentityCache(store, mappingCode, { oaUserId }, IDENTITY_HIT_TTL_MS);
      const result = { mappingCode, oaUserId };
      if (includePlainUserid) result.userid = lookedUp.userid;
      return result;
    } catch (error) {
      const code = error instanceof IdentityError ? error.code : IDENTITY_CODES.LOOKUP_FAILED;
      if (code !== IDENTITY_CODES.NOT_CONFIGURED && code !== IDENTITY_CODES.TOKEN_FAILED) {
        await setIdentityCache(store, mappingCode, { missCode: code }, IDENTITY_MISS_TTL_MS);
      }
      if (error instanceof IdentityError) throw error;
      throw new IdentityError("Identity resolve failed", { code });
    }
  }

  return { resolve };
}

export { IdentityError, IDENTITY_CODES };
