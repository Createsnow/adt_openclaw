# OA Workflow Bridge 接入手册

OA 桥接插件 `oa-workflow-bridge`（工具 `oa_workflow`）的唯一正文：存储、状态机、工具契约、错误码、预检、排错。部署步骤在[安装手册](../OpenClaw%20Gateway%20Linux%20服务器安装手册.md)，OA 接口在 [Ecology 流程创建 API 说明.md](Ecology%20流程创建%20API%20说明.md)，身份在 [企微到OA身份.md](企微到OA身份.md)。

| 项 | 现状 |
| --- | --- |
| 代码 | `OA_tool/oa-workflow-bridge/`，打进镜像 `/opt/xa/oa-workflow-bridge` |
| 状态 | 独立 MySQL：`oa_ticket` / `oa_inbox` / `oa_identity` |
| 身份转换 | 插件内 `src/identity/`，不注册工具 |
| 锁 | 进程内队列（`withStateLock`）+ 库层唯一约束兜底「同一人一张待确认」 |
| 附件 | 本机 staging，字节不进库、不进模型 |
| 建单开关 | `bridge-config.json` 的 `active`；流转开关 `isnextflow`（现网 `"0"`） |
| 依赖 | `mysql2`、`jpeg-js`、`pngjs` |

只能单 Gateway：锁是进程内的，附件在本机盘，两个 Gateway 连同一个库会双写 OA。

## 1. 架构

```text
员工企微 ──► wecom 通道（加密 userid，附件落盘 media/inbound）
               ▼
         xA Agent（只调 oa_workflow）
               │ prepare / attach / submit_confirmed / status / cancel
               ▼
         oa-workflow-bridge
           ├── src/identity/   企微 user/get → 工号 → getHrmUserInfoWithPage → OA 人员 id
           ├── MySQL           oa_ticket / oa_inbox / oa_identity
           ├── 本机 staging     {OPENCLAW_STATE_DIR}/oa-workflow-bridge/staging/
           └── Ecology         applytoken → getHrmSimpleInfo → doCreateRequest（流程 602）
```

模型只整理文字（类型、系统、描述）；身份、确认态、幂等、附件、处理人、建单都由插件做。员工可见「已建单」只认 `SUBMITTED` + 数字 `requestId`。

| 文件 | 职责 |
| --- | --- |
| `index.mjs` | 插件入口：连库建表、注册工具、hook 收附件、`/new` / `session_end` 清 inbox、每 10 分钟到期回收 |
| `src/tool.mjs` | 工具 schema、分发、错误码归一；每个回执补 `replyZh` |
| `src/actions/*.mjs` | 五个 action，各一个文件；`common.mjs` 放共用的判定与回执字段 |
| `src/reply.mjs` | 员工可见卡片（确认卡、成功卡、另一对话的待确认单、人工核对、取消……） |
| `src/inbox.mjs` | 附件一出现就落进 inbox（拷进 staging + 入库）、搬进工单 |
| `src/store.mjs` | 三张表的读写、进程锁、staging 路径、到期回收 |
| `src/db.mjs` | MySQL 连接池、建表语句、只读表检查 |
| `src/config.mjs` | `bridge-config.json`、`systems.json` 加载与校验 |
| `src/mapping.mjs` | draft 校验（未命中兜底、问题预览、A–F 地点）、内部幂等号、OA 请求体 |
| `src/oa-client.mjs` / `src/hrm-profile.mjs` | Ecology token、建单、提交前资料现查 |
| `src/identity/` | 企微与人事点查、`oa_identity` 缓存 |
| `src/inbound-media.mjs` / `src/attachments.mjs` / `src/image-embed.mjs` | 找出 inbound 路径、落盘 / 搬运附件、图片压缩 / 文档 base64 |
| `src/hints.mjs` | 没有专门卡片时的员工短句（`hintZh`，也作 `replyZh` 兜底） |
| `systems.json` | 所属系统 → OA 选项 ID、处理人 id、处理人姓名、允许的工单类型（唯一维护处） |
| `scripts/` | `readonly-preflight.mjs` 只读预检、`stats.mjs` 使用统计、`reconcile.mjs` 与 OA 对账、`manual-resolve.mjs` 身份排查 |

