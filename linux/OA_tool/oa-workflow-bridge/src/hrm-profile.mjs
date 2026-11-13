import { OAClientError } from "./oa-client.mjs";

function resourceId(value) {
  const text = String(value ?? "").trim();
  return /^\d{1,18}$/.test(text) ? text : "";
}

export function unwrapRecord(body) {
  if (!body || typeof body !== "object") return {};
  if (body.simpleInfo && typeof body.simpleInfo === "object" && !Array.isArray(body.simpleInfo)) {
    return body.simpleInfo;
  }
  if (body.data && typeof body.data === "object" && !Array.isArray(body.data)) {
    if (body.data.simpleInfo && typeof body.data.simpleInfo === "object" && !Array.isArray(body.data.simpleInfo)) {
      return body.data.simpleInfo;
    }
    return body.data;
  }
  return body;
}

export function assertProfileBody(body) {
  if (body && typeof body === "object" && body.status === false) {
    throw new OAClientError("OA profile request failed", { code: "OA_PROFILE_LOOKUP_FAILED" });
  }
}

export function extractProfile(body) {
  const record = unwrapRecord(body);
  return {
    departmentId: resourceId(record.departmentid ?? record.departmentId),
    jobTitleId: resourceId(record.jobtitle ?? record.jobtitleid ?? record.jobTitle),
    locationId: resourceId(record.locationid ?? record.locationId),
    recordId: resourceId(record.id),
  };
}

export function requireRequesterProfile(profile) {
  const departmentId = resourceId(profile?.departmentId);
  const jobTitleId = resourceId(profile?.jobTitleId);
  const locationId = resourceId(profile?.locationId);
  if (!departmentId || !jobTitleId || !locationId) {
    throw new OAClientError("OA requester profile is incomplete", { code: "OA_PROFILE_INCOMPLETE" });
  }
  return { departmentId, jobTitleId, locationId };
}

export function profileFromBody(body, expectedUserId) {
  assertProfileBody(body);
  const extracted = extractProfile(body);
  if (extracted.recordId && expectedUserId && extracted.recordId !== expectedUserId) {
    throw new OAClientError("OA profile request failed", { code: "OA_PROFILE_LOOKUP_FAILED" });
  }
  return requireRequesterProfile(extracted);
}

export async function lookupRequesterProfile({
  oaUserId,
  client,
} = {}) {
  const userId = resourceId(oaUserId);
  if (!userId) {
    throw new OAClientError("OA requester user ID is invalid", { code: "OA_PROFILE_INCOMPLETE" });
  }
  if (typeof client?.authenticatedRequest !== "function") {
    throw new OAClientError("OA profile lookup requires an authenticated client", { code: "OA_PROFILE_LOOKUP_FAILED" });
  }
  let body;
  try {
    body = await client.authenticatedRequest(
      `/api/hrm/simpleinfo/getHrmSimpleInfo?userid=${encodeURIComponent(userId)}`,
      { method: "GET", headerUserId: userId },
    );
  } catch (error) {
    if (error instanceof OAClientError) {
      if ([
        "NOT_CONFIGURED",
        "INVALID_CONFIGURATION",
        "TOKEN_REJECTED",
        "TOKEN_NETWORK_ERROR",
        "OA_PROFILE_INCOMPLETE",
        "OA_PROFILE_LOOKUP_FAILED",
      ].includes(error.code)) {
        throw error;
      }
    }
    throw new OAClientError("OA profile request failed", { code: "OA_PROFILE_LOOKUP_FAILED" });
  }
  return profileFromBody(body, userId);
}
