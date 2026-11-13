import { constants, publicEncrypt } from "node:crypto";
import { redactPayload } from "./log-redact.mjs";

export class OAClientError extends Error {
  constructor(message, { code = "OA_ERROR", ambiguous = false, details = null } = {}) {
    super(message);
    this.name = "OAClientError";
    this.code = code;
    this.ambiguous = ambiguous;
    /** 失败回执要带的额外字段（如 ALREADY_PENDING 的 confirmationId / sameSession），由 safeError 合并。 */
    this.details = details;
  }
}

/** OA 凭据只从环境变量读：OA_API_USER_ID / OA_APP_SECRET（compose secret → entrypoint 注入）。 */
export function readOaCredentials(env = process.env) {
  return {
    apiUserId: String(env.OA_API_USER_ID || "").trim(),
    appSecret: String(env.OA_APP_SECRET || "").trim(),
  };
}

export function toPemPublicKey(spkiBase64) {
  const lines = String(spkiBase64).replace(/\s+/g, "").match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

export function encryptCredential(value, spkiBase64) {
  return publicEncrypt(
    { key: toPemPublicKey(spkiBase64), padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(String(value), "utf8"),
  ).toString("base64");
}

export function oaRequestPlaintextEnabled() {
  return process.env.OA_LOG_REQUEST_PLAINTEXT === "1";
}

function shouldLogPlaintext() {
  if (!oaRequestPlaintextEnabled()) return false;
  if (process.env.NODE_TEST_CONTEXT) return false;
  return true;
}

function logPlaintextRequest({ url, method, appId, useridPlain, body }) {
  if (!shouldLogPlaintext()) return;
  console.log(`[OA_REQUEST_PLAINTEXT] ${JSON.stringify({
    url,
    method,
    headers: {
      appid: appId,
      userid: useridPlain,
      token: "[redacted]",
    },
    body: body === undefined ? null : redactPayload(body),
  })}`);
}

async function readJsonResponse(response, ambiguousOnServerError = false) {
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new OAClientError("OA returned an invalid JSON response", {
      code: "INVALID_RESPONSE",
      ambiguous: ambiguousOnServerError && response.status >= 500,
    });
  }
  if (!response.ok) {
    throw new OAClientError("OA HTTP request failed", {
      code: `HTTP_${response.status}`,
      ambiguous: ambiguousOnServerError && response.status >= 500,
    });
  }
  return body;
}

const TOKEN_TTL_MS = 25 * 60 * 1000;
const sharedClients = new Map();

function sharedClientKey(config) {
  return `${config?.baseUrl || ""}|${config?.appId || ""}|${config?.publicKeySpkiBase64 || ""}`;
}

/** 测试隔离用。生产路径不要调。 */
export function resetSharedOAClients() {
  sharedClients.clear();
}

/**
 * 进程内复用 OAClient，让 applytoken 的 25 分钟缓存真正跨提交命中。
 * 每次 submit_confirmed 都 `new OAClient` 时 tokenCache 永远是空的。
 */
export function getSharedOAClient(opts) {
  const key = sharedClientKey(opts?.config);
  const existing = sharedClients.get(key);
  if (existing) {
    existing.config = opts.config;
    if (opts.credentials) existing.credentials = opts.credentials;
    return existing;
  }
  const client = new OAClient(opts);
  sharedClients.set(key, client);
  return client;
}

function logTokenTiming({ cached, elapsedMs }) {
  if (process.env.NODE_TEST_CONTEXT) return;
  console.log(`[oa-workflow-bridge] applytoken cached=${cached} elapsedMs=${elapsedMs}`);
}

export class OAClient {
  constructor({ config, credentials = readOaCredentials, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    this.config = config;
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.tokenCache = null;
    this.tokenInflight = null;
  }

  async getCoreCredentials() {
    const { apiUserId, appSecret } = await this.credentials();
    if (!apiUserId || !appSecret) {
      throw new OAClientError("OA credentials are not configured", { code: "NOT_CONFIGURED" });
    }
    if (!/^\d{1,18}$/.test(apiUserId)) {
      throw new OAClientError("OA API user ID is invalid", { code: "INVALID_CONFIGURATION" });
    }
    return { apiUserId, appSecret };
  }

  async getToken() {
    if (this.tokenCache && this.tokenCache.expiresAt > this.now()) {
      logTokenTiming({ cached: true, elapsedMs: 0 });
      return this.tokenCache.token;
    }
    if (!this.tokenInflight) {
      this.tokenInflight = this.fetchAndCacheToken().finally(() => {
        this.tokenInflight = null;
      });
    }
    return this.tokenInflight;
  }

  async fetchAndCacheToken() {
    const started = this.now();
    const { appSecret } = await this.getCoreCredentials();
    const encryptedSecret = encryptCredential(appSecret, this.config.publicKeySpkiBase64);
    let response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/api/ec/dev/auth/applytoken`, {
        method: "POST",
        headers: { appid: this.config.appId, secret: encryptedSecret },
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new OAClientError("OA token request failed", { code: "TOKEN_NETWORK_ERROR" });
    }
    const body = await readJsonResponse(response, false);
    if (body?.status !== true || String(body?.code) !== "0" || typeof body?.token !== "string" || !body.token.trim()) {
      throw new OAClientError("OA token authentication was rejected", { code: "TOKEN_REJECTED" });
    }
    const token = body.token.trim();
    this.tokenCache = { token, expiresAt: this.now() + TOKEN_TTL_MS };
    logTokenTiming({ cached: false, elapsedMs: this.now() - started });
    return token;
  }

  async authenticatedRequest(pathname, { method = "POST", body, ambiguousOnServerError = false, headerUserId } = {}) {
    const token = await this.getToken();
    const { apiUserId } = await this.getCoreCredentials();
    const rawUserId = headerUserId == null || headerUserId === "" ? apiUserId : String(headerUserId).trim();
    if (!/^\d{1,18}$/.test(rawUserId)) {
      throw new OAClientError("OA user ID is invalid", { code: "INVALID_CONFIGURATION" });
    }
    const encryptedUserId = encryptCredential(rawUserId, this.config.publicKeySpkiBase64);
    const headers = { token, appid: this.config.appId, userid: encryptedUserId };
    if (body !== undefined) headers["content-type"] = "application/json";
    const url = `${this.config.baseUrl}${pathname}`;
    logPlaintextRequest({
      url,
      method,
      appId: this.config.appId,
      useridPlain: rawUserId,
      body,
    });
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new OAClientError("OA request outcome is unknown", {
        code: "NETWORK_OUTCOME_UNKNOWN",
        ambiguous: ambiguousOnServerError,
      });
    }
    return readJsonResponse(response, ambiguousOnServerError);
  }

  async getCreateWorkflowList() {
    const result = await this.authenticatedRequest("/api/workflow/paService/getCreateWorkflowList", {
      body: { conditions: { wfIds: String(this.config.workflowId) } },
    });
    const rows = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
    return rows;
  }

  async createRequest(payload, { requesterUserId } = {}) {
    const headerUserId = String(requesterUserId || "").trim();
    if (!/^\d{1,18}$/.test(headerUserId)) {
      throw new OAClientError("OA requester user ID is invalid", { code: "INVALID_CONFIGURATION" });
    }
    const result = await this.authenticatedRequest("/api/workflow/paService/doCreateRequest", {
      body: payload,
      ambiguousOnServerError: true,
      headerUserId,
    });
    if (result?.code !== "SUCCESS") {
      const code = typeof result?.code === "string" ? result.code : "OA_CREATE_REJECTED";
      console.log(`[OA_CREATE_REJECTED] ${JSON.stringify(redactPayload({
        code,
        errMsg: result?.errMsg ?? result?.msg ?? result?.message ?? null,
      }))}`);
      throw new OAClientError("OA rejected the workflow request", {
        code,
        ambiguous: code === "SYSTEM_INNER_ERROR",
      });
    }
    const requestId = result?.data?.requestid ?? result?.data?.requestId ?? result?.data;
    if (!/^\d+$/.test(String(requestId ?? ""))) {
      throw new OAClientError("OA success response did not include requestid", {
        code: "MISSING_REQUEST_ID",
        ambiguous: true,
      });
    }
    return { requestId: String(requestId) };
  }
}