## 2. 数据存储

### 2.1 三张表

| 表 | 一行是什么 | 主要列 | 回收 |
| --- | --- | --- | --- |
| `oa_ticket` | 一张确认单 | `confirmation_id`（PK）、`external_ticket_id`、`sender_code`、`session_code`、`status`、`active_sender`（唯一）、`draft_json`、`staged_json`、`request_id`、`error_code`、`expires_at` | 不删。终态时清空 `draft_json` / `staged_json`，只留台账 |
| `oa_inbox` | 一个人收到但还没进工单的附件 | `sender_code`（PK）、`session_codes`、`state_json`（附件、去重键、超限计数、过期提示）、`expires_at` | 30 分钟不动即过期（下一次回执提示员工，一天后定时删）；`/new`、`session_end`、换对话时立刻删 |
| `oa_identity` | 发送人 → OA 人员 id 缓存 | `mapping_code`（PK）、`oa_user_id`、`miss_code`、`expires_at` | 命中 24 小时；查不到的负缓存 10 分钟 |

- `sender_code` / `mapping_code` = SHA-256(企微加密 SenderId 转小写) 截前 24 位；`session_code` 同理来自 OpenClaw `sessionId`（无则 `sessionKey`）。原始 SenderId、明文 userid、工号**不落库**。
- 时间都是毫秒 BIGINT，不依赖 MySQL 时区。JSON 存 TEXT，由插件序列化。
- 建表语句在 `src/db.mjs`。插件启动时 `CREATE TABLE IF NOT EXISTS`，库本身由 DBA 先建（见安装手册第 3 节）。

### 2.2 工单状态

```text
prepare ──► awaiting_confirmation ──submit──► submitting ──OA 成功──► submitted
                 │  （此人再 prepare：旧单记 cancelled，由新单替换）
                 │    ▲                           │
                 │    └── 资料 / 附件没备齐（未调 OA）┘
                 │                                ├── OA 明确拒绝 ──► failed
                 │                                └── 结果不明 ──────► unknown（人工对账）
                 ├── cancel ──► cancelled
                 └── 满 24 小时 ──► expired
```

- 占「同一人全局一张待确认」名额的状态：`awaiting_confirmation`、`submitting`、`unknown`。此时 `active_sender = sender_code`，唯一索引在库层面保证一人一张；其余状态 `active_sender = NULL`。
- 进入 `submitted` / `cancelled` / `expired` / `failed` 时清空描述与附件清单（员工资料随之删除），保留单号、状态、时间供对账。
- 同一内部幂等号（`external_ticket_id`）可能有多行：取消 / 过期后同一条消息可再 prepare。幂等判断看最新一行：`submitted` → `ALREADY_SUBMITTED`；`submitting` / `unknown` → `RECONCILIATION_REQUIRED`；仍有效的待确认 → 由新单替换。

### 2.3 到期回收

过期判定只看 `expires_at`。回收有两处，结果一样：

1. 任一工具调用碰到已到期的单，当场记 `expired`、删该会话 inbox 与本单 staging。
2. `index.mjs` 每 10 分钟（工具调用后也顺带，最多每分钟一次）跑 `cleanupExpired`：到期待确认单记 `expired`；删过期 `oa_inbox` / `oa_identity` 行；回收孤儿 staging 目录（刚建 10 分钟内的目录先放过，避免误删并发 prepare 的半成品）。

`submitting` / `unknown` 的单不在定时回收里过期，留给人工对账。

### 2.4 并发

`src/store.mjs` 的 `withStateLock` 是进程内 Promise 队列（可重入）。收附件、prepare（替换旧单、认领 inbox、写工单）、attach、cancel、过期回收都在锁内，互相不会吞附件。`submit_confirmed` 在锁内标 `submitting` 并登记进行中；并发的第二次确认等第一次结果，回 `ALREADY_SUBMITTED`，不会二次调 OA。附件编码与 OA HTTP 在锁外。

### 2.5 附件

