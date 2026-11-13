# wecom-oa-identity-adapter

Gateway 进程内的身份转换包，**不是**单独服务器，也**不**注册模型 tool。

`bridge-config.json` 的 `identity.adapter=on` 且 `identity.store=redis` 时由 `oa-workflow-bridge-redis` 注入。适配器已验证通过。

**`openclaw.json` 默认不写本包。** 不要加入 `plugins.allow` / `load.paths` / `tools.alsoAllow`。开关、可选登记、secrets 见 `../身份适配器说明.md` 第 10 节。宿主机有 `wecom_identity_*.txt` 不够，须 compose + entrypoint；漏了会 `OA_IDENTITY_NOT_CONFIGURED`（第 10.7 节）。

`resolve(senderId)`：加密 userid → 企微 `user/get`（回退 `openuserid_to_userid`）→ 工号 → `getHrmUserInfoWithPage` → Redis `idmap`。企微/人事 HTTP **不重试**；失败经 `oa_workflow` 回执给模型（说明第 8.1 节）。错误码见 `src/errors.mjs`。提交前部门 / 岗位 / 地点不是本包，见 `../../xA 现网加固与演进全景.md` 第 7 节。

全景见 `../../xA 现网加固与演进全景.md`。部署、凭据、错误码见 `../身份适配器说明.md`。测试：`npm test`。
