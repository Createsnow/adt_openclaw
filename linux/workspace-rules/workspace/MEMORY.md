# MEMORY

本文件只作索引，禁止写入凭据、原始 SenderId、`mappingCode`、`confirmationId` 或完整通讯录。

Agent **不要** `read` / `write` / `edit` 本文件或 `memory/ticket-ledger.md`，也不要调用 `memory_search` / `memory_get`。工单幂等由 `oa_workflow`（插件数据库）与本会话工具回执负责。

- 可选日记忆：`memory/YYYY-MM-DD.md`（群聊不要写入私人事实；热路径不要打开）