- **一出现就落库**：hook（`message_received` / `agent_turn_prepare` / `before_prompt_build`）或工具 ctx 一看到 inbound 路径，就把文件拷进此人的 inbox（`staging/inbox-{sender}/`）并写 `oa_inbox`。不在进程内缓冲，Gateway 重启不丢。
- **去重**：同一对话里按去重键只收一次（通道原件与 OpenClaw `openclaw-staged/input-` 副本、多个 hook 重复上报、字节相同的不同 uuid 副本都算一份）。去重键在附件搬进工单后仍保留。
- **归属**：attach / prepare / 同一对话里的确认会把 inbox 整批搬进工单目录（`staging/{confirmationId}/`）。
- **对话隔离**：同一人换了对话（`/new`、群聊空闲新会话）就清掉旧 inbox。判断规则：两边都有 sessionId 时只认 sessionId；hook 只有 sessionKey 时才用 sessionKey 对。单聊 hook 没带发送人时，从 `…:wecom:direct:<发送人>` 取（发送人码按小写算）；群聊取不到发送人就不收。
- **上限**：单件 10 MB、合计 25 MB、最多 10 个。收件时超限的不收，下一次回执报 `ATTACHMENT_LIMIT_EXCEEDED`；搬进工单会超限时这批丢弃并报超限，工单不变。
- 源文件必须在 `{stateDir}/media/inbound/` 或 `{stateDir}/workspace/media/inbound/`（`realpath` 校验）。插件不扫描目录。
- 提交时图片压缩成 JPEG 嵌进 `wtxqmskftp`，文档转 `base64:` 写 `scfj`。base64 不进库、不进模型。
- `message_received` 需要 `oa-workflow-bridge` 与 `wecom-openclaw-plugin` 都设 `hooks.allowConversationAccess: true`。

Docker 必须设 `OPENCLAW_STATE_DIR=/home/node/.openclaw`，否则 staging 不在挂载卷上。

### 2.6 对话隔离与资料回收（验收口径）

| 场景 | 结果 |
| --- | --- |
| 同一对话里再写新事实 | 改稿：新单替换旧单，旧单附件带到新单，回执开头「📝 已补充描述」 |
| 另一个对话（`/new` 后、私聊 ↔ 群聊）里报新问题 | 作废上一张、按新问题建单，上一张附件随之清除，回执开头「🗑️ **上一张已取消**（…）」 |
| 另一个对话里问进度 / 回含糊话 | 显示上一张（「在另一个对话里建的」），可确认或取消；在这里发的图不补到上一张 |
| 另一个对话里确认上一张 | 只交上一张已有的附件；这里发的图留在本对话 inbox，给下一张 |
| 明确取消 | 删该单附件与同一对话里还没进单的附件；下一句要重新说问题 |
| 待确认满 24 小时 | 记 `expired`，删描述、附件清单与 staging；员工须重新说明 |
| 建单前附件 30 分钟没动 | 清掉，下一次回执提示「⏳ 刚才的图片或文件已过期，请重新发送。」 |
| 提交中 / 待对账的单 | 挡住新单（回「OA 需要人工核对」），不会被替换 |
| 群聊里多人 | 每人各自的单和附件，互不串 |

插件不删会话记录与通道 inbound 原件；inbound 原件由宿主机 cron 满 24 小时清理（运维手册第 7 节）。

## 3. 系统清单 `systems.json`

一处维护：所属系统 → OA 下拉选项 ID（`wtlx` / `szxt` / `szxtxq`）、处理人 `clry`（多人逗号分隔）、允许的工单类型。

```json
"OA系统": { "optionId": 2, "handlers": "4280,8134", "types": ["运维支持", "权限申请", "IT需求"] }
```

- 改系统名或处理人：改 `systems.json`，同步 `workspace/AGENTS.md`「系统 → 建议责任人」表；`npm test` 的 `workspace-sync.test.mjs` 会校验两边系统清单一致。
- 选项 ID、处理人 id 来自 OA 侧，**不要**自行编造。
- 改完重启 Gateway 不是必须（文件按修改时间重读），但 AGENTS.md 改了要重启并 `/new`。

### 3.1 未命中兜底

