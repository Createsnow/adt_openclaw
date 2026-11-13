/**
 * 本适配器只做企微侧取数：人事点查不带认证，建单凭据（OA_API_USER_ID / OA_APP_SECRET）
 * 仍由桥接自己的 secret-resolver 读，这里不要再加进来。
 */
export const IDENTITY_SECRET_REFS = Object.freeze({
  wecomCorpId: "wecom/identity/corpid",
  wecomSecret: "wecom/identity/secret",
});

function envValue(name) {
  return String(process.env[name] || "").trim();
}

export async function resolveIdentitySecrets(ids, overrides = {}) {
  const values = {};
  for (const id of ids) {
    if (overrides[id]) {
      values[id] = String(overrides[id]).trim();
      continue;
    }
    if (id === IDENTITY_SECRET_REFS.wecomCorpId) values[id] = envValue("WECOM_IDENTITY_CORPID");
    else if (id === IDENTITY_SECRET_REFS.wecomSecret) values[id] = envValue("WECOM_IDENTITY_SECRET");
  }
  return values;
}
