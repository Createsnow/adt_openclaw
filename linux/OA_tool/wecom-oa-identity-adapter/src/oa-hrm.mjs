import { IDENTITY_CODES, IdentityError } from "./errors.mjs";

function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new IdentityError("OA HR returned invalid JSON", { code: IDENTITY_CODES.LOOKUP_FAILED });
  }
}

const INACTIVE_STATUS = new Set(["4", "5", "6", "7"]);

export class OaHrmClient {
  constructor({
    baseUrl = "https://adtekoa.com",
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  sanitizeError(code, message) {
    return new IdentityError(message, { code });
  }

  async lookupUserIdByWorkcode(workcode) {
    const jobNumber = String(workcode || "").trim();
    if (!jobNumber) {
      throw this.sanitizeError(IDENTITY_CODES.NOT_FOUND, "OA workcode is empty");
    }
    let body;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/hrm/resful/getHrmUserInfoWithPage`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ params: { workcode: jobNumber } }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        throw this.sanitizeError(IDENTITY_CODES.LOOKUP_FAILED, `OA HR returned HTTP ${response.status}`);
      }
      body = readJson(await response.text());
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      throw this.sanitizeError(IDENTITY_CODES.LOOKUP_FAILED, "OA HR request failed");
    }
    if (String(body?.code) !== "1") {
      throw this.sanitizeError(IDENTITY_CODES.LOOKUP_FAILED, "OA HR lookup was rejected");
    }
    const rows = Array.isArray(body?.data?.dataList) ? body.data.dataList : [];
    const total = Number(body?.data?.totalSize);
    if (!rows.length || total === 0) {
      throw this.sanitizeError(IDENTITY_CODES.NOT_FOUND, "OA person was not found");
    }
    if (total > 1 || rows.length > 1) {
      throw this.sanitizeError(IDENTITY_CODES.AMBIGUOUS, "OA workcode matched more than one person");
    }
    const row = rows[0] || {};
    if (INACTIVE_STATUS.has(String(row.status))) {
      throw this.sanitizeError(IDENTITY_CODES.INACTIVE, "OA person is inactive");
    }
    if (String(row.accounttype) === "1") {
      throw this.sanitizeError(IDENTITY_CODES.INACTIVE, "OA person is a secondary account");
    }
    const oaUserId = String(row.id || "").trim();
    if (!/^\d{1,18}$/.test(oaUserId)) {
      throw this.sanitizeError(IDENTITY_CODES.LOOKUP_FAILED, "OA HR response did not include a numeric person id");
    }
    return oaUserId;
  }
}