AGENTS.md 规则零条命中、但确实是 IT 方面的事时，模型不传 `ticketType` / `systemName`，插件确定性地兜底：

| 模型传了 | 插件按 |
| --- | --- |
| 都不传 | 运维支持 / 其他（处理人按「其他」行） |
| 只传 `ticketType` | 该类型 / 其他 |
| 都传 | 原样校验；非法组合仍 `SYSTEM_NOT_ALLOWED` |

缺地点（电脑类园区 A–F、邮箱 / 文件国内越南、MES 厂区）、一次说了多个系统、明显不是 IT 的事，仍由 AGENTS.md 规则先问清，不走兜底。

## 4. 配置

`~/xa/oa-bridge-config.json`，compose 只读挂到 `/opt/xa/oa-workflow-bridge/bridge-config.json`，改了 `down && up`，不必重建镜像。样例 `bridge-config.example.json`。

| 字段 | 说明 |
| --- | --- |
| `active` | `false` 时确认回 `OA_BRIDGE_INACTIVE`，不调 OA，待确认单不动 |
| `baseUrl` / `appId` / `publicKeySpkiBase64` / `workflowId` | OA 地址、应用、RSA 公钥、流程 602 |
| `isnextflow` | 只认字符串 `"0"` / `"1"`。`"0"` 停在申请人节点；正式启用改 `"1"` |
| `attachmentFieldName` | 文档附件字段 `scfj` |
| `pendingTtlHours` / `inboxTtlMinutes` | 待确认 24 小时；未进单附件 30 分钟 |
| `maxAttachmentBytes` / `maxTotalAttachmentBytes` | 单件 10MB / 合计 25MB |
| `mysql.host/port/user/database` | 非机密连接参数；密码走 `OA_MYSQL_PASSWORD` |
| `identity.adapter` | `on` 自动查 OA 人员 id；`off` 时 `prepare` 回 `OA_IDENTITY_MAPPING_REQUIRED` |

插件读的环境变量：`OA_MYSQL_PASSWORD`、`OA_API_USER_ID`、`OA_APP_SECRET`、`WECOM_IDENTITY_CORPID`、`WECOM_IDENTITY_SECRET`、`OPENCLAW_STATE_DIR`。`openclaw.json` 侧：`plugins.allow` 与 `entries` 只用 id `oa-workflow-bridge`（旧 id `oa-workflow-bridge-redis`、`wecom-oa-identity-adapter` 删干净），`load.paths` 为 `/opt/xa/oa-workflow-bridge`，两处 `alsoAllow` 含 `oa_workflow`。

改插件代码、`systems.json`、`package.json` 都要重建镜像；升级 OpenClaw 改 Dockerfile 的底座版本。加载成功的日志是 `[oa-workflow-bridge] loaded (MySQL state)`。

## 5. 身份

| 身份 | 来源 | 用途 |
| --- | --- | --- |
| 企微加密 SenderId | 通道 `requesterSenderId` | 只取哈希作 `sender_code` / `mapping_code` |
| 申请人 OA 人员 id | `oa_identity` 缓存；miss 时 `user/get`（失败回退 `openuserid_to_userid`）→ 明文 userid 即工号 → `getHrmUserInfoWithPage` | 建单 Header `userid`（RSA 加密）与表单 `xqsqr` |
| 接口账号 `OA_API_USER_ID` | secret | 只用于换 token 与只读预检 |

命中缓存 0 次外部 HTTP。企微 / 人事 HTTP 不重试；`NOT_CONFIGURED` / `TOKEN_FAILED` 不写负缓存，其它失败码写 10 分钟负缓存。身份失败时不写工单。错误码与排查见 [企微到OA身份.md](企微到OA身份.md)。手工排查：

```bash
docker exec -it xa-gateway node /opt/xa/oa-workflow-bridge/scripts/manual-resolve.mjs <open_userid>
```

（默认不读写缓存；`--write-cache` 才写 `oa_identity`。）

## 6. `oa_workflow` 工具 API

Schema `additionalProperties: false`。可信上下文必须是：`messageChannel = wecom`、有 `requesterSenderId`、有 `sessionKey` 或 `sessionId`。群聊按实际发送人建单。

