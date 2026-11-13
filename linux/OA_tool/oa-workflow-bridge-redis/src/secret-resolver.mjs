/**
 * OA 凭据只从环境变量读取：OA_API_USER_ID / OA_APP_SECRET。
 * 身份映射走 Redis idmap，不读映射文件，不回退 DPAPI。
 */
export const OA_SECRET_REFS = Object.freeze({
  apiUserId: "oa/xa-it-service/api-user-id",
  appSecret: "oa/xa-it-service/app-secret",
});

function envValue(name) {
  const value = process.env[name]?.trim();
  return value || "";
}

export async function resolveProtectedValues(ids) {
  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  const values = {};
  for (const id of uniqueIds) {
    if (id === OA_SECRET_REFS.apiUserId) {
      const value = envValue("OA_API_USER_ID");
      if (value) values[id] = value;
    } else if (id === OA_SECRET_REFS.appSecret) {
      const value = envValue("OA_APP_SECRET");
      if (value) values[id] = value;
    }
  }
  return values;
}
