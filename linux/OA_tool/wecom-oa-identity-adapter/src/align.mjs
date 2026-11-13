import { IDENTITY_CODES, IdentityError } from "./errors.mjs";

export function alignWorkcode({ userid, extattrJobNumber, mode = "userid_equals_workcode" }) {
  const plain = String(userid || "").trim();
  const ext = String(extattrJobNumber || "").trim();
  if (!plain) {
    throw new IdentityError("WeCom userid is empty", { code: IDENTITY_CODES.OPENUSERID_INVALID });
  }
  if (mode !== "userid_equals_workcode") {
    throw new IdentityError("Unsupported align mode", { code: IDENTITY_CODES.ALIGN_MISMATCH });
  }
  if (ext && ext !== plain) {
    throw new IdentityError("WeCom userid does not match job number attribute", { code: IDENTITY_CODES.ALIGN_MISMATCH });
  }
  return plain;
}
