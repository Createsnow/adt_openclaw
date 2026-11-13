import { createHash } from "node:crypto";
import { alignWorkcode } from "./align.mjs";
import { createIdentityCache } from "./cache.mjs";
import { loadAdapterConfig } from "./config.mjs";
import { IDENTITY_CODES, IdentityError } from "./errors.mjs";
import { OaHrmClient } from "./oa-hrm.mjs";
import { resolveIdentitySecrets } from "./secret-resolver.mjs";
import { WecomClient } from "./wecom-client.mjs";

export function mappingCodeOf(senderId) {
  return createHash("sha256").update(String(senderId), "utf8").digest("hex").slice(0, 24);
}

export function createIdentityResolver({
  redis,
  keyPrefix,
  oaConfig,
  adapterConfig,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  resolveSecrets = resolveIdentitySecrets,
  wecomClient,
  hrmClient,
  includePlainUserid = false,
} = {}) {
  const config = adapterConfig;
  const prefix = keyPrefix || config?.cache?.keyPrefix || oaConfig?.redis?.keyPrefix || "oa-workflow-bridge";
  const cache = createIdentityCache({
    redis,
    keyPrefix: prefix,
    ttlHours: config?.cache?.ttlHours || 24,
    missTtlSeconds: config?.cache?.missTtlSeconds || 600,
  });
  const wecom = wecomClient || new WecomClient({
    baseUrl: config?.wecomBaseUrl,
    resolveSecrets,
    fetchImpl,
    now,
    tokenCacheMs: config?.wecomTokenCacheMs,
  });
  const hrm = hrmClient || new OaHrmClient({
    baseUrl: oaConfig?.baseUrl || config?.oaBaseUrl,
    fetchImpl,
  });

  async function getCachedOaUserId(mappingCode) {
    return cache.getIdmap(mappingCode);
  }

  async function resolve(senderId) {
    const raw = String(senderId || "").trim();
    if (!raw) {
      throw new IdentityError("WeCom sender id is required", { code: IDENTITY_CODES.INVALID_SENDER });
    }
    const mappingCode = mappingCodeOf(raw);
    const cached = await cache.getIdmap(mappingCode);
    if (cached) return { mappingCode, oaUserId: cached };

    const missed = await cache.getIdmiss(mappingCode);
    if (missed) {
      throw new IdentityError("WeCom identity lookup recently failed", { code: missed });
    }

    try {
      const lookedUp = await wecom.lookupUserid(raw);
      const workcode = alignWorkcode({
        userid: lookedUp.userid,
        extattrJobNumber: lookedUp.extattrJobNumber,
        mode: config?.alignMode || "userid_equals_workcode",
      });
      const oaUserId = await hrm.lookupUserIdByWorkcode(workcode);
      await cache.setIdmap(mappingCode, oaUserId);
      const result = { mappingCode, oaUserId };
      if (includePlainUserid) result.userid = lookedUp.userid;
      return result;
    } catch (error) {
      const code = error instanceof IdentityError ? error.code : IDENTITY_CODES.LOOKUP_FAILED;
      if (code !== IDENTITY_CODES.NOT_CONFIGURED && code !== IDENTITY_CODES.TOKEN_FAILED) {
        await cache.setIdmiss(mappingCode, code);
      }
      if (error instanceof IdentityError) throw error;
      throw new IdentityError("Identity resolve failed", { code });
    }
  }

  return { getCachedOaUserId, resolve, mappingCodeOf };
}

export async function createIdentityResolverFromFiles(options = {}) {
  const adapterConfig = options.adapterConfig || await loadAdapterConfig();
  return createIdentityResolver({ ...options, adapterConfig });
}

export { IdentityError, IDENTITY_CODES };
