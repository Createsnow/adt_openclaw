# xA OA 工单流程契约

> 主路径是 `oa_workflow`。工具字段、回执、成功口径、当场提交与待确认口令见已注入的 `AGENTS.md`（含 `## Tools`）。员工可见正文见 `xA企微回复模板.md`。跨会话闸门见 `OA_tool/工单会话隔离与资料回收场景.md`。错误码见 OA Redis 手册 **7.5**。不要把智能表格当工单路径。

## Checklist

1. 规则在 `prepare` **之前**用完。不要再 `read` 任何规则 Markdown，也不要读写 `memory/ticket-ledger.md`。热路径只调 `oa_workflow`。
2. 唯一命中且事实足够后 `prepare`。员工原话已有确定提交口吻 → 同一轮立刻 `submit_confirmed`；否则发本会话确认卡。
3. 本会话：只发图片 / 文件走 `attach`（不 `cancel`、不重新 `prepare`）；文字改稿先 `cancel` 再 `prepare`；明确取消走 `cancel`。跨 `/new` 只能确认或取消旧单，不能补资料、不能开新单（`sameSession=false`）。
4. 只有回执 `SUBMITTED` + 数字 `requestId` 才是已创建 OA。`OA_BRIDGE_INACTIVE` 不是成功。`CONFIRMATION_EXPIRED` / `RECONCILIATION_REQUIRED` 不要自动重试。
5. 只接受通道可信 `requesterSenderId`。现网是加密串，不是工号；模型不要填人员 id、OA 字段名、流程 ID 或内部 `IT-` 号。
6. 附件由插件按提交人 + `sessionId` 暂存。inbox 默认 30 分钟；pending 默认 24 小时。图片进问题详情，文档走附件字段。
7. 同一提交人全局最多一张待确认（`person-pending`）。内部 `IT-` 号只作 Redis 幂等键，不展示给员工。
