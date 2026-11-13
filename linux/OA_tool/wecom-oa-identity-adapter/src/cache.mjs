function normalizePrefix(value) {
  return String(value || "oa-workflow-bridge").trim().replace(/:+$/, "");
}

export function idmapKey(prefix, mappingCode) {
  return `${normalizePrefix(prefix)}:idmap:${mappingCode}`;
}

export function idmissKey(prefix, mappingCode) {
  return `${normalizePrefix(prefix)}:idmiss:${mappingCode}`;
}

export function createIdentityCache({
  redis,
  keyPrefix = "oa-workflow-bridge",
  ttlHours = 24,
  missTtlSeconds = 600,
}) {
  const prefix = normalizePrefix(keyPrefix);
  const hitTtl = Math.max(1, Number(ttlHours) * 3600);
  const missTtl = Math.max(1, Number(missTtlSeconds));

  return {
    async getIdmap(mappingCode) {
      if (!redis || !/^[a-f0-9]{24}$/.test(mappingCode)) return "";
      const raw = await redis.get(idmapKey(prefix, mappingCode));
      if (!raw) return "";
      try {
        const parsed = JSON.parse(raw);
        return /^\d{1,18}$/.test(String(parsed?.oaUserId || "")) ? String(parsed.oaUserId) : "";
      } catch {
        return /^\d{1,18}$/.test(String(raw)) ? String(raw) : "";
      }
    },

    async getIdmiss(mappingCode) {
      if (!redis || !/^[a-f0-9]{24}$/.test(mappingCode)) return "";
      const value = await redis.get(idmissKey(prefix, mappingCode));
      return typeof value === "string" && value.trim() ? value.trim() : "";
    },

    async setIdmap(mappingCode, oaUserId) {
      if (!redis) {
        console.warn("[wecom-oa-identity-adapter] identity cache skipped: redis is not configured");
        return;
      }
      if (!/^[a-f0-9]{24}$/.test(mappingCode) || !/^\d{1,18}$/.test(oaUserId)) return;
      await redis.set(
        idmapKey(prefix, mappingCode),
        JSON.stringify({ oaUserId, cachedAt: new Date().toISOString() }),
        { EX: hitTtl },
      );
    },

    async setIdmiss(mappingCode, code) {
      if (!redis || !/^[a-f0-9]{24}$/.test(mappingCode) || !code) return;
      await redis.set(idmissKey(prefix, mappingCode), String(code), { EX: missTtl });
    },
  };
}