**每个回执都有 `replyZh`：员工看到的整段回复，由插件拼好，模型原样转发。** 有专门卡片的（确认卡、成功卡、人工核对、取消、另一对话的待确认单……）由 `src/reply.mjs` 生成；其余用 `hintZh` 兜底。AGENTS.md 只保留没调工具时的追问短句。

| action | 写库 | 调 OA |
| --- | --- | --- |
| `prepare` | 插入一行 `awaiting_confirmation`；替换此人原有待确认单；认领 inbox | 不调建单（`submitNow` 时紧接着走 `submit_confirmed`）；身份 miss 时查企微 / 人事 |
| `attach` | 当前对话有待确认单：并入该单；否则留在 inbox | 否 |
| `submit_confirmed` | `active=false` 不写；否则标 `submitting`，结果写 `submitted` / `failed` / `unknown` | `getHrmSimpleInfo` → `doCreateRequest` |
| `status` | 只在发现到期单时记 `expired` | 否 |
| `cancel` | 记 `cancelled`，删附件 | 否 |

### 6.1 `prepare`

`draft` 必填 `problemDescription`（≤6000，只抄员工文字）。问题预览由插件截取（全文 ≤20 字原样，否则到第一个句读或硬截 20 字加「...」），模型不传。`ticketType` / `systemName` 命中才传，未命中按 3.1 兜底。电脑类传 `location`：园区名或员工回的字母 `A`–`F`（A 智园、B 大磡、C 深汕、D 越南、E 光明、F 泗洪）。IT 需求另要 `demandType`、`monthlyHours`。可选 `impactScope` / `occurredAt` / `attemptedMeasures`。内部幂等号 `IT-YYYYMMDD-HHMMSS-XXXX` 由插件按 `WeComReceivedAt`（Asia/Bangkok）+ `message_id` 生成。

- 此人已有待确认单：作废并替换（见 2.6）。同一条消息重复 prepare 静默替换。提交中 / 待对账的单挡住新单（`RECONCILIATION_REQUIRED`）。
- `submitNow: true`：员工原话已要求直接提交时，建单后立刻提交，回执就是提交结果。

成功：`AWAITING_CONFIRMATION` + `confirmationId` + `expiresAt` + `retentionHours` + `location` + `replacedPrevious` + `summary.{problemSummary, ticketType, systemName, location, attachmentCount, imageCount, documentCount}` + `replyZh`（确认卡）。

### 6.2 `attach`

不换 `confirmationId`、不改状态。当前对话有待确认单：并入该单 → `ATTACHED`（`replyZh` = 收件回执 + 确认卡）。否则留在 inbox → `BUFFERED`（`replyZh` = 收件回执，模型再追问缺的信息），包括另一个对话里还留着旧单时。没有新文件 → `NO_NEW_ATTACHMENT`；建单前附件已过期 → `replyZh` 提示过期。计数按文件名估，最终图片 / 文档分流以提交回执为准。

### 6.3 `submit_confirmed`

只认原发送人（不要求原对话）。同一对话里确认时随消息发来的新图会并入；另一个对话里确认只交旧单已有的附件。可选 `supplement`（≤2000，只在 `active=true` 时写进描述）。

| OA 侧结果 | 状态 | 回执 |
| --- | --- | --- |
| 数字 `requestid` | `submitted`，删 staging | `SUBMITTED` + `requestId`；`replyZh` 成功卡（问题 / 地点 / 附件 / 工单号 / 处理人） |
| 资料 / 附件没备齐（`OA_PROFILE_*`、`STAGING_MISSING`），未调建单 | 退回 `awaiting_confirmation` | 对应错误码，可再确认或取消 |
| 明确拒绝（`PARAM_ERROR`、`HTTP_4xx` 等） | `failed`（记 `error_code`），删 staging | 原码；禁止自动再提交，可让员工重报 |
| 结果不明（网络中断、`HTTP_5xx`、`SYSTEM_INNER_ERROR`、无 requestid） | `unknown` | 原码；禁止自动重试 |
| OA 已建单但写库失败 | `unknown`（带 `request_id`） | `RECONCILIATION_REQUIRED` + `requestId`；`replyZh` 人工核对卡 |
| `active=false` | 不变 | `OA_BRIDGE_INACTIVE`；`replyZh`「已确认，但还不能创建 OA 工单」 |

