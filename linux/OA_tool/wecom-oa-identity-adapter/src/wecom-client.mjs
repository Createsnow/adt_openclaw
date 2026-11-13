import { IDENTITY_CODES, IdentityError } from "./errors.mjs";

const WECOM_TOKEN_CACHE_MS = 5_400_000;
const TOKEN_ERRCODES = new Set([40001, 40013, 40014, 41001, 42001]);
const OUT_OF_SCOPE_ERRCODES = new Set([60011, 81013]);

function readJson(text, { code = IDENTITY_CODES.LOOKUP_FAILED } = {}) {
  try {
    return JSON.parse(text);
  } catch {
    throw new IdentityError("WeCom returned invalid JSON", { code });
  }
}

function extattrJobNumber(body) {
  const attrs = body?.extattr?.attrs;
  if (!Array.isArray(attrs)) return "";
  const match = attrs.find((item) => String(item?.name || "").trim() === "工号");
  const text = match?.text?.value ?? match?.value;
  return String(text || "").trim();
}

export class WecomClient {
  constructor({
    baseUrl = "https://qyapi.weixin.qq.com",
    resolveSecrets,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    tokenCacheMs = WECOM_TOKEN_CACHE_MS,
    corpId,
    corpSecret,
  }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.resolveSecrets = resolveSecrets;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.tokenCacheMs = tokenCacheMs;
    this.corpId = corpId || "";
    this.corpSecret = corpSecret || "";
    this.tokenCache = null;
  }

  rejectIfTokenError(body) {
    if (!TOKEN_ERRCODES.has(Number(body?.errcode))) return;
    this.tokenCache = null;
    throw new IdentityError("WeCom access token was rejected", { code: IDENTITY_CODES.TOKEN_FAILED });
  }

  async credentials() {
    if (this.corpId && this.corpSecret) return { corpId: this.corpId, corpSecret: this.corpSecret };
    const values = await this.resolveSecrets(["wecom/identity/corpid", "wecom/identity/secret"]);
    const corpId = values["wecom/identity/corpid"];
    const corpSecret = values["wecom/identity/secret"];
    if (!corpId || !corpSecret) {
      throw new IdentityError("WeCom identity credentials are not configured", { code: IDENTITY_CODES.NOT_CONFIGURED });
    }
    return { corpId, corpSecret };
  }

  async getToken() {
    if (this.tokenCache && this.tokenCache.expiresAt > this.now()) return this.tokenCache.token;
    const { corpId, corpSecret } = await this.credentials();
    const url = `${this.baseUrl}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
    let body;
    try {
      const response = await this.fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(20000) });
      body = readJson(await response.text(), { code: IDENTITY_CODES.TOKEN_FAILED });
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      throw new IdentityError("WeCom token request failed", { code: IDENTITY_CODES.TOKEN_FAILED });
    }
    if (Number(body?.errcode) !== 0 || typeof body?.access_token !== "string" || !body.access_token.trim()) {
      throw new IdentityError("WeCom token authentication was rejected", { code: IDENTITY_CODES.TOKEN_FAILED });
    }
    this.tokenCache = { token: body.access_token.trim(), expiresAt: this.now() + this.tokenCacheMs };
    return this.tokenCache.token;
  }

  async userGet(userid) {
    const token = await this.getToken();
    const url = `${this.baseUrl}/cgi-bin/user/get?access_token=${encodeURIComponent(token)}&userid=${encodeURIComponent(userid)}`;
    let body;
    try {
      const response = await this.fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(20000) });
      body = readJson(await response.text());
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      throw new IdentityError("WeCom user/get failed", { code: IDENTITY_CODES.LOOKUP_FAILED });
    }
    this.rejectIfTokenError(body);
    return body;
  }

  async openUseridToUserid(openUserid) {
    const token = await this.getToken();
    const url = `${this.baseUrl}/cgi-bin/batch/openuserid_to_userid?access_token=${encodeURIComponent(token)}`;
    let body;
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ open_userid_list: [openUserid] }),
        signal: AbortSignal.timeout(20000),
      });
      body = readJson(await response.text());
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      throw new IdentityError("WeCom openuserid conversion failed", { code: IDENTITY_CODES.LOOKUP_FAILED });
    }
    this.rejectIfTokenError(body);
    return body;
  }

  async lookupUserid(senderId) {
    const userBody = await this.userGet(senderId);
    if (Number(userBody?.errcode) === 0 && String(userBody?.userid || "").trim()) {
      return {
        userid: String(userBody.userid).trim(),
        extattrJobNumber: extattrJobNumber(userBody),
      };
    }
    if (OUT_OF_SCOPE_ERRCODES.has(Number(userBody?.errcode))) {
      throw new IdentityError("WeCom sender is outside the app visible range", { code: IDENTITY_CODES.OUT_OF_SCOPE });
    }

    const converted = await this.openUseridToUserid(senderId);
    if (Number(converted?.errcode) !== 0) {
      throw new IdentityError("WeCom openuserid conversion was rejected", { code: IDENTITY_CODES.OPENUSERID_INVALID });
    }
    const invalid = Array.isArray(converted.invalid_open_userid_list) ? converted.invalid_open_userid_list : [];
    if (invalid.length) {
      throw new IdentityError("WeCom openuserid could not be converted", { code: IDENTITY_CODES.OPENUSERID_INVALID });
    }
    const userid = String(converted.userid_list?.[0]?.userid || "").trim();
    if (!userid) {
      throw new IdentityError("WeCom conversion returned no userid", { code: IDENTITY_CODES.OPENUSERID_INVALID });
    }
    const detail = await this.userGet(userid);
    return {
      userid,
      extattrJobNumber: Number(detail?.errcode) === 0 ? extattrJobNumber(detail) : "",
    };
  }
}
