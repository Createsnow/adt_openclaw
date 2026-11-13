# IT运维工单结构

运行时口径已写入 `AGENTS.md`。Agent **禁止**再 `read` 本文件。改工单号规则或 draft 约束时必须同步 `AGENTS.md`。

两层不要混：

1. **工作区映射规则**（`prepare` 之前）：定工单类型、所属系统。见 `MAPPING_RULES.md` / `ROUTING_RULES.md`。
2. **`oa_workflow` draft**：字段如下。成功口径见 `AGENTS.md`。

建议责任人只作员工可见「处理人」；模型不要传人员 id。插件按所属系统写入 OA `clry`。

## 工单编号

员工可见工单号 **只认** Ecology 数字 `requestId`。未 `SUBMITTED` 时不要编造工单号；`OA_BRIDGE_INACTIVE` 写 `待提交 OA`。

内部幂等号格式：`IT-YYYYMMDD-HHMMSS-XXXX`，**由插件生成**（`WeComReceivedAt` + `Asia/Bangkok` + `message_id` 短片段）。模型不要传 `externalTicketId`。同一 `message_id` 由插件得到同一内部号。该号只进 Redis ledger 与流程标题，不进员工可见正文、不进 `wtxqmskftp`。

## oa_workflow draft

`prepare` 只传这些业务字段（不要传 OA 字段名、人员 id、建议责任人、`externalTicketId`）：

| draft 字段 | 来源 | 约束 |
|---|---|---|
| `ticketType` | 工作区规则 + 对话 | 运维支持 / 权限申请 / IT需求 |
| `systemName` | 当前类型清单中的唯一命中 | 以 `AGENTS.md` 系统清单为准（与 `ROUTING_RULES.md` 同步）；插件拒绝非法组合 |
| `location` | 员工为本张工单选择的故障地点 | 可选。只允许 `智园` / `大磡` / `深汕` / `越南` / `光明` / `泗洪`。电脑/打印机/网络问题应传入；不传时插件从 `systemName` 括号兑底。不是 OA `bgdd`。确认卡只读回执 `location` |
| `summary` | 确认卡上的问题预览 | 员工原话开头。短的原样（`电脑死机`）；长的截到约 20 字加 `...`（`4 个厂区同时用一套系统接单号...`）。不要改写成另一句。不要写地点、提交口令或长文。插件上限 200 字是 OA 标题，不要用满 |
| `problemDescription` | 只抄员工说过的问题本身 | ≤6000 字。短句短抄；一次很长或断续多轮按顺序合并，不要丢掉细节。确认卡不要贴这一段。不要写故障地点（地点只用于匹配系统）。禁止「员工反馈」「现象描述」「待现场核实」「未说明」、诊断猜测、排查清单、常识推断、提交口令。不要在描述里抄工单号；插件也不会把工单号写入 OA 问题描述 |
| `impactScope` | 默认不传；员工没说则省略 | ≤200 字。禁止「员工未说明」；禁止把「电脑死机」扩写成「本人办公电脑无法正常使用」 |
| `occurredAt` | 默认不传；员工没说则省略 | ≤200 字。禁止「具体发生时间未说明」 |
| `attemptedMeasures` | 默认不传；员工没说则省略 | ≤1000 字。禁止「员工未说明已尝试的处理措施」 |
| `demandType` | 仅 IT需求 | 流程新建 / 流程优化 / 数据处理 / 集成对接 |
| `monthlyHours` | 仅 IT需求 | ≥0 的数字 |

确认前改稿必须 `cancel` 再 `prepare`。若已经 `SUBMITTED`，不得再自动补写该 OA 原单。

## 幂等

不要 `read` / `write` `memory/ticket-ledger.md`。权威是插件 Redis 与本会话 `oa_workflow` 回执。

- 本会话已有该条的 `confirmationId` 时调用 `status`，不要再 `prepare`。
- **同一人全局只允许一张待确认单**（跨 `/new` 仍拦住）。再 `prepare` 或跨会话 `attach` 是 `ALREADY_PENDING`：请先确认或取消，不要让员工回到上一会话。
- 同一内部幂等号 **仅当 pending 仍未过期**才 `ALREADY_PENDING`；pending 已过期或 `cancel` 得 `NOT_FOUND` 后允许重新 `prepare`。已提交会 `ALREADY_SUBMITTED`。
- 员工可见状态以 `oa_workflow` 回执为准，格式见已注入的 `AGENTS.md`「用户可见回复」（与 `Aidy企微回复模板.md` 同步；不要再 `read` `TICKET_STATUS_BANNER.md`）。确认轮不写工单类型 / 所属系统；问题、地点、附件抄回执。