请求体：Header `userid` = RSA(申请人人员 id)；表单 `xqsqr`、`xqsqbm` / `gw` / `bgdd`（提交前 `getHrmSimpleInfo` 现查）、`sqlx`、系统字段、`wtxqmskftp`、`clry`（`systems.json`）、IT 需求 `xqlx1` / `yjygsh`、有文档才写 `scfj`。`otherParams`：`isnextflow` 取配置，`delReqFlowFaild=1`、`isVerifyPer=1` 写死。流程标题 `[{externalTicketId}] {问题预览}`（≤120）。token 进程内缓存约 25 分钟。

### 6.4 `status` / `cancel`

`status` 不带 `confirmationId`：有待确认单 → `PERSON_STATUS`（当前对话：「🔍 你有一张未提交的确认单」+ 确认卡；另一个对话：显示上一张并说明可确认 / 取消 / 直接报新问题），对账中 → `RECONCILIATION_REQUIRED`；没有 → 已提交条数与最近 5 条单号。`context`：

| context | 什么时候 | replyZh |
| --- | --- | --- |
| `unclear_reply` | 确认卡上回了「好的 / 不用了」等 | 请改口 + 确认卡 |
| `asked_oa_number` | 员工报了 OA 单号问进度 | 「目前还不能按工单号查询处理进度。」+ 记录 |

带 `confirmationId`（别人的单视为 `NOT_FOUND`）：待确认 → `AWAITING_CONFIRMATION`；到期 → `CONFIRMATION_EXPIRED`；提交中 / 待对账 → `RECONCILIATION_REQUIRED`；`submitted` → `ALREADY_SUBMITTED`；`cancelled` → `CANCELLED`；`failed` → `OA_CREATE_REJECTED`。

`cancel`：原发送人、跨对话也可。已到期 → `CONFIRMATION_EXPIRED`（记 `expired`）；提交中 / 待对账 → `RECONCILIATION_REQUIRED`。成功 `CANCELLED`。

### 6.5 错误码与 `hintZh`

没有专门卡片时 `replyZh` = `hintZh`（`src/hints.mjs`）。`HTTP_5xx` 归人工核对，其它 `HTTP_*` 归 OA 拒绝。

| 员工侧 | `code` |
| --- | --- |
| 还不能提交到 OA（账号未开通） | `OA_IDENTITY_NOT_FOUND` / `OA_IDENTITY_NOT_CONFIGURED` / `OA_IDENTITY_MAPPING_REQUIRED` / `OA_IDENTITY_INACTIVE` / `WECOM_IDENTITY_TOKEN_FAILED` / `WECOM_IDENTITY_OUT_OF_SCOPE` / `WECOM_IDENTITY_ALIGN_MISMATCH` / `WECOM_IDENTITY_INVALID_SENDER` |
| 确认准备失败，请稍后重试 | `OA_IDENTITY_LOOKUP_FAILED` / `OA_IDENTITY_AMBIGUOUS` / `WECOM_OPENUSERID_INVALID` / `OA_PROFILE_INCOMPLETE` / `OA_PROFILE_LOOKUP_FAILED` / `VALIDATION_ERROR` / `NOT_CONFIGURED` / `INVALID_CONFIGURATION` / `TOKEN_NETWORK_ERROR` / `TOKEN_REJECTED` / `UNTRUSTED_CONTEXT` / `DB_UNAVAILABLE` / `DB_SCHEMA_MISSING` / `WORKFLOW_NOT_CREATEABLE` / `PREFLIGHT_FAILED` |
| OA 拒绝了这张单，不要自动再提交 | `PARAM_ERROR` / `OA_CREATE_REJECTED` / `OA_ERROR` / `FAILED` / `HTTP_4xx` |
| OA 需要人工核对 | `RECONCILIATION_REQUIRED` / `NETWORK_OUTCOME_UNKNOWN` / `SYSTEM_INNER_ERROR` / `MISSING_REQUEST_ID` / `INVALID_RESPONSE` / `UNKNOWN` / `SUBMITTING` / `HTTP_5xx` |
| 确认单已过期 | `CONFIRMATION_EXPIRED` |
| 这张单已经提交过（带工单号） | `ALREADY_SUBMITTED` |
| 底稿问题，让模型改了再试 | `DRAFT_INVALID` / `INVALID_TICKET_TYPE` / `SYSTEM_NOT_ALLOWED` / `SYSTEM_UNMAPPED` / `INVALID_LOCATION` / `LOCATION_MISMATCH` / `INVALID_DEMAND_TYPE` / `INVALID_MONTHLY_HOURS` / `SUPPLEMENT_TOO_LONG` |
| 配置缺失，联系管理员 | `HANDLER_NOT_CONFIGURED` / `ATTACHMENT_FIELD_NOT_CONFIGURED` |
| 其它 | `MISSING_CONFIRMATION_ID`、`STAGING_MISSING`、`SENDER_MISMATCH`、`NOT_FOUND`、`NO_NEW_ATTACHMENT`、`ATTACHMENT_LIMIT_EXCEEDED` |

