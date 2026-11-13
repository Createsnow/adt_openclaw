# 外部系统 Tool 插件设计规范

> 本文档由仓库根目录原文档**重组**而来：只保留通用插件形态原则；OA 字段、错误码、接入步骤以 OA 桥接手册为准，**不改变**任何安全约束或工具契约。阅读顺序见 [README.md](README.md)。

适用对象：需要在 OpenClaw Gateway 上以 **插件** 形式接入外部系统（当前以 OA 工单桥接为完整范例）的工程师。

本文说明 **插件应该长什么样**（固定 action、可信上下文、两阶段确认、凭据不进配置明文）。OA 工单桥接的实现与部署只维护 **Redis 版**：

| 项 | 值 |
| --- | --- |
| 插件 id / 目录 | `oa-workflow-bridge-redis` |
| 状态存储 | Redis（pending / ledger，单 Gateway 点查） |
| 部署文档 | `OA_tool/OA Workflow Bridge（Redis）接入手册.md` |
| Redis 服务 | `Redis 独立实例部署手册.md` |

`plugins.allow` 只写 `oa-workflow-bridge-redis`。不要再加载旧 id `oa-workflow-bridge`（本地 `state.json` 方案已废弃）。

---

## 1. 插件形式的核心原则

这些原则以 OA Redis 版为范例，也适用于以后接入的其它外部系统。

**插件 ≠ 工具。** 插件是 Gateway 加载的包；工具是模型可点名调用的函数。一个插件可以只登记通道、只登记工具、两者都登记，或不 `registerTool`。OA 桥接是「插件 + 唯一工具 `oa_workflow`」：`plugins.allow` 与 `tools.alsoAllow` **两层都要开**。企微插件是「一个包、两种能力」：去掉 `alsoAllow` 里的 `wecom_mcp` 只关智能表格，不关通道。两层开关的正文只在 `openclaw.json 配置参考.md` 第 5.5 节。

### 1.1 不是通用 HTTP 工具

禁止做成「模型传入 URL、Header、Body」的通用 HTTP 工具。提示注入可导致越权调用外部系统。模型只能调用插件声明的固定 **action**。OA 现网五个 action（`prepare` / `attach` / `submit_confirmed` / `status` / `cancel`）的详表、是否调 Ecology、失败码只在 [OA_tool/OA Workflow Bridge（Redis）接入手册.md](OA_tool/OA%20Workflow%20Bridge（Redis）接入手册.md) **§7** 维护。

### 1.2 模型不能传入或修改

- 外部系统域名、HTTP Header
- AppSecret、API 用户 ID、任意凭据、RSA 密文
- workflowId、OA 字段名
- 覆盖可信 `requesterSenderId`

工具 JSON Schema 使用 `additionalProperties: false`。提交前校验 `ctx.messageChannel === "wecom"` 且存在可信发送人与会话。

### 1.3 可信上下文

```text
messageChannel = wecom
requesterSenderId = 企微插件提供的可信发送人 ID（不可由模型伪造）
sessionKey 或 sessionId = 当前会话标识
```

群聊必须以 **实际发送人** 建单，不能用群 ID 代替人员身份。

### 1.4 两阶段确认

1. Agent 整理结构化 `draft` → `prepare`（不写外部系统）
2. 向员工发待确认正文：头行 `📋 **当前工单**`，回显问题、地点、附件件数；工单信息与 `---` 之间写补充引导句（无附件「内容不对或还缺信息，直接再写一句，或发图片、文档。」；有附件「还可以继续改文字，或再发图片、文档。」）。不要写「请确认后提交」，不要 24 小时，不要写成 `3. 补充`，不要问「是否还需要补充」，不要写工单类型 / 所属系统，不要状态卡。地点只抄回执 `location`。员工可见两句口令：`**请回复**` + `1. 确认提交` / `2. 取消`（问题 / 地点 / 附件下一行是补充引导句，再空行 `---`，到 `2. 取消` 结束；`---` 与 `**` 都不要省）。补充不必打「补充：」，直接发图片 / 文件或再写一句即可。附件回执按图片 / 文档分别报累计件数。
3. 原提交人回复后：
   - `确认提交`（或 `1` / `1.` / `1. 确认提交`）：`submit_confirmed` **只带** `confirmationId`，不要带 `supplement`
   - 确认前改稿：直接再写一句新事实即可（`补充：` 可选）；插件**不会**把 `supplement` 写入 pending 当改稿，必须 `cancel` 再 `prepare`
   - 只发图片 / 文件：`attach`，不必打「补充：」
   - `active=true` 时：员工若把「补充：…」当作确认提交口令发出，该次内容才作为 `supplement` 一次建单；规则包要求确认提交不带 supplement
   - 明确取消（或 `2` / `2.取消`）：`cancel`

