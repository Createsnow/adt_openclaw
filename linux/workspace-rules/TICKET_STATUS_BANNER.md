# 工单提交结果（人对照）

员工可见正文的编辑权威是 `xA企微回复模板.md`。运行时副本在已注入的 `AGENTS.md`「用户可见回复」。Agent **禁止**再 `read` 本文件。改一句必须同步那两处。

回显只抄工具回执：问题用 `summary`，地点用顶层 `location`，附件用 `imageCount` / `documentCount`。不要解析 `systemName`，不要写工单类型 / 所属系统，不要展示 `confirmationId`、`mappingCode`、内部 `IT-` 号。

## 回执 → 模板块

`code` 按大小写不敏感匹配。处理人取自 `ROUTING_RULES.md` / `AGENTS.md` 系统表；无唯一匹配则 `待人工确认`。

| 条件 | 用哪一块 |
| --- | --- |
| `SUBMITTED` 且含数字 `requestId`（无下一张） | `✅ **已提交到 OA**` |
| 同上，且本会话还有当前单要继续 | `✅ **上一张已交到 OA**` + `---` + 当前单确认卡或差必填短卡 |
| `CANCELLED` 且无在途当前单 | `🗑️ 好的，这张单已取消。` |
| `CANCELLED` 且本会话已有当前问题 | `🗑️ **上一张已取消**` + `---` + 当前单确认卡或差必填短卡 |
| `ALREADY_SUBMITTED` | 与「已提交到 OA」同一张 |
| `OA_BRIDGE_INACTIVE` | `ℹ️ **已确认，但还不能创建 OA 工单**` |
| `RECONCILIATION_REQUIRED` / `unknown` / `submitting` | `⚠️ **OA 需要人工核对**` |
| 身份未映射码 | `❌ **还不能提交到 OA**` 或回执 `hintZh` |
| 其它明确失败 | `❌ **确认准备失败**` 或回执 `hintZh` |
| `CONFIRMATION_EXPIRED` | 「⏳ 这张确认单已过期」或 `hintZh` |
| `AWAITING_CONFIRMATION`（本会话可补件） | `📋 **当前工单**` 确认卡 |
| 确认卡上「不用了」等 | 「请改口」+ 重发确认卡 |
| `ALREADY_PENDING` 且 `sameSession=false` | 拦截卡：`⚠️ **还有一张未提交的确认单**` |
| 差地点、尚未 `prepare` | `📝 已记下：…` + 园区 1–6 |
| 邮箱/文件未分国内·越南，或 MES 未分 B/C，或 IT 需求缺字段 | `xA企微回复模板.md` 4b–4d |
| 一次说了多个系统 | 「请先说这次主要是哪一个系统」 |
| 明显不是 IT | 「这类事情不在 IT 服务台范围内」 |
| 员工报 OA 工单号 | 「目前还不能按工单号查询处理进度。」 |
| 建单前附件过期 | 「⏳ 刚才的图片或文件已过期，请重新发送。」 |
| `attach` 得 `ATTACHED` / `BUFFERED` | 原样输出 `hintZh` |
| `NO_NEW_ATTACHMENT` 等 | 原样输出 `hintZh` |
| 问候 | `IDENTITY.md` 介绍，必须原样 |
| `PERSON_STATUS` 无 pending | 原样输出 `hintZh` |

身份未映射码：`OA_IDENTITY_NOT_FOUND` / `OA_IDENTITY_NOT_CONFIGURED` / `OA_IDENTITY_MAPPING_REQUIRED` / `WECOM_IDENTITY_TOKEN_FAILED` / `WECOM_IDENTITY_OUT_OF_SCOPE` / `WECOM_IDENTITY_ALIGN_MISMATCH` / `OA_IDENTITY_INACTIVE` / `WECOM_IDENTITY_INVALID_SENDER`。  
`OA_IDENTITY_LOOKUP_FAILED` / `OA_IDENTITY_AMBIGUOUS` / `WECOM_OPENUSERID_INVALID` / `OA_PROFILE_*` 走「确认准备失败」或回执 `hintZh`。