`DB_UNAVAILABLE`：运行时连不上库或库报错；`DB_SCHEMA_MISSING`：预检发现表不在。

## 7. 测试、预检、统计

### 7.1 单元测试

```bash
cd OA_tool/oa-workflow-bridge && npm install && npm test
```

覆盖：字段映射与兜底、OA 客户端、资料现查、身份转换与缓存、五个 action（确认 / 幂等 / 并发提交 / 跨会话 / 附件追加与 inbox / 过期 / 对账态）、到期回收与孤儿目录、库层唯一约束、预检、日志脱敏、`AGENTS.md` ↔ `systems.json` 一致性。

真实 MySQL 集成测试默认跳过，指向**测试库**时才跑（会清空三张表）：

```bash
OA_MYSQL_TEST_HOST=<测试库主机> OA_MYSQL_TEST_USER=xa_oa OA_MYSQL_TEST_DATABASE=xa_oa_test OA_MYSQL_PASSWORD=<密码> npm test
```

### 7.2 只读预检

Gateway 起来、secret 已注入后：

```bash
docker exec -it xa-gateway sh -c 'export OA_MYSQL_PASSWORD="$(tr -d "\n" < /run/secrets/oa_mysql_password)" OA_API_USER_ID="$(tr -d "\n" < /run/secrets/oa_api_user_id)" OA_APP_SECRET="$(tr -d "\n" < /run/secrets/oa_app_secret)"; node /opt/xa/oa-workflow-bridge/scripts/readonly-preflight.mjs'
```

先连库并检查三张表（不建表、不写数据），再调 `getCreateWorkflowList`（不建单）。

| 结果 | 退出码 |
| --- | --- |
| `{"ok":true,"code":"READ_ONLY_PREFLIGHT_PASSED","workflowId":602,"db":"OK",…}` | 0 |
| `DB_UNAVAILABLE`（连不上 / 密码错 / 无权限，未调 OA） | 1 |
| `DB_SCHEMA_MISSING`（表还没建：Gateway 至少启动成功过一次才会建） | 1 |
| `WORKFLOW_NOT_CREATEABLE`（库通，流程 602 对接口账号不可创建） | 2 |
| `PREFLIGHT_FAILED` / OA 客户端码（如 `NOT_CONFIGURED`） | 1 |

### 7.3 使用统计与 OA 对账

只读脚本，在 Gateway 容器里跑（需要 `OA_MYSQL_PASSWORD`，取法同 7.2）：

```bash
docker exec -it xa-gateway sh -c 'export OA_MYSQL_PASSWORD="$(tr -d "\n" < /run/secrets/oa_mysql_password)"; node /opt/xa/oa-workflow-bridge/scripts/stats.mjs --days 30'
```

输出 JSON：各状态单数、使用人数、成功提交过的人数、每日建单 / 提交、各所属系统待确认数、待对账数。不含员工身份。