不先建 OA 草稿，不调用 `submitRequest src=save`。创建成功后不再由机器人自动补写原单。

### 1.5 幂等与失败

| 场景 | 处理 |
| --- | --- |
| 同一外部工单号已 submitted | `ALREADY_SUBMITTED` |
| 已有 awaiting_confirmation | `ALREADY_PENDING`（同一人全局一张，跨会话也算） |
| 同一 confirmationId 并发 confirm | 同进程串行，最多调用一次外部系统 |
| 超过确认窗口 | `CONFIRMATION_EXPIRED`；pending 仍在，可 cancel |
| 本机附件暂存丢失 | `STAGING_MISSING`，不调 OA |
| 外部系统明确失败 | 修正后可重试 |
| 网络中断 / HTTP 5xx / 成功但无业务单号 | 标记 **`unknown`**，**禁止自动重试** |

`bridge-config.json` 里 `active=false` 时，`submit_confirmed` 返回 `OA_BRIDGE_INACTIVE`，不调 OA。

### 1.6 日志与凭据

禁止写入日志或状态：AppSecret、token、RSA 密文、原始 SenderId / 人员资源 ID 明文、附件 base64、完整工单正文。

不要把密钥写入 `openclaw.json` 明文。Docker 走 Compose secrets → entrypoint 环境变量；本插件 `secret-resolver.mjs` **只读** `OA_API_USER_ID` / `OA_APP_SECRET`，不回退 DPAPI、不读映射目录。身份映射权威是 Redis `idmap`。miss 路径是 **身份适配器**（独立包已验证，不注册模型 tool），不要做成「模型可调任意 URL」的通用 HTTP 工具；设计见 `OA_tool/身份适配器说明.md`。

---

## 2. 在 xA 中的位置（OA 范例）

全景见 [xA 现网加固与演进全景.md](xA%20现网加固与演进全景.md)。本节只画外部系统 Tool 插件应处的位置。

```text
企业微信员工
    ↓
wecom-openclaw-plugin（通道 + 可信身份 requesterSenderId）
    ↓
xA Agent（itservicedeskagent）
    ↓ 理解对话、整理 draft
oa-workflow-bridge-redis（工具 oa_workflow）
    ├── Redis          pending / ledger（按工单点查）
    ├── 本地 staging/  附件暂存
    ├── secrets        OA 凭据 + 企微自建应用转换凭据
    └── submit 锁外    getHrmSimpleInfo → doCreateRequest
    ↓
   Ecology OA（流程 602）
```

身份（`adapter=on` + Redis `idmap`，**已验证**）在通道与桥接之间注入独立身份适配器：`user/get`（回退 `openuserid_to_userid`）→ 对齐工号 → `getHrmUserInfoWithPage` → 写回 `idmap`。适配器是 Gateway 进程内包，不是单独服务器，**不是** 模型可调 tool，也不把企微 / **用工号点查** 塞进 `oa-client.mjs`。提交前部门 / 岗位 / 地点由桥接 `hrm-profile.mjs` 调 `getHrmSimpleInfo`。见 `OA_tool/身份适配器说明.md` 与 `xA 现网加固与演进全景.md` 第 7 节。

| 模型负责 | 插件负责 |
| --- | --- |
| 理解员工文字/图片 | 校验企微可信上下文；自动暂存 inbound 附件 |
| 生成 `draft` 结构化参数 | 字段映射、两阶段确认、幂等 |
| 展示汇总、引导确认 | 状态存储、OA 调用 |
| 输出中文状态卡 | 隐藏凭据、SenderId、附件 base64 |

**OA 写入必须是确定性的，不能交给模型直接调 HTTP。** 员工可见的「创建成功」必须基于插件返回的真实数字 `requestId`（OA HTTP 字段是 `data.requestid`，插件已转换）。

---

## 3. 工具契约、字段与接入（不在此重复维护）

工具名、action、参数、错误码、OA 字段映射、`system-options.json`、`plugins.allow` / compose 增量，一律以生产主路径为准：

**[OA_tool/OA Workflow Bridge（Redis）接入手册.md](OA_tool/OA Workflow Bridge（Redis）接入手册.md)** 第 5、7 节

Agent 侧：即使插件已 loaded，也必须把 `oa_workflow` 加入 `tools.alsoAllow` 才能调用。**现网已加入**（全局 + `itservicedeskagent`），不要加入 `wecom_mcp`。规则包按 `active=true` 执行；现网是否调用 `doCreateRequest` 看实际加载的 `bridge-config.json`。切流核对、两包 `redis` 依赖（现网已装齐）见 OA Redis 手册第 4.2 / 10 / 11 节。完整 json 见 `openclaw.json 配置参考.md` 第 15 节。

独立 Redis 与 `OA_REDIS_URL` 注入见 [Redis 独立实例部署手册.md](Redis 独立实例部署手册.md)。

---

## 4. 禁止事项

- 不要把 OA 密钥、API User ID、Redis 密码写入 `openclaw.json` 明文
- 不要做「模型可调任意外部 API」的通用工具
- 不要按姓名模糊匹配 OA 申请人
- 不要在 `active=false` 时改 AGENTS.md 声称 OA 已通
- 不要在 `active=false` 时用 `submit_confirmed` 的 `supplement` 存改稿；确认提交只传 `confirmationId`
- 不要在 `attachmentFieldName` 为空时带文档报成功。官方字段名已确认为 `scfj`。图片走 `wtxqmskftp`，不要把 png/jpg 写入 `scfj`
- 不要在 unknown 状态自动重试 submit
- 不要在 Docker 里执行 Windows DPAPI 脚本
- 不要把 `~/xa/secrets/` 提交到 git
- 不要把身份映射文件挂进 workspace 或 `.openclaw`
- 不要在 `plugins.allow` 中写旧 id `oa-workflow-bridge`
- 不要把企微转换或 **用工号点查人员 id** 注册为模型可调 tool；转换层走 `wecom-oa-identity-adapter`。提交前资料现查也不是模型 tool

---

## 5. 相关文档

| 文档 | 内容 |
| --- | --- |
| `xA 现网加固与演进全景.md` | OA 主路径、切入范围、各层 I/O |
| `OA_tool/OA Workflow Bridge（Redis）接入手册.md` | OA 桥接架构、Key、接入、工具 API（生产主路径） |
| `OA_tool/企微到OA身份与数据流.md` | 三种身份、Redis `idmap` |
| `OA_tool/身份适配器说明.md` | 转换层（独立包已验证） |
| `Redis 独立实例部署手册.md` | 独立 Redis、连接契约、备份轮换 |
| `OpenClaw Gateway WSL2-Docker 安装手册.md` | WSL2 + Docker Gateway 全链路 |
| `WeCom 通道插件接入手册.md` | 企微通道与 wecom_mcp |
| `OpenClaw Gateway Docker 运维手册.md` | 日常启停、备份、巡检 |
| `OA_tool/Ecology 流程创建 API 说明.md` 与本手册 | OA 接口与恢复顺序 |
| `openclaw/OA_WORKFLOW_CONTRACT.md` | OA 流程契约 |
| [OpenClaw Plugins](https://docs.openclaw.ai/plugins) | 官方插件机制 |
| [Ecology API 文档](https://e-cloudstore.com/ec/api/applist/index.html#/) | OA 接口参考 |