与 OA 逐号对账（复盘「台账对账」项）：先从 OA 导出同期流程 602 的单号清单（CSV / 文本，每行含数字单号），拷进容器后：

```bash
docker exec -it xa-gateway sh -c 'export OA_MYSQL_PASSWORD="$(tr -d "\n" < /run/secrets/oa_mysql_password)"; node /opt/xa/oa-workflow-bridge/scripts/reconcile.mjs --oa /tmp/oa-export.csv'
```

输出小A成功提交数、在 OA 里找到的数、`missingInOa`（小A记成功但 OA 清单没有）与 `notMarkedSubmitted`（有 OA 单号但小A记成待对账等）。不带 `--oa` 则导出小A成功单号 CSV。

`unknown` 的对账步骤见运维手册第 10 节。

## 8. 排错

| 现象 | 处理 |
| --- | --- |
| `Cannot find module 'jpeg-js'` / `Cannot find package 'mysql2'` | 用的不是安装手册第 5 节构建的镜像（compose `image:` 应为 `xa-gateway-oa:…`），或 `load.paths` 仍指向 `~/xa/extensions` 下的旧目录 |
| `MySQL init failed: ENOENT … bridge-config.json` | compose 没挂 `./oa-bridge-config.json` |
| `MySQL init failed: OA_MYSQL_PASSWORD is not configured` | compose 缺 `oa_mysql_password` secret 或 entrypoint 没 export；补完 `down && up` |
| `ECONNREFUSED` / `ETIMEDOUT` / `EHOSTUNREACH` | 主机或端口错；MySQL 未监听外网地址（`bind-address`）；防火墙未放通 Gateway → 3306 |
| `ER_ACCESS_DENIED_ERROR` | 密码错；账号 host 部分不含 Gateway 来源 IP；本机装的 MySQL 还留着匿名账号（见安装手册第 3 节） |
| `ER_BAD_DB_ERROR` | 库没建，或 `mysql.database` 写错 |
| `ER_TABLEACCESS_DENIED_ERROR` / 建表失败 | 账号缺 `CREATE` / `INDEX` 权限 |
| 回执 `DB_UNAVAILABLE` | 上面几项之一；插件会在下次调用自动重连，不必为第一次失败重启 Gateway（初始化失败除外） |
| 插件不出现在 list / 工具冲突 | `allow` / `paths` / `entries` 全部改成 `oa-workflow-bridge`，旧 id 删干净 |
| 员工「还不能提交到 OA」 | 看会话回执里的具体码，按 [企微到OA身份.md](企微到OA身份.md) 第 7 节；`docker logs` 里 grep 不到工具回执是正常的 |
| 企微已落盘，员工仍看到「没有检测到新文件」 | 两个插件都要开 `hooks.allowConversationAccess`；hook 收件日志是 `captured inbound via …`；群聊 hook 没带发送人时只能靠工具 ctx 收 |
| `STAGING_MISSING` | 没设 `OPENCLAW_STATE_DIR` 或 staging 被删；员工取消后重报 |
| `RECONCILIATION_REQUIRED` | 禁止自动重试；按运维手册第 10 节人工对账 |
| `PARAM_ERROR` / `HTTP_4xx` | OA 明确拒绝，单已结束；核对字段 / 附件格式，让员工重报 |
| 单据出现在接口账号名下 | Header `userid` 必须是申请人；确认部署的是本仓库插件 |
| `OA_BRIDGE_INACTIVE` | 现网 `bridge-config.json` 为 `active=false` |

## 9. 禁止事项

- 不要多 Gateway 连同一个库；不要同时加载旧 id。
- 不要把 MySQL 密码、OA AppSecret、接口账号写进 `openclaw.json`、`bridge-config.json` 或 compose `environment:`。
- 不要删 `oa_ticket` 历史行或改 `external_ticket_id`。
- 不要把附件 base64 写进库。
- 不要对 `unknown` / `failed` 自动再 `submit_confirmed`。
- 不要用接口账号人员 id 当建单 Header `userid`；不要按姓名模糊匹配申请人。
- 不要在宿主装 npm，不要把 `npm install` 写进 compose / entrypoint。
- 不要在 `active=false` 时让规则声称 OA 已通。
