# OA Workflow Bridge（Redis）接入手册

> 本文档由仓库原文档**重组**而来：只调整章节归属与交叉引用，**不改变**部署步骤、命令、YAML、错误码或禁止事项。阅读顺序见 [README.md](../README.md)。

适用对象：需要在 OpenClaw Gateway 上部署 **OA 桥接插件**（`oa-workflow-bridge-redis`）的工程师。当前按 **单 Gateway、一个业务** 部署。多 Gateway / 附件跨机以后再用 SQL 存文件，不在本插件范围内。

本文档基于目录 **`OA_tool/oa-workflow-bridge-redis/`**。OA 接口与字段见同目录 [Ecology 流程创建 API 说明.md](Ecology%20流程创建%20API%20说明.md)。独立 Redis 怎么跑见 `../Redis 独立实例部署手册.md`。工位 WSL2 + Docker 见 `../OpenClaw Gateway WSL2-Docker 安装手册.md`；Linux 服务器见 `../OpenClaw Gateway Linux 服务器安装手册.md`。

**项目生产主路径是本文（Redis 版）。** `plugins.allow` 只写 `oa-workflow-bridge-redis`，不要再加载旧 id `oa-workflow-bridge`。两个 id 都会注册工具 `oa_workflow`，同时加载会冲突。

**当前状态：**

| 项 | 状态 |
| --- | --- |
| 插件代码 | 已交付，位于 `OA_tool/oa-workflow-bridge-redis/` |
| 状态存储 | **Redis**（pending / ledger / idx，按工单号点查） |
| 并发锁 | 进程内队列（`withStateLock`），**不是** Redis `SET NX` |
| 附件暂存 | 本机目录（不进 Redis） |
| 实时提交 | 规则包按 **`active=true`**；真正建单看实际加载的 `bridge-config.json` |
| Agent 调用 | **已加入** `tools.alsoAllow`（全局 + `itservicedeskagent`）。不要加入 `wecom_mcp` |
| 身份映射 | **Redis `idmap`**（`identity.adapter=on`，`identity.store=redis`）。适配器已验证通过 |
| npm 依赖 | 桥接与 `wecom-oa-identity-adapter` **都**依赖 `redis ^4.7.0`。现网已按 4.2 装齐；备份恢复后须重装（见 4.2 / 11）。`npm test` 用内存模拟，不需要本机 Redis 进程 |

---

## 1. 为何使用 Redis

| 能力 | 说明 |
| --- | --- |
| pending / ledger | 存在 Redis，Gateway 重启后可恢复 |
| 并发确认 | 同进程串行，一次只处理一张工单的确认 |
| 部署形态 | **单 Gateway**；多实例以后用 SQL 存文件 |
| 工具 API | `oa_workflow`（prepare / attach / submit_confirmed / status / cancel） |
| 安全模型 | 固定 action + 可信上下文 + 两阶段确认 |
| 附件 | 本机 staging，不进 Redis |
| 过期 | 判定只看 pending JSON 的 `expiresAt`；pending 另有 Redis TTL 作兜底回收（`ledger` / `idx` 无 TTL） |

典型场景：单 Gateway 工单桥接、确认前底稿可恢复、同一工单号幂等。

不要用本插件水平扩展。两个 Gateway 即使连同一 Redis，锁仍是各进程自己的队列，可能双写 OA；附件 staging 也在各实例本地盘。

---

## 2. 架构

### 2.1 在 Aidy 中的位置

全景（含切入 OA 的范围、各层 I/O）见 `../Aidy 现网加固与演进全景.md`。本节只画本插件接到 OA 的位置。

```text
企业微信员工
    ↓
wecom-openclaw-plugin（通道 + 可信身份 requesterSenderId）
    ↓
Aidy Agent（itservicedeskagent）
    ↓ 理解对话、整理 draft
oa-workflow-bridge-redis（工具 oa_workflow）
    ├── 身份适配器     进程内包；prepare miss：企微 + getHrmUserInfoWithPage → SET EX idmap（不注册模型 tool）
    ├── Redis          pending / ledger / idx（桥接写）；idmap / idmiss（适配器写）
    ├── 本地 staging/  附件暂存（base64 仅桥接内部）
    ├── secrets        OA 凭据 + 企微自建应用转换凭据（与机器人 BotSecret 分开）
    └── submit 锁外    认证 GET getHrmSimpleInfo（xqsqbm / gw / bgdd）→ doCreateRequest
    ↓
Ecology OA（流程 602）
```

### 2.2 模型与插件的分工

详见 [Ecology 流程创建 API 说明.md](Ecology%20流程创建%20API%20说明.md) 与本文第 3、6、7 节。核心原则：

**OA 写入必须是确定性的，不能交给模型直接调 HTTP。**

| 模型负责 | 插件负责 |
| --- | --- |
| 理解员工文字/图片 | 校验企微可信上下文 |
| 生成 `draft` 结构化参数 | 字段映射、两阶段确认、幂等 |
| 展示汇总、引导确认 | Redis 状态、OA 调用 |
| 输出中文状态卡 | 隐藏凭据、SenderId、附件 base64 |

### 2.3 插件目录结构

```text
oa-workflow-bridge-redis/
├── （部署文档位于仓库 `OA_tool/`，不在本插件目录内）
├── openclaw.plugin.json             # id: oa-workflow-bridge-redis；contracts.tools: oa_workflow
├── index.mjs                        # 插件入口；hook 记住 inbound；session_end / gateway_stop 清理
├── bridge-config.json               # OA + Redis 配置
├── system-options.json              # 业务系统名 → OA 选项 ID
├── system-handlers.json             # 系统名 → OA 处理人 id（clry）
├── ticket-type-systems.json         # 工单类型允许的系统名白名单
├── package.json                     # 依赖 redis ^4.7.0、jpeg-js、pngjs
├── src/
│   ├── tool.mjs                     # oa_workflow（prepare / attach / submit_confirmed / status / cancel）
│   ├── trust.mjs                    # requireTrustedContext、identityCode / sessionCode
│   ├── inbound-media.mjs            # 本轮 inbound / ctx 附件收集与去重
│   ├── inbox-lifecycle.mjs          # /new、session_end 丢掉尚未 prepare 的 inbox
│   ├── hints.mjs                    # oa_workflow 回执 hintZh
│   ├── log-redact.mjs               # 日志脱敏
│   ├── state-store.mjs              # 按 key 读写 pending / ledger / idx / inbox / person-*
│   ├── redis-client.mjs             # 连接 Redis、PING、关闭
│   ├── memory-redis.mjs             # 单元测试用内存实现
│   ├── preflight.mjs                # Redis PING + OA 只读预检逻辑
│   ├── staging.mjs                  # 附件目录路径
│   ├── attachments.mjs              # 附件 staging；图片压缩嵌描述，文档转 base64 进 scfj
│   ├── media-kind.mjs               # 按扩展名 / 魔数区分图片与文档
│   ├── image-embed.mjs              # 图片压缩为 JPEG 后转 data URI
│   ├── mapping.mjs                  # 业务字段 → OA 字段
│   ├── hrm-profile.mjs              # 提交前 getHrmSimpleInfo：部门 / 岗位 / 办公地点
│   ├── oa-client.mjs                # Ecology API 客户端
│   ├── config.mjs                   # 配置加载（含 redis 块）
│   └── secret-resolver.mjs          # 凭据解析（只读 OA_API_USER_ID / OA_APP_SECRET；不读映射目录、不回退 DPAPI）
├── scripts/
│   ├── readonly-preflight.mjs       # Redis PING + OA 只读预检
│   ├── live-print-create.mjs        # 调试：打印建单 payload（非部署必需）
│   └── sync-and-print-create.sh     # 调试脚本（非部署必需）
└── tests/                           # npm test（见 8.1）
```

OpenClaw 发现顺序（官方）：`plugins.load.paths` → workspace extensions → `~/.openclaw/extensions` → 内置。本插件走 **显式 `load.paths`**。`plugins.allow` 必须包含 `oa-workflow-bridge-redis`，否则 restrictive allowlist 会拦截。官方：`plugins.deny` 优先于 allow；workspace 来源插件默认关闭，必须 `entries.<id>.enabled: true`。改 `load.paths` 后必须重启 Gateway。

---

## 3. Redis 存储设计

### 3.1 Key 规范

默认前缀：`oa-workflow-bridge`（可在 `bridge-config.json` → `redis.keyPrefix` 修改）。插件 id 是 `oa-workflow-bridge-redis`，**key 前缀默认不带 `-redis`**。多环境应改 `keyPrefix`（如 `oa-bridge-aidy-it`），不要和其它业务共用前缀。

| Key 模式 | 内容 | TTL |
| --- | --- | --- |
| `{prefix}:pending:{confirmationId}` | 待确认工单 JSON | `SET PX` = `expiresAt` - 当前时间 + 60 秒宽限。**过期判定只看 JSON 里的 `expiresAt`**（默认 24h），TTL 只是宽限后兜底回收，见 3.3 |
| `{prefix}:ledger:{externalTicketId}` | 幂等台账 JSON | **永久**（已提交的工单号要长期留着；防什么见 3.3） |
| `{prefix}:idx:confirmation:{confirmationId}` | 工单号反向索引，供 status 点查 | 该 confirmation 有效时保留；同一工单号再次 `prepare` 会 **DEL 旧 idx** |
| `{prefix}:pending-idx:{identity}:{session}` | 该提交人在该 OpenClaw 会话的当前 `confirmationId`（会话级索引） | 与 pending 同一套 `SET PX`；`cancel` 与提交成功时必须 DEL **原会话**这把钥匙。**键必须带 identity**，否则群聊里多人分别建单会互相顶掉。**全局闸门是下一行 `person-pending`** |
| `{prefix}:person-pending:{identity}` | 该提交人**全局**当前待确认 `confirmationId`，跨 `/new` 仍可查/确认/取消 | 与 pending 同一套 `SET PX` |
| `{prefix}:person-tickets:{identity}` | 该人最近工单状态 JSON（submitted / cancelled / expired 等，不含草稿正文） | 无 TTL；最多 20 条 |
| `{prefix}:inbox:{identity}:{session}` | 建单前 `attach` 暂存的附件清单 JSON（`storedName` / `fileName` / `size` / `sourcePath`） | `SET PX` = `inboxTtlMinutes`（默认 30）。`prepare` 认领后立即 DEL。`/new` / `session_end` 立刻 DEL |
| `{prefix}:person-inbox:{identity}` | 该人当前 inbox 落在哪个 session 码 | 与 inbox 同一套 `SET PX`。换会话时用来清旧 inbox，避免 SCAN |
| `{prefix}:idmap:{mappingCode}` | JSON `{ oaUserId, cachedAt }`。**适配器写，桥接只 GET** | `SET EX`，默认 24h。正文见 `身份适配器说明.md` |
| `{prefix}:idmiss:{mappingCode}` | 短错误码负缓存。仅适配器写 | `SET EX`，默认 10 分钟。正文见 `身份适配器说明.md` |

`idmap` / `idmiss` 由适配器 `SET EX`；`pending` 由桥接 `SET PX`（宽限兜底，见 3.3）；**`ledger` 与 `idx` 仍然禁止 Redis TTL**。生产 Redis 必须 **AOF**（或 RDB + AOF）且内存策略 **noeviction**。ledger 无 TTL，被 LRU 踢掉会破坏幂等。完整加固见 `../Redis 独立实例部署手册.md`。身份键正文见 `身份适配器说明.md`。

### 3.2 pending 记录示例

```json
{
  "confirmationId": "OA-MXXXXX-XXXXXXXX",
  "identity": "24位映射码（SHA-256 截断）",
  "session": "24位会话码",
  "oaRequesterId": "1001",
  "draft": { "...": "结构化工单" },
  "staged": [{ "storedName": "01-截图.png", "fileName": "截图.png", "size": 12345, "sourcePath": "/home/node/.openclaw/media/inbound/…" }],
  "createdAt": "2026-08-28T07:00:00.000Z",
  "expiresAt": 1756366800000
}
```

提交过程中会多写 `submissionState`：`submitting` 或 `unknown`。`status` **优先读 pending**：身份匹配即可（不要求原 OpenClaw 会话），未过期且非 `submitting`/`unknown` 才返回 `AWAITING_CONFIRMATION`；过期返回 `CONFIRMATION_EXPIRED`（并回收 pending）；`submitting`/`unknown` 返回 `RECONCILIATION_REQUIRED`。不要把对账中的单再报成「待确认」。无 `confirmationId` 时：可确认的待确认返回 `PERSON_STATUS`；当前 pending 已是 `submitting`/`unknown` 则**顶层同样是** `RECONCILIATION_REQUIRED`（仍带 `pending`），不要按「有 pending 就出确认卡」处理。

### 3.3 ledger 记录示例

```json
{
  "status": "submitted",
  "confirmationId": "OA-MXXXXX-XXXXXXXX",
  "identity": "...",
  "session": "...",
  "externalTicketId": "IT-20260805-121500-A1B2",
  "requestId": "778899",
  "updatedAt": "2026-08-28T07:05:00.000Z"
}
```

失败时可能带 `errorCode`（不会写入凭据或附件内容）。

`status` 取值：`awaiting_confirmation` / `submitting` / `submitted` / `failed` / `unknown` / `cancelled`。

| 状态 | 含义 |
| --- | --- |
| `awaiting_confirmation` | 已 prepare，等待原发送人确认 |
| `submitting` | 已进入提交，正在调 OA（或正在读本地附件） |
| `submitted` | OA 返回数字 `requestid` |
| `failed` | OA 明确拒绝。pending / 占位已删，同一确认号再交回 `OA_CREATE_REJECTED`；修正后 **换新工单号** 再 prepare |
| `unknown` | 网络中断 / HTTP 5xx / 成功但无单号；**禁止自动重试** |
| `cancelled` | 用户取消待确认 |
| `expired` | 确认窗口到期，pending / staging / 草稿已回收 |

**ledger 防什么、不防什么。** 键是插件生成的内部工单号 `IT-YYYYMMDD-HHMMSS-XXXX`（模型传入一律忽略），**无 TTL**。它是**这一张号**对 Ecology 的永久发票根，不是「刚交完、短时间内不能再交」的冷却，也不是按人防重复报修。

| 会拦 | 回执 | 不拦 |
| --- | --- | --- |
| 同一号已 `submitted`，再 `prepare` | `ALREADY_SUBMITTED` | 员工把同一件事又说一遍，插件生成**新** `IT-…` 再 `prepare`（提交成功后 `person-pending` 已清，立刻开新单是允许的） |
| pending 已删，仍拿刚成功的 `confirmationId` 再 `submit_confirmed`（模型幻觉多调一次、员工说「再提交」但模型复用旧确认号） | 靠 `idx` 找到 ledger → `ALREADY_SUBMITTED`，**不再** `doCreateRequest` | 「再提交」被理解成新单。新号要靠 `AGENTS.md` 不要乱 `prepare`，ledger 管不到 |
| pending 已删，仍拿刚被拒的 `confirmationId` 再 `submit_confirmed` | `OA_CREATE_REJECTED`，**不再** `doCreateRequest` | 员工改稿后 `prepare` 新号（`person-pending` 已清） |
| 同一号处于 `submitting` / `unknown` 再 `prepare` 或再确认 | `RECONCILIATION_REQUIRED` | 同一个人同时只能有一张**待确认**（那是 **`person-pending`**） |

连点两次确认同一张单：进程内队列先串行；成功后 ledger=`submitted`。企微把正文和附件拆成两条、两轮会各生成一个工单号，**只查 ledger 拦不住**，必须靠 `person-pending`。不要给 ledger 加 TTL、不要 LRU 踢掉 ledger、不要把 ledger 理解成按人冷却。

过期：`pendingTtlHours`（默认 24）写入 pending JSON 的 `expiresAt`，**判定过期只看这个字段**。同时 pending 的 Redis key 带 `PX` = `expiresAt` - 当前时间 + **60 秒宽限**（`state-store.mjs` 的 `PENDING_TTL_GRACE_MS`），用来在用户既不确认也不取消时兜底回收，不留常驻 key。因此到期前后有三个阶段：

| 阶段 | `submit_confirmed` | `status` | `cancel` | 同一工单号重新 `prepare` |
| --- | --- | --- | --- | --- |
| `expiresAt` 之前 | 正常提交 | `AWAITING_CONFIRMATION` | `CANCELLED` | 被 `ALREADY_PENDING` 拦住 |
| 已过期、仍在 60 秒宽限内 | `CONFIRMATION_EXPIRED` | `CONFIRMATION_EXPIRED` | `CONFIRMATION_EXPIRED`（回收 pending / staging，ledger=`expired`，**不是** `CANCELLED`） | 允许（pending 已过期不再拦） |
| 宽限过后，key 已被 Redis 回收 | `CONFIRMATION_EXPIRED` | `CONFIRMATION_EXPIRED`（并把 ledger 补写成 `expired`） | `CONFIRMATION_EXPIRED`（不是 `CANCELLED`，人没取消过） | 允许 |

最后一行：pending 被 TTL 回收后，`status` / `submit_confirmed` / `cancel` **同一套过期码**，不要再报待确认或 `NOT_FOUND`。看见这一跳会把 ledger 从 `awaiting_confirmation` 补成 `expired`。`ledger` 本身仍无 TTL，幂等不受影响；直接重新 `prepare` 即可。

过期或提交成功后会清理对应本机 staging，避免磁盘积压；未清掉的孤儿 staging 目录由下一次任意 `oa_workflow` 调用（`prepare` / `attach` / `status` / `cancel` / `submit_confirmed`）触发的 GC 回收（新建目录有 10 分钟宽限，避免并发 prepare 互删）。**例外：** pending 仍在且 `submissionState` 为 `submitting` / `unknown` 时，即使 `expiresAt` 已过也不删该单 staging（锁外压图 / 对账还要用）。这与宿主机 cron 清 inbound **原件**无关：cron 只动 `config/media/inbound` 与 `workspace/media/inbound`（运维手册 **10.4**），**不碰** `oa-workflow-bridge-redis/staging/`。**`SUBMITTED` 不是 Redis / 会话 / inbound 全空**，删留见 3.3.1。

`failed` 后 pending / `person-pending` 已删，不要复用同一 `externalTicketId` 再 prepare（文档口径是换新编号；插件每次也会新开内部号）。若仍复用同一编号，同一工单号写入新 confirmation 时会 **DEL 旧 idx**。同一确认号再 `submit_confirmed` 回 `OA_CREATE_REJECTED`，不再打 Ecology。

### 3.3.1 提交成功（`SUBMITTED`）后删什么、留什么

口径：**没有全删。** 只清这张待确认单的暂存；幂等台账、身份缓存、企微对话本身都会留下。代码：`doCreateRequest` 得到数字 `requestId` 之后 `commitTicketState`（`DEL pending` + `DEL` **原会话** `pending-idx` + `DEL person-pending` + `SET ledger=submitted`），再 `removeStagingDirectory`。

附件字节已随建单进入 OA（图片嵌 `wtxqmskftp`，文档写 `scfj`）。桥接侧只删本单 staging **副本**。

会清：

| 层 | 清什么 | 何时 |
| --- | --- | --- |
| Redis | `{prefix}:pending:{confirmationId}` | 建单成功后 `DEL` |
| Redis | `{prefix}:pending-idx:{identity}:{session}` | 与 pending 同一次 `MULTI`；**必须删建单时的原会话**，不能只删当前 `/new` 会话 |
| Redis | `{prefix}:person-pending:{identity}` | 与 pending 同一次 `MULTI`；闸门清掉后同一人才能再 `prepare` |
| 本机磁盘 | `staging/{confirmationId}/` 整目录 | 成功后 `rm` |
| 进程内 | **同一会话** inbound 附件缓冲（`inbound-media.mjs` 的 Map，默认 30 分钟） | **锁内标 `submitting` 时** `consumeInboundMedia`（OA HTTP 之前）。**跨会话确认不清当前会话 inbound**，留给处理完旧单后的新单 |
| Redis | `{prefix}:inbox:{identity}:{session}` | **`prepare` 认领时**已 `DEL`；`/new` / `session_end` 也会立刻 `DEL`（尚未 prepare 时） |
| Redis | `{prefix}:person-inbox:{identity}` | 与 inbox 一起写、一起删 |

故意留下（不是漏清）：

| 层 | 留下什么 | 原因 |
| --- | --- | --- |
| Redis | `{prefix}:ledger:{工单号}` = `submitted` + 数字 `requestId` | **永久**，同一工单号禁止再 `prepare` |
| Redis | `{prefix}:idx:confirmation:{confirmationId}` | pending 删了，`status` 仍靠它找 ledger |
| Redis | `{prefix}:person-tickets:{identity}` | 最近 20 条状态摘要，`/new` 后仍能查已提交 |
| Redis | `{prefix}:idmap` / `{prefix}:idmiss` | 身份缓存，与这张单无关；默认 24h / 10 分钟。下次 `prepare` 命中则 0 次外部 HTTP |
| 进程内 | `stagedPathsBySession`（已暂存过的 inbound 路径） | 同一会话不要把刚交过的旧图带进下一张单 |
| 进程内 | OA `applytoken` 约 25 分钟、企微 `gettoken` 约 90 分钟 | 与工单生命周期无关 |
| OpenClaw | 会话 jsonl / 对话上下文 | 桥接不碰；员工接着聊，历史还在 |
| 本机 | `{stateDir}/media/inbound/` 与 `{stateDir}/workspace/media/inbound/` 通道原件 | 桥接从这两处拷副本进 staging（对应宿主机 `config` 与 `workspace`），**插件不删** inbound。宿主机 cron 满 24 小时回收两处原件，见运维手册 **10.4**。prepare 前源文件可能已被清掉，所以才必须拷 staging |

不要和失败路径混：`OA_BRIDGE_INACTIVE` 时 pending 不动；`STAGING_MISSING` / 资料现查失败退回 awaiting，**staging 仍在**；`unknown` 时 pending 仍在且 `submissionState=unknown`。`doCreateRequest` **明确拒绝**（`failed`）与成功一样 `DEL pending` + `DEL` 原会话 `pending-idx` + `DEL person-pending` + 删 staging，ledger 留 `failed`；同一确认号再交回 `OA_CREATE_REJECTED`。

一句话：待确认 Redis（含原会话 `pending-idx` 与 `person-pending`）+ 本单 staging 会清；**同一会话**才会清 30 分钟 inbound hook 缓存；ledger / 确认单索引 / 身份 `idmap` / 对话历史插件不删。inbound 原件插件不删；人多涨盘时由宿主机 cron 满 24 小时清两处目录（运维手册 10.4），不要手删、不要动 ledger。

### 3.4 按 key 读写（禁止 SCAN）

业务路径只碰**这一张工单**的 key，用 `GET` / `SET` / `DEL`，相关 key 一次 `MULTI`/`EXEC`。不要用 `SCAN` / `KEYS` 列出全部 pending/ledger 再差量覆盖。

| action | Redis 操作 |
| --- | --- |
| `prepare` | `GET ledger:{工单号}` 做幂等检查 → `GET person-pending`（本人全局已有未过期的**别的**单则 `ALREADY_PENDING`，回执含 `sameSession` / `retentionHours`）→ `GET idmap`（miss 走适配器，未解析则 **不写** pending）→ `GET inbox` 认领建单前暂存的附件 → `MULTI`：`SET pending` + `SET ledger` + `SET idx` + `SET pending-idx` + `SET person-pending`；若工单号已有旧 confirmation，**DEL 旧 idx**。提交状态写成功后 `DEL inbox` |
| `attach` | 带 `confirmationId`：`GET pending` → 校验身份/过期；**另一会话**已有此人待确认则 `ALREADY_PENDING` 且不追加。同一会话则暂存新附件 → `SET pending`（`staged` 追加）。不带 `confirmationId`：若另一会话已有 pending 则同样 `ALREADY_PENDING`；否则若 `person-inbox` 指向别的 session 则先清旧 inbox，再 `GET inbox` → 暂存到会话 inbox 目录 → `SET inbox`（带 `inboxTtlMinutes` 的 `PX`）。成功路径**不碰** ledger、不改工单状态 |
| `cancel` | `GET pending` → 已过期则回收并 `CONFIRMATION_EXPIRED`（ledger=`expired`，不是 cancelled）。未过期：`MULTI`：`DEL pending` + `DEL pending-idx` + `DEL person-pending` + `SET ledger` 为 cancelled（同 ID 的 idx 保留）。删 staging / inbox。仅当当前 OpenClaw 会话与建单会话相同才回灌附件供同轮改稿；`/new` 后取消不回灌 |
| `status` | 无 `confirmationId`：读 `person-pending` + `person-tickets`。可确认的待确认返回 `PERSON_STATUS`；`submitting`/`unknown` 顶层返回 `RECONCILIATION_REQUIRED`。有 ID：`GET pending`；没有则 `GET idx` → `GET ledger`。过期则回收 pending 并返回 `CONFIRMATION_EXPIRED` |
| `submit_confirmed` | `GET pending` → 校验身份/过期 → `active=false` 则直接 `OA_BRIDGE_INACTIVE`（不改 pending）→ 否则锁内仅**同一会话**才追加确认消息新 inbound（跨会话只提交旧单已暂存附件）并标 `submitting` → **锁外**读附件、认证 `getHrmSimpleInfo`（不写 Redis）、调 `doCreateRequest` → 成功则 `DEL pending` + `DEL pending-idx` + `DEL person-pending` + `SET ledger` 为 submitted。**明确拒绝**同样 `DEL` 这三把 pending 键，`SET ledger=failed`。**结果不明**则 pending 留 `submissionState=unknown`。pending 已不在时按 idx 读 ledger：`submitted` → `ALREADY_SUBMITTED`；`failed` → `OA_CREATE_REJECTED`；`unknown` / `submitting` → `RECONCILIATION_REQUIRED`。会话缓存 / staging / 其余 Redis 的删留见 3.3.1 |

点查用的索引：`{prefix}:idx:confirmation:{confirmationId}` → 工单号。提交成功后 pending 删除，status 仍靠这条索引找到 ledger。不要据此以为 Redis 已空，见 3.3.1。

同一工单号 `cancel` 后再 `prepare`：新 confirmation 写入新 idx，旧 idx 删除。`status(旧 confirmationId)` 返回 `NOT_FOUND`，不会串到新单。仅 cancel、尚未再 prepare 时，`status(原 ID)` 仍返回 `cancelled`。

### 3.5 并发：同进程队列，不是分布式锁

`src/state-store.mjs` 用模块级 Promise 链串行化 `prepare` / `submit_confirmed` / `cancel`。同一 Node 进程里，并发第二次 confirm 不会第二次调 OA。

这 **不是** Redis `SET NX` 跨进程锁，也 **不是** 多 Gateway 锁。当前按 **一台 Gateway**。`bridge-config.json` 里若仍留着旧字段 `lockTtlSeconds`，插件会忽略。

附件 base64 和 OA HTTP 在锁外执行，避免把确认窗口卡在大文件编码上。本地 staging 丢失时返回 `STAGING_MISSING`，把 submitting 退回 `awaiting_confirmation`，**不**标 `unknown`、**不**调 OA。`getHrmSimpleInfo` 失败同样退回 awaiting，**不**标 `unknown`、**不**调 `doCreateRequest`。同一 `OAClient` 实例先资料现查、再建单，token 缓存约 25 分钟，通常只 `applytoken` 一次。

### 3.6 附件为何不存 Redis

- 单文件最大 10 MB，合计最大 25 MB，最多 10 个。上限在**收件当时**（`prepare` / `attach`）就校验并返回 `ATTACHMENT_LIMIT_EXCEEDED`，不拖到提交才失败
- Redis 里只存 `storedName` / `fileName` / `size` / `sourcePath`（`sourcePath` 是本机 inbound 路径，供 `cancel` 回灌，不进 OA、不给模型）
- base64 仅在 `submit_confirmed` 调 OA 前于桥接内部生成，不进模型与 Redis。图片先压缩再编 data URI 写入 `wtxqmskftp`；文档才写入 `scfj`
- 源路径必须落在 `{stateDir}/media/inbound/`（`realpath` 校验，防路径穿越）
- `prepare` 自动收集本轮 inbound：`message_received`（以及 `agent_turn_prepare` / `before_prompt_build`）会话缓存、工具 ctx 媒体路径、可选模型 `attachments`。只认当前轮 `cleanedBody` / 最后一条用户消息里的 inbound 路径，以及结构化 `media` 字段；**不**从完整 prompt 或会话历史里刮路径（避免把 `AGENTS.md` 占位符和旧截图带进本单）。已消失的 inbound 文件在暂存时跳过，不让整单失败。**不扫描** inbound 目录。模型不必传 `attachments`
- Hook 事件常用 `SenderId` / `from.userid`，工具 ctx 才保证有 `requesterSenderId`，且经常同时带 `sessionId`。缓冲键仍优先 `提交人 + sessionId`；`attach` / `prepare` 读取时还会试 `提交人 + sessionKey`。裸 `sessionKey` 仅当其中已包含发送人（单聊 `wecom:direct:…`）才作为候选，避免群聊把同事的图并进自己的单。隔离口径见 [工单会话隔离与资料回收场景.md](工单会话隔离与资料回收场景.md)
- `message_received` 需要 **两个**插件都开 `hooks.allowConversationAccess: true`：`oa-workflow-bridge-redis` 才能订 hook；`wecom-openclaw-plugin` 才能把媒体路径带到对话 / 工具 ctx。缺后者时日志为 wecom 的 `before_prompt_build` blocked，带图提单更容易只靠 hook 缓冲
- `attach` / `submit_confirmed` 若消息又带 inbound：同样合并会话缓存与本轮 ctx，但**排除已暂存的路径**，避免重复。真正并入文件后才消费 hook 缓冲；`NO_NEW_ATTACHMENT` **不清**缓冲，员工重发同一张图仍可再试。日志为 `attach collecting … inbound (buffered=… ctx=…)` 与 `attach attached|buffered|no-new`
- 建单前的 `attach` 落到会话 inbox 目录，`prepare` 时整批搬进本单 staging 并删除 inbox。会话缓存是进程内的，只作 hook 到 `attach` / `prepare` 之间的第一跳，**30 分钟**后失效。Redis inbox TTL 同样默认 **30 分钟**（对齐 OpenClaw 空闲新会话）。`/new` / `session_end` 会立刻丢掉尚未 prepare 的 inbox，换 `sessionId` 的 `prepare` 也不会认领上一会话附件。
- 暂存路径：`{OPENCLAW_STATE_DIR}/oa-workflow-bridge-redis/staging/{confirmationId}/`；会话 inbox 是同级的 `staging/inbox-{identity}-{session}/`，孤儿目录由同一套 GC 按 Redis `inbox` key 是否还在回收

`index.mjs` 解析状态根目录，优先级：

1. 环境变量 **`OPENCLAW_STATE_DIR`**
2. 环境变量 `OPENCLAW_CONFIG_PATH` 的父目录
3. 回落 `{homedir}/.openclaw-aidy-it-service`

Docker 必须设 `OPENCLAW_STATE_DIR=/home/node/.openclaw`（与 config 挂载一致）。不设则附件不在当前 volume 上，重启或确认时会 `STAGING_MISSING`。

数据必须在 Linux 文件系统上（`~/aidy/config`），不要放 `/mnt/c`。

### 3.7 Redis 连接与持久化

- 生产务必开 **AOF**（`appendonly yes`），或 RDB + AOF；ledger 无 TTL，内存策略用 **noeviction**
- Redis 仅内网访问，设置密码，不对公网暴露
- 连接优先级：`OA_REDIS_URL` → `REDIS_URL` → `bridge-config.json` 的 `redis.url`
- 启动时 Redis 不可达只打日志；**之后再调用会重新连接**（不会一直用第一次失败的结果）
- Gateway 停止时走官方 `gateway_stop`（以及插件 `shutdown`）关闭 Redis 连接
- 读写都是指定 key；**不要**对 `pending:*` / `ledger:*` 做 `SCAN`/`KEYS` 当业务路径
- 云 Redis 可用 `rediss://`（TLS）。容器内不要用 `127.0.0.1`（那是 Gateway 自己，不是 Redis）
- `redis.database` 须与 URL 路径 `/0` 一致。密码含 `@` `:` `/` 时必须做 URL 编码

---

## 4. 安装与依赖

### 4.1 前置条件

| 项 | 要求 |
| --- | --- |
| Node.js | **Docker：宿主不必装 Node。** 依赖用 **本机已有的** OpenClaw 镜像内的 Node 22+ 安装（见 4.2；镜像名以 `docker images` / `inspect` 为准）。Windows 原生或在宿主跑 `npm test`：本机 Node 22+（官方插件文档要求 22.22.3+ / 24.15+ / 25.9+）。**不要** `sudo apt install npm` |
| Redis | 6+（本机模拟与生产示例为 Redis 7），Gateway 可网络访问 |
| OpenClaw Gateway | 已跑通，企微插件可用（否则无可信 `requesterSenderId`） |
| OA 凭据 | AppSecret 需轮换后配置 |
| 实例数 | **仅 1 个** Gateway 进程 |

### 4.2 安装插件依赖

**约定：** 部署时装一次，`node_modules` 留在挂载目录 `~/aidy/extensions/oa-workflow-bridge-redis/`。Gateway **启动时不再访问 npm**。WSL2 与 Linux 服务器 Docker **同一套命令**。

**不要：**

| 不要做 | 原因 |
| --- | --- |
| 在 Docker 宿主 `apt install npm` / 装 Node | Ubuntu 仓库版本不够 22+；服务器应只跑 Docker |
| 把 `npm install` 写进 `docker-compose.yml` 或 `entrypoint.sh` | 每次 `up` 依赖外网 registry；失败则 Gateway 起不来；entrypoint 只负责凭据 |
| Gateway 起来后再 `docker exec` 补装 | 插件加载时已需要 `redis` 与 `jpeg-js`（`image-embed.mjs` 顶层 import），装完还得再重启 |
| `docker run` 写一个 `docker images` 里没有的仓库名 | Docker 按「仓库名:标签」匹配，不按内容。本机只有 `ghcr.io/openclaw/openclaw:latest` 时再写 `openclaw/openclaw:latest`，会当成新镜像去 Docker Hub 再拉一次 |

**Docker（WSL2 与 Linux 服务器）：**

这条命令是一次性容器（`--rm`）：只借 OpenClaw 镜像里的 Node 22+ 把 `node_modules` 写进挂载目录，**不是**再起一套 Gateway。本机已有**同名**镜像时不会拉镜像；缺的是 npm 包（桥接：`redis` / `jpeg-js` / `pngjs`；适配器：`redis`）。须已能拿到 Gateway 所用的那张官方镜像（安装手册第 3 节加速；拉镜像：**工位 WSL2 手册第 7 节**方案 A/B，**Linux 服务器手册第 10 节**方案 A/B）。

**先对齐镜像名，再装。** Docker 按「仓库名:标签」匹配，不按内容。`openclaw/openclaw:latest` 与 `ghcr.io/openclaw/openclaw:latest` 是两个名字；本机只有其中一个时，写另一个会被当成缺镜像再拉一次。

`compose ps` 为 `Restarting` 时 **IMAGE** 列仍然可信，不要 `docker exec`。先看本机实际名字：

```bash
cd ~/aidy
docker compose ps
docker images | grep openclaw
```

以 **IMAGE** 列为准。还没 `up`：看 `docker images` 和 `~/aidy/docker-compose.yml` 的 `image:`。

| 本机实际名字 | 何时出现 | 用哪条命令 |
| --- | --- | --- |
| `ghcr.io/openclaw/openclaw:2026.9.2` | **本仓库生产钉**（`docker/docker-compose.yml`） | 下面「GHCR 钉版本」；`npm install` 最后一行用这一串 |
| `openclaw/openclaw:latest` | 安装手册初装默认；工位手册第 7 节 / Linux 服务器手册第 10 节方案 A 已 `docker tag` | 下面「Hub 名」 |
| `ghcr.io/openclaw/openclaw:latest` | 方案 A 只 `pull` 没 tag，或 yml 的 `image:` 已改成 ghcr latest | 下面「GHCR 名」 |

`docker images` **没有** `openclaw/openclaw` 时：不是缺镜像。不要 `docker pull openclaw/openclaw:latest`。现网用「GHCR 钉版本」整段；只有 `:latest` 标签时用「GHCR 名」，或先 `docker tag` 再走「Hub 名」。

先对齐 uid。

**Hub 名**（本机已有 `openclaw/openclaw:latest`）：

```bash
sudo chown -R 1000:1000 ~/aidy/extensions

docker run --rm --user 1000:1000 \
  -e HOME=/tmp \
  -e NPM_CONFIG_CACHE=/tmp/npm-cache \
  -v "$HOME/aidy/extensions/oa-workflow-bridge-redis:/app" \
  -w /app \
  openclaw/openclaw:latest \
  npm install --omit=dev
```

**GHCR 钉版本**（本仓库 `docker/docker-compose.yml` 的 `image:`）：

```bash
sudo chown -R 1000:1000 ~/aidy/extensions

docker run --rm --user 1000:1000 \
  -e HOME=/tmp \
  -e NPM_CONFIG_CACHE=/tmp/npm-cache \
  -v "$HOME/aidy/extensions/oa-workflow-bridge-redis:/app" \
  -w /app \
  ghcr.io/openclaw/openclaw:2026.9.2 \
  npm install --omit=dev
```

**GHCR 名**（本机没有 `openclaw/openclaw`，`compose ps` 的 IMAGE 为 `ghcr.io/openclaw/openclaw:latest`）：

```bash
sudo chown -R 1000:1000 ~/aidy/extensions

docker run --rm --user 1000:1000 \
  -e HOME=/tmp \
  -e NPM_CONFIG_CACHE=/tmp/npm-cache \
  -v "$HOME/aidy/extensions/oa-workflow-bridge-redis:/app" \
  -w /app \
  ghcr.io/openclaw/openclaw:latest \
  npm install --omit=dev
```

可选：打别名（不下载）。tag 之后「Hub 名」那条也能用；yml 的 `image:` 不必改回 Hub 名。

```bash
docker tag ghcr.io/openclaw/openclaw:latest openclaw/openclaw:latest
```

**身份适配器同一套命令再跑一遍。** `wecom-oa-identity-adapter` 同样依赖 `redis`。只装桥接、不装适配器，idmap miss 时仍会 `Cannot find package 'redis'`。把上面 `-v` 换成适配器目录，镜像名不变：

```bash
docker run --rm --user 1000:1000 \
  -e HOME=/tmp \
  -e NPM_CONFIG_CACHE=/tmp/npm-cache \
  -v "$HOME/aidy/extensions/wecom-oa-identity-adapter:/app" \
  -w /app \
  openclaw/openclaw:latest \
  npm install --omit=dev
```

现网钉版本把最后一行镜像改成 `ghcr.io/openclaw/openclaw:2026.9.2`；若本机只有 `:latest` 的 GHCR 名则改成 `ghcr.io/openclaw/openclaw:latest`。国内超时同样追加 `--registry=https://registry.npmmirror.com`。

核对桥接三包、适配器 `redis` 后再起 Gateway：

```bash
ls ~/aidy/extensions/oa-workflow-bridge-redis/node_modules/redis
ls ~/aidy/extensions/oa-workflow-bridge-redis/node_modules/jpeg-js
ls ~/aidy/extensions/oa-workflow-bridge-redis/node_modules/pngjs
ls ~/aidy/extensions/wecom-oa-identity-adapter/node_modules/redis
cd ~/aidy && docker compose down && docker compose up -d
```

独立 Redis（`~/aidy-redis`）保持 up。已在跑的 Gateway 只 `up -d` 不会重载插件，必须 `down && up`。

**缺 `redis`（2026-09-02 曾现网发生）：** Gateway 日志仍可能有 `loaded (Redis state)`，紧接着 `Redis init failed: Cannot find package 'redis'`。员工侧「确认准备失败」，工单号已生成但 pending 未写入。不是独立 Redis 挂了，也还没调 Ecology。

**缺 `jpeg-js` / `pngjs`（2026-09-08 图片内嵌后）：** 桥接**整包加载失败**，日志为 `Cannot find module 'jpeg-js'`（Require stack 含 `image-embed.mjs`）。`http server listening` 只有 `wecom-openclaw-plugin`；企微能聊，但 `oa_workflow` 未注册，模型会空转补问、无法 `prepare`。`package.json` 已列这两包，**现网 `node_modules` 仍须按本节重装**。只装了旧的 `redis`、拷了新源码、或备份排除了 `node_modules`，都会再发。

再装时机：插件目录被清空、从备份恢复（运维手册备份排除 `node_modules`）、`package.json` 依赖变更。目录仍在且三包都在就不必重装。

Linux 服务器命令相同。也可在已装好的 Linux x64 机器上把整个 `oa-workflow-bridge-redis` **和** `wecom-oa-identity-adapter`（均含 `node_modules`）拷过去，生产机不必连 npm。`redis` 客户端为纯 JS。

国内拉 npm 超时，在 `npm install --omit=dev` 后追加 `--registry=https://registry.npmmirror.com`。形成固定发布后可补 `package-lock.json` 并改用 `npm ci --omit=dev`；当前步骤仍用 `npm install --omit=dev`。

**Windows 原生 / 开发机跑测试：**

```powershell
cd .\oa-workflow-bridge-redis
npm install
npm test
```

`npm test` 使用 **内存 Redis 模拟**，无需本地 Redis 服务、无需 OA 网络即可跑通单元测试。Docker 路径不要求在宿主跑 `npm test`。

### 4.3 部署 Redis

生产 Redis 是独立机器或托管实例；OpenClaw **只通过 `OA_REDIS_URL` 连接**。本机（Windows 工作站 + WSL2）用 **独立 Linux 容器**（`~/aidy-redis`）模拟这层隔离。

| 不要做 | 原因 |
| --- | --- |
| 安装 Windows 原生 Redis / Memurai | 官方 Redis 以 Linux 为准 |
| Gateway 容器内写 `127.0.0.1:6379` | 那是容器自己，不是 Redis |
| 把 Redis 和 Gateway 写进同一份 compose（生产） | `compose down` 会把存储一起停 |
| 把 Redis 密码写进 `openclaw.json` 或 compose `environment:` | `docker inspect` 能看到明文 |

完整拓扑、密码分边、AOF、`noeviction` 见 **`../Redis 独立实例部署手册.md`**（独立 Redis compose 为默认路径）。Gateway 怎么连（compose 增量、entrypoint、启停顺序）见第 5.5 节。

Windows **原生 OpenClaw**（非 Docker）可连 WSL2 / 本机 Linux 容器映射出的 `127.0.0.1:6379`。Gateway 若跑在容器里，应使用 Docker 网络主机名（如 `redis://aidy-redis:6379`）。

---

## 5. OpenClaw 插件接入

### 5.1 复制插件到 extensions

**Docker（WSL2 与 Linux 服务器）：**

```bash
# 不要与文件版同时拷进 extensions 后双开
cp -r /path/to/oa-workflow-bridge-redis ~/aidy/extensions/oa-workflow-bridge-redis
# 依赖安装见 4.2（官方镜像；镜像名以 compose ps 的 IMAGE / docker images 为准；不要在宿主执行 npm）
```

本仓库路径示例：

```bash
cp -r "$REPO/OA_tool/oa-workflow-bridge-redis" ~/aidy/extensions/
```

`REPO` 是本仓库根目录。不要再拷文件版 `oa-workflow-bridge`。

文件版 `state.json` 方案已废弃，本仓库不维护 Windows 原生拷贝步骤。

### 5.2 openclaw.json 配置

**`plugins.allow` 只写 `oa-workflow-bridge-redis`。** 不要写旧 id `oa-workflow-bridge`。

```json
"plugins": {
  "allow": [
    "oa-workflow-bridge-redis",
    "wecom-openclaw-plugin"
  ],
  "deny": [
    "codex"
  ],
  "load": {
    "paths": [
      "/home/node/.openclaw/extensions/oa-workflow-bridge-redis"
    ]
  },
  "entries": {
    "oa-workflow-bridge-redis": {
      "enabled": true,
      "hooks": { "allowConversationAccess": true }
    },
    "wecom-openclaw-plugin": {
      "enabled": true,
      "hooks": { "allowConversationAccess": true }
    },
    "codex": {
      "enabled": false
    }
  }
}
```

- Docker 容器内路径写 `/home/node/.openclaw/...`
- Windows 原生写 profile 下的 `extensions\oa-workflow-bridge-redis`
- 修改 `plugins.load.paths` 后必须 **重启 Gateway**（`docker compose down && up` 或重启 Windows 服务）
- 官方：`plugins.deny` 优先于 allow；workspace 来源插件默认关闭，必须 `entries.<id>.enabled: true`

无企微插件、先把网关跑通时：allow / paths / entries 只留 `oa-workflow-bridge-redis`，并删掉整个 `channels.wecom`（见安装手册同一套路）。没有企微则没有可信 `requesterSenderId`，`oa_workflow` 会返回 `UNTRUSTED_CONTEXT`。

**身份适配器默认不写进本段。** 不要把 `wecom-oa-identity-adapter` 加入 `allow` / `load.paths` / `tools.alsoAllow`。开关在本插件 `bridge-config.json` 的 `identity.adapter`，不是 `openclaw.json`。完整说明见 `身份适配器说明.md` 第 10 节。

### 5.3 环境变量

| 变量 | 用途 | 优先级 / 是否需要 |
| --- | --- | --- |
| `OA_REDIS_URL` | Redis 连接 URL | 高于 json；**Docker 必配**（entrypoint 拼出，不要写进 compose `environment:`） |
| `REDIS_URL` | 同上（通用别名） | 次之 |
| `bridge-config.json` → `redis.url` | 默认连接 | 最低；容器内不要写 `127.0.0.1` |
| `OPENCLAW_STATE_DIR` | 状态根目录（附件 staging） | **Docker 必配** `/home/node/.openclaw` |
| `OA_API_USER_ID` | 只读预检 Header `userid`。**不是**建单 Header（建单用申请人）。仍须注入 | Docker 必配 |
| `OA_APP_SECRET` | OA AppSecret | Docker 必配 |
| `WECOM_IDENTITY_CORPID` / `WECOM_IDENTITY_SECRET` | 自建应用转换凭据 | **`identity.adapter=on` 必配**；不要写进 json。YAML 见身份适配器说明第 10.6 节 |
| `WECOM_OA_IDENTITY_ADAPTER_PATH` | 适配器包根目录 | 与桥接并列时不必设 |

没有 `OA_SECRET_SOURCE`。`secret-resolver.mjs` **只**读上表环境变量；未注入就是缺凭据（`NOT_CONFIGURED`），不会回退映射目录或 DPAPI。

示例（宿主机或 Windows 原生；Docker 由 entrypoint 注入，见 5.5）：

```bash
export OA_REDIS_URL="redis://:yourpassword@aidy-redis:6379/0"
```

### 5.4 bridge-config.json

仓库现网文件见 `OA_tool/oa-workflow-bridge-redis/bridge-config.json`。**初装**按两本安装手册保持 `active=false`；**现网**该文件为 `active: true`。`appId` 以实际加载的 json 为准（仓库样例是 `2026-09-01-lijinjin`，不是 `oa-develop`）。`redis.url` 现网文件留空，生产由进程环境变量 `OA_REDIS_URL` 覆盖成 `aidy-redis`。裸跑或本机调试用 `bridge-config.example.json`（`active: false`，`redis://127.0.0.1:6379`），不要把 example 直接当现网。

```json
{
  "active": true,
  "baseUrl": "https://adtekoa.com",
  "appId": "2026-09-01-lijinjin",
  "workflowId": 602,
  "isnextflow": "0",
  "publicKeySpkiBase64": "...",
  "attachmentFieldName": "scfj",
  "pendingTtlHours": 24,
  "inboxTtlMinutes": 30,
  "maxAttachmentBytes": 10485760,
  "maxTotalAttachmentBytes": 26214400,
  "redis": {
    "url": "redis://aidy-redis:6379/0",
    "keyPrefix": "oa-workflow-bridge",
    "database": 0
  },
  "identity": {
    "adapter": "on",
    "store": "redis"
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `active` | `false` 时 `submit_confirmed` 不调 OA，返回 `OA_BRIDGE_INACTIVE`。初装 false；现网仓库样例 `true` |
| `isnextflow` | 必填，只允许 `"0"` / `"1"`。写入 `doCreateRequest.otherParams`。`"0"`：建单成功但停在申请人节点（现网生产测试）；`"1"`：建单后自动流转（目标口径）。缺字段或乱填拒绝加载，不会默认成 `"1"`。改完须重启 Gateway。与 `active` 不是一事 |
| `baseUrl` | 必须恰好为 `https://adtekoa.com`（代码强制校验） |
| `appId` | 以实际加载的 `bridge-config.json` 为准（仓库样例 `2026-09-01-lijinjin`） |
| `workflowId` | 目标流程，当前 **602** |
| `publicKeySpkiBase64` | OA RSA 公钥（SPKI Base64）；代码校验长度与字符集 |
| `attachmentFieldName` | 官方字段名 `scfj`，只收文档。空则拒绝**带文档**的提交；仅有图片仍可建单。仓库样例已写成 `scfj`。现网以实际加载的 json 为准 |
| `pendingTtlHours` | 确认窗口，写入 `expiresAt`；**不会**让 Redis 自动删 pending |
| `inboxTtlMinutes` | 建单前 `attach` 的附件缓冲存活时长，**可选，默认 30**。对齐 OpenClaw `session.resetByType.*.idleMinutes`。`/new` / `session_end` 会立刻清掉尚未 prepare 的 inbox。仍可用旧字段 `inboxTtlHours`（小时 × 60），不要两个一起写 |
| `maxAttachmentBytes` | 单文件上限，默认 10 MB |
| `maxTotalAttachmentBytes` | 合计上限，默认 25 MB |
| `redis.url` | Redis 连接串兜底；生产用 `OA_REDIS_URL`，json 里不要写密码 |
| `redis.keyPrefix` | Key 命名空间，多环境可改为 `oa-bridge-prod` 等 |
| `redis.database` | Redis DB 编号（0–15），须与 URL 路径 `/0` 一致 |
| `identity.adapter` | `on`（**省略时默认**）：`import` 并列目录适配器，先 GET `idmap`，miss 再 `resolve`。`off`：**不**调用适配器、**不**读映射文件，`prepare` 回 `OA_IDENTITY_MAPPING_REQUIRED`。现网必须 `on`；缺转换凭据应补 `WECOM_IDENTITY_*`，不要靠 `off` 回退 |
| `identity.store` | **只允许 `redis`**（省略时默认）。写 `files` 或其它值会在加载配置时抛 `identity.store must be redis`，插件起不来 |

已提交的 ledger 不要手动 DEL。json 里若仍留着旧字段 `lockTtlSeconds`，插件会忽略。

打开适配器：拷贝并列目录、注入自建应用凭据、`identity.adapter=on` 且 `store=redis`，一律见 `身份适配器说明.md` 第 10 节。不要在 `openclaw.json` 里写 `identity.adapter`。

### 5.5 Docker：compose 与 entrypoint

官方 Compose secrets 挂到容器内 `/run/secrets/<name>`。OpenClaw **不读** `*_FILE` 变量，由 entrypoint 读文件再 `export`。身份映射走 Redis `idmap`，不要把映射文件挂进 workspace 或 `.openclaw`。

**不要**把 `OA_REDIS_URL` 写进 compose 的 `environment:`（`docker inspect` 会看到密码）。独立 Redis 服务本身在 `~/aidy-redis`（怎么跑、密码分边、AOF 见 **`../Redis 独立实例部署手册.md` 第 3 节**）。

**不要**在 `~/aidy/docker-compose.yml` 里再声明 `aidy-redis` 服务，也不要 `depends_on: aidy-redis`（跨 compose 项目找不到对方服务）。启动顺序靠运维：先 Redis，再 Gateway。

#### 5.5.1 Gateway compose 增量

在现有 `aidy-gateway` 上增加：**自己的** `oa_redis_password` secret、OA 凭据、自建应用转换凭据、`aidy-shared` 外部网络。**生产 image / TZ / logging 以仓库 `docker/docker-compose.yml` 为准**（现网钉 `ghcr.io/openclaw/openclaw:2026.9.2`）；安装手册初装阶段仍可用 Hub `latest`。  
`oa_redis_password` 的 `file:` 只能是 `./secrets/oa_redis_password.txt`（即 `~/aidy/secrets/`），**不要**指向 `~/aidy-redis/`。密码文件本身按 Redis 手册第 3.1 节两边各写一份。

第三套凭据（`WECOM_IDENTITY_*`，与 BotSecret、OA AppSecret 不是一套）的含义、禁止复用与校验见 `身份适配器说明.md` 第 10.6 / 10.7 节。下面整份 YAML **已含**这两项；只复制本小节时不要再删掉，否则宿主机有 `wecom_identity_*.txt`、容器仍 `OA_IDENTITY_NOT_CONFIGURED`。

OA 核心凭据与 Redis 密码一样走 Compose secrets。身份映射走 Redis `idmap`（不要目录 volume）。先建文件，compose 才能 `up`：

```bash
printf '%s' '你的OA人员资源ID' > ~/aidy/secrets/oa_api_user_id.txt
printf '%s' '已轮换的AppSecret' > ~/aidy/secrets/oa_app_secret.txt
chmod 600 ~/aidy/secrets/oa_api_user_id.txt ~/aidy/secrets/oa_app_secret.txt
sudo chown 1000:1000 ~/aidy/secrets/oa_api_user_id.txt ~/aidy/secrets/oa_app_secret.txt
```

AppSecret 未轮换前可以先放占位，Gateway 能起来；只读预检和 `prepare` 仍会 `NOT_CONFIGURED`，直到写入真值并 `down && up`。

`oa_api_user_id.txt` 必须是 **1–18 位纯数字**（该应用所属账号的人员资源 id，不是 appid、不是工号）。用于只读预检 Header `userid`，**不要**当作 `doCreateRequest` 的 Header。已知该账号工号时，可调 `getHrmUserInfoWithPage` 取 `data.dataList[].id`，现网实测可不带认证 Header；只抄 `id`，不要保存完整人事 JSON。桥接运行时不调该接口；申请人 id 由身份适配器写入 `idmap`（miss 时适配器按同一无 Header 形态点查），建单 Header 与 `xqsqr` 都用这个申请人。细节见 `企微到OA身份与数据流.md` 第 2–3 节与 `Ecology 流程创建 API 说明.md` 第四步。

```yaml
services:
  aidy-gateway:
    image: ghcr.io/openclaw/openclaw:2026.9.2
    container_name: aidy-gateway
    user: "1000:1000"
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"
    environment:
      TZ: Asia/Shanghai
      HOME: /home/node
      OPENCLAW_GATEWAY_BIND: lan
      OPENCLAW_STATE_DIR: /home/node/.openclaw
    secrets:
      - gateway_token
      - wecom_bot_id
      - wecom_bot_secret
      - model_api_key
      - model_base_url
      - model_id
      - model_ref
      - oa_redis_password
      - oa_api_user_id
      - oa_app_secret
      - wecom_identity_corpid
      - wecom_identity_secret
    volumes:
      - ./config:/home/node/.openclaw
      - ./workspace:/home/node/.openclaw/workspace
      - ./extensions:/home/node/.openclaw/extensions
      - ./entrypoint.sh:/entrypoint.sh:ro
    # 生产建议绑定本机： "127.0.0.1:18789:18789"
    ports:
      - "18789:18789"
    init: true
    entrypoint: ["/bin/sh", "/entrypoint.sh"]
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "node -e \"require('http').get('http://127.0.0.1:18789/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\"",
        ]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 40s
    networks:
      - aidy-shared

networks:
  aidy-shared:
    external: true

secrets:
  gateway_token:
    file: ./secrets/gateway_token.txt
  wecom_bot_id:
    file: ./secrets/wecom_bot_id.txt
  wecom_bot_secret:
    file: ./secrets/wecom_bot_secret.txt
  model_api_key:
    file: ./secrets/model_api_key.txt
  model_base_url:
    file: ./secrets/model_base_url.txt
  model_id:
    file: ./secrets/model_id.txt
  model_ref:
    file: ./secrets/model_ref.txt
  oa_redis_password:
    file: ./secrets/oa_redis_password.txt
  oa_api_user_id:
    file: ./secrets/oa_api_user_id.txt
  oa_app_secret:
    file: ./secrets/oa_app_secret.txt
  wecom_identity_corpid:
    file: ./secrets/wecom_identity_corpid.txt
  wecom_identity_secret:
    file: ./secrets/wecom_identity_secret.txt
```

转换凭据文件怎么写、禁止复用 BotSecret，见 `身份适配器说明.md` 第 10.6 节。不要把映射文件挂进 `/home/node/.openclaw` 或 workspace。`identity.adapter=on` 时这两个 secret **必须**挂上；只建 txt、不改 compose，容器里是 `WECOM_IDENTITY_FILES_MISSING`。

`OPENCLAW_STATE_DIR=/home/node/.openclaw` 必须设。插件默认回落 `~/.openclaw-aidy-it-service`，不在当前挂载卷里，附件 staging 会丢。

#### 5.5.2 Gateway entrypoint：拼 `OA_REDIS_URL`

插件不读 `openclaw.json` 里的 Redis 密码，只认进程环境变量（优先级见第 5.3 节）。密码从 **Gateway 自己的** secret 读出，在入口脚本里拼成连接串。不要在这里起 Redis，也不要把 `OA_REDIS_URL` 写进 compose 的 `environment:`（`docker inspect` 会看到明文）。

**前置：** Redis 手册第 3.1 节已分别写好两边 Redis 密码文件；第 5.5.1 节已建 OA 凭据与转换凭据文件并挂进 compose。缺任一 **已在 compose 声明** 的 secret 文件时 `set -eu` 会让容器 Restarting。compose **没声明** `wecom_identity_*` 时容器能起来，但 `prepare` 会 `OA_IDENTITY_NOT_CONFIGURED`。

##### 5.5.2.1 必须插在 `exec` 之前

Redis、OA 凭据、转换凭据都要加在阶段 B 的模型 export **之后**、`exec node ...` **之前**。写在 `exec` 后面等于没写。

```sh
export OPENCLAW_STATE_DIR="/home/node/.openclaw"
REDIS_PASS="$(tr -d '\n' < /run/secrets/oa_redis_password)"
export OA_REDIS_URL="redis://:${REDIS_PASS}@aidy-redis:6379/0"
export OA_API_USER_ID="$(tr -d '\n' < /run/secrets/oa_api_user_id)"
export OA_APP_SECRET="$(tr -d '\n' < /run/secrets/oa_app_secret)"
export WECOM_IDENTITY_CORPID="$(tr -d '\n' < /run/secrets/wecom_identity_corpid)"
export WECOM_IDENTITY_SECRET="$(tr -d '\n' < /run/secrets/wecom_identity_secret)"
```

| 项 | 说明 |
| --- | --- |
| 读哪个文件 | 只读 `/run/secrets/oa_redis_password`（来自 `~/aidy/secrets/oa_redis_password.txt`） |
| 不要读 | Redis 容器的 `/run/secrets/redis_password`、`~/aidy-redis/secrets/` |
| URL 形态 | `redis://:密码@aidy-redis:6379/0`（用户名为空，密码在第一个 `:` 后面） |
| 主机名 | 本机 Docker 网络里是 `aidy-redis`，**不是** `127.0.0.1` |
| 库号 | `/0` 须与 `bridge-config.json` 的 `redis.database` 一致 |
| 编码 | Redis 手册第 3.1 节用 hex 生成的密码不必 URL 编码；若密码含 `@` `:` `/` 则必须编码 |
| 换云 Redis | 只改主机（或改成 `rediss://`），见 Redis 手册第 5 节 |
| OA 凭据 | `OA_API_USER_ID` / `OA_APP_SECRET` 从 `/run/secrets/` 读 |
| 转换凭据 | `WECOM_IDENTITY_CORPID` / `WECOM_IDENTITY_SECRET` 从 `/run/secrets/` 读；不要复用 `wecom_bot_secret`。含义见适配器说明 10.6 |
| 不要写进 json | OA / 转换凭据不走 `openclaw.json` 的 `${VAR}`，由插件 / 适配器 `secret-resolver.mjs` 读取 |

`OPENCLAW_STATE_DIR` 与 5.5.1 的 compose `environment` 重复设置没有问题；附件 staging 依赖它，不要删。

##### 5.5.2.2 整文件替换（推荐）

与安装手册阶段 B 的 entrypoint 对齐，再加 Redis、OA 凭据与转换凭据：**工位**见 WSL2 手册 **6.4.2**；**Linux 服务器**见该手册 **第 7 节**（第一份）与 **第 18 节**（拼 `OA_REDIS_URL`）。已接 OA 后**不要**再用安装手册里那份尚无 `WECOM_IDENTITY_*` 的 entrypoint 整段覆盖本文件。用下面整份覆盖 `~/aidy/entrypoint.sh`，避免漏插或插错位置：

```bash
cat > ~/aidy/entrypoint.sh <<'EOF'
#!/bin/sh
set -eu
for secret in \
  gateway_token \
  wecom_bot_id \
  wecom_bot_secret \
  model_api_key \
  model_base_url \
  model_id \
  model_ref \
  oa_redis_password \
  oa_api_user_id \
  oa_app_secret \
  wecom_identity_corpid \
  wecom_identity_secret
do
  path="/run/secrets/$secret"
  if [ ! -s "$path" ]; then
    echo "missing or empty secret: $path" >&2
    exit 1
  fi
done

# gateway token凭据
export OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < /run/secrets/gateway_token)"

export OPENCLAW_STATE_DIR="/home/node/.openclaw"

# 模型凭据（api 协议写死在 openclaw.json，不再注入 AIDY_DOMESTIC_API）
export AIDY_DOMESTIC_API_KEY="$(tr -d '\n' < /run/secrets/model_api_key)"
export AIDY_DOMESTIC_BASE_URL="$(tr -d '\n' < /run/secrets/model_base_url)"
export AIDY_DOMESTIC_MODEL_ID="$(tr -d '\n' < /run/secrets/model_id)"
export AIDY_DOMESTIC_MODEL_REF="$(tr -d '\n' < /run/secrets/model_ref)"

# 企微机器人访问凭据
export AIDY_IT_WECOM_BOT_ID="$(tr -d '\n' < /run/secrets/wecom_bot_id)"
export AIDY_IT_WECOM_BOT_SECRET="$(tr -d '\n' < /run/secrets/wecom_bot_secret)"

# 企业微信访问凭据
export WECOM_IDENTITY_CORPID="$(tr -d '\n' < /run/secrets/wecom_identity_corpid)"
export WECOM_IDENTITY_SECRET="$(tr -d '\n' < /run/secrets/wecom_identity_secret)"

# 连接redis
REDIS_PASS="$(tr -d '\n' < /run/secrets/oa_redis_password)"
export OA_REDIS_URL="redis://:${REDIS_PASS}@aidy-redis:6379/0"

# OA系统开门凭据
export OA_API_USER_ID="$(tr -d '\n' < /run/secrets/oa_api_user_id)"
export OA_APP_SECRET="$(tr -d '\n' < /run/secrets/oa_app_secret)"

exec node dist/index.js gateway --bind lan --port 18789
EOF
chmod 755 ~/aidy/entrypoint.sh
sudo chown 1000:1000 ~/aidy/entrypoint.sh
```

compose 用 `entrypoint: ["/bin/sh", "/entrypoint.sh"]` 时，即使文件没有 shebang 也能跑；仍建议保留 `#!/bin/sh`。

改完必须重建 Gateway，**只 `restart` 不够**（entrypoint 在创建容器时执行）：

```bash
cd ~/aidy && docker compose down && docker compose up -d
```

Redis 保持 `~/aidy-redis` 里 `up`，不要 `down`。

##### 5.5.2.3 怎么确认已经注入（不要用 `docker exec` 看环境变量）

`docker exec` **不会**跑 `entrypoint.sh`，新 shell 里 `OA_REDIS_URL` 为空是预期，**不能**据此判断失败。`docker inspect` 也只看得到 compose 的 `environment:`，看不到脚本 `export` 的值。

看 **Gateway 主进程**（`init: true` 时 PID 1 是 tini，变量在 `node` 上）。只判断有没有注入，**不要**打印 URL（里面是密码）：

```bash
docker exec aidy-gateway sh -c '
  for d in /proc/[0-9]*; do
    tr "\0" "\n" < "$d/environ" 2>/dev/null | grep -q "^OA_REDIS_URL=redis://" || continue
    echo OA_REDIS_URL_INJECTED
    exit 0
  done
  echo OA_REDIS_URL_MISSING
  exit 1
'
```

输出 `OA_REDIS_URL_INJECTED` 即可。secret 是否挂上：

```bash
docker exec aidy-gateway sh -c 'test -s /run/secrets/oa_redis_password && echo SECRET_OK'
docker exec aidy-gateway sh -c 'test -s /run/secrets/oa_api_user_id && test -s /run/secrets/oa_app_secret && echo OA_SECRET_FILES_OK'
docker exec aidy-gateway sh -c 'test -s /run/secrets/wecom_identity_corpid && test -s /run/secrets/wecom_identity_secret && echo WECOM_IDENTITY_FILES_OK'
```

查 OA / 转换环境变量是否注入时，把上面 `/proc` 循环里的 `OA_REDIS_URL=redis://` 换成 `OA_API_USER_ID=` / `OA_APP_SECRET=` / `WECOM_IDENTITY_CORPID=`（转换凭据还须同时命中 `WECOM_IDENTITY_SECRET=`），同样只判断有无，不要打印值。完整对照命令见 `身份适配器说明.md` 第 10.7 节。

此时 Redis 已通。Gateway 加载 OA 插件后，按第 5.6 节确认日志有 `loaded (Redis state)`。

| 现象 | 原因 |
| --- | --- |
| 主进程 `OA_REDIS_URL_MISSING` | 三行在 `exec` 之后、未 `down/up`、或 `oa_redis_password` 未挂进 compose |
| 容器 Restarting，日志 `oa_redis_password: No such file` | `~/aidy/secrets/oa_redis_password.txt` 不存在或 compose `secrets.file` 路径错 |
| 容器 Restarting，日志 `oa_api_user_id: No such file` | 未建 OA secret 文件；按第 5.5.1 节先建两个 txt |
| 容器 Restarting，日志 `wecom_identity_corpid: No such file` | compose 已声明转换 secret，但宿主机 txt 不存在或路径错 |
| `WECOM_IDENTITY_FILES_MISSING` 且容器 Up | 宿主机有 txt，compose **未**声明 `wecom_identity_*` |
| 主进程 `WECOM_IDENTITY_MISSING` | compose 已挂文件，但 entrypoint 未 export，或只 `restart` 没 `down && up` |
| `NOAUTH` / `WRONGPASS` | 两边密码文件内容不一致，见 Redis 手册第 3.1、9.3 节 |
| 日志 `Redis init failed` 且主机是 `127.0.0.1` | 仍在用 `bridge-config.json` 兜底，entrypoint 未注入 |

#### 5.5.3 启停顺序

```bash
cd ~/aidy-redis && docker compose up -d
cd ~/aidy       && docker compose up -d

# 只停应用
cd ~/aidy && docker compose stop

# 停 Redis（先停 Gateway）
cd ~/aidy && docker compose stop
cd ~/aidy-redis && docker compose stop
```

`cd ~/aidy && docker compose down` **不会**停 `~/aidy-redis`，这是预期。

### 5.6 验证插件已加载

```bash
# Docker
docker exec -it aidy-gateway node dist/index.js plugins list
docker exec -it aidy-gateway node dist/index.js config validate
```

应看到 `oa-workflow-bridge-redis` 且 `enabled`。Gateway 日志中应有：

```text
[oa-workflow-bridge-redis] loaded (Redis state) from ...
```

**不要**出现 `loaded in inactive-by-default mode`（那是文件版）。

若 Redis 不可达，首次调用 `oa_workflow` 会失败；启动时仅记录 init 错误日志。Redis 恢复后再次调用会重新连接，不必为「第一次失败」重启 Gateway。

### 5.7 Agent 工具白名单

即使插件已 loaded，Agent 也必须把 `oa_workflow` 加入 `tools.alsoAllow` 才能调用。Aidy 使用 `tools.profile: minimal`，官方要求插件工具用 `alsoAllow` 追加（见 [config-tools](https://docs.openclaw.ai/gateway/config-tools)）。本插件只登记工具、不登记通道；`plugins.allow` 与 `alsoAllow` 两层都要开。插件 vs 工具、以及去掉 `wecom_mcp` 不会关企微通道，见 `../openclaw.json 配置参考.md` 第 5.5 节。

**现网：** 全局 `tools.alsoAllow` 与 `agents.entries.itservicedeskagent.tools.alsoAllow` **均只含** `oa_workflow`，**不含** `read` / `wecom_mcp` / `write` / `edit` / `memory_*` / `message`。Agent 级 `deny` 含 `group:fs`。完整 json 见 `../openclaw.json 配置参考.md` 第 15 节。规则包按 `active=true` 执行。

```json
"alsoAllow": [
  "oa_workflow"
]
```

两处 `alsoAllow` 必须保持一致。**不要**把 `wecom-oa-identity-adapter` 写进 `alsoAllow`（它不注册 tool）。不要加入 `read` / `write` / `edit` / `memory_*` / `message` / `wecom_mcp`。不要只改 `active` 却移出 `oa_workflow`。

---

## 6. 凭据与身份映射

解析器是本插件 `oa-workflow-bridge-redis/src/secret-resolver.mjs`（**不要**与文件版共用模块）。

OA 接口侧身份规则见 [Ecology 流程创建 API 说明.md](Ecology%20流程创建%20API%20说明.md) 与 [../第三方凭据注入与配置中心演进.md](../第三方凭据注入与配置中心演进.md) 第 0 节。

| 凭据引用 ID | 用途 |
| --- | --- |
| `oa/aidy-it-service/api-user-id` | 只读预检人员 id。**不是**建单 Header（建单用申请人）。仍须注入 |
| `oa/aidy-it-service/app-secret` | OA 应用密钥（仅 `applytoken`） |

**Docker 路径：** 核心凭据走 Compose secrets → entrypoint 环境变量。身份映射走 Redis `idmap`。`secret-resolver.mjs` 已删除映射目录与 DPAPI；缺 `OA_API_USER_ID` / `OA_APP_SECRET` 就是缺凭据。

含 `oa_redis_password` + OA 凭据的完整 compose / entrypoint 见第 5.5 节。自建应用转换凭据见 `身份适配器说明.md` 第 10.6 节。

| 宿主机 | 容器 | 本插件读取 |
| --- | --- | --- |
| `~/aidy/secrets/oa_api_user_id.txt` | `/run/secrets/oa_api_user_id` | `OA_API_USER_ID` |
| `~/aidy/secrets/oa_app_secret.txt` | `/run/secrets/oa_app_secret` | `OA_APP_SECRET` |
| `~/aidy/secrets/oa_redis_password.txt` | `/run/secrets/oa_redis_password` | 仅 entrypoint 用来拼 `OA_REDIS_URL`；插件不直接读该文件 |
| `~/aidy/secrets/wecom_identity_corpid.txt` | `/run/secrets/wecom_identity_corpid` | `WECOM_IDENTITY_CORPID`（适配器；与 BotSecret 分开） |
| `~/aidy/secrets/wecom_identity_secret.txt` | `/run/secrets/wecom_identity_secret` | `WECOM_IDENTITY_SECRET` |

映射码为企微 `requesterSenderId` 的 SHA-256 截断 24 位小写十六进制。`prepare` 先 GET `{prefix}:idmap:{mappingCode}`；miss 由身份适配器转换后 `SET EX`。查不到人员时返回 `OA_IDENTITY_NOT_FOUND` 等，不写 pending。禁止按姓名模糊搜 OA 人员。

**现网（2026-09-01）：** `requesterSenderId` 来自智能机器人 `body.from.userid`，为 **`wo` 开头的加密 userid**，不是 OA 工号。不要把日志里的 `wo…` 当作 `xqsqr`。字段分层与 Redis `idmap` 见 `企微到OA身份与数据流.md`。加密 userid → 明文 → 工号对齐由 **身份适配器**完成（已验证），不要在本插件 `oa-client.mjs` 里调 `openuserid_to_userid` 或 `getHrmUserInfoWithPage`；设计见 `身份适配器说明.md`。提交前部门 / 岗位 / 地点由本插件 `hrm-profile.mjs` 经 `OAClient` 调 `getHrmSimpleInfo`，见现网加固第 7 节。

缺上述环境变量时 `resolveProtectedValues` 返回空，预检 / 建单为 `NOT_CONFIGURED`，**不会**回退 PowerShell、DPAPI 或任何映射文件。

不要把身份写成 Redis Hash。适配器写 `idmap:{mappingCode}`（STRING + EX），桥接只 GET。不要文件和 Redis 双写身份。不要在桥接 `oa-client.mjs` 里用工号现查（`getHrmUserInfoWithPage`）。

---

## 7. oa_workflow 工具 API

本节是工具契约的正文。[Ecology 流程创建 API 说明.md](Ecology%20流程创建%20API%20说明.md)、`openclaw/OA_WORKFLOW_CONTRACT.md` 与 `../外部系统 Tool 插件设计规范.md` 与此对齐，细节以本文为准。

Schema 使用 `additionalProperties: false`。模型不能传入 URL、凭据、`workflowId`、OA 字段名，也不能覆盖 `requesterSenderId`。

必须满足：

```text
messageChannel = wecom
requesterSenderId = 企微插件提供的可信发送人 ID（现网为加密 userid，不是工号；见身份文档）
sessionKey 或 sessionId = 当前会话标识
```

群聊必须以 **实际发送人** 建单，不能用群 ID 代替人员身份。

| action | 是否写 Redis | 是否调 OA |
| --- | --- | --- |
| `prepare` | 是（pending + ledger + idx + pending-idx + person-pending；认领后删 inbox） | **不**调 `doCreateRequest` / `getHrmSimpleInfo`。身份 miss 时适配器可能调企微与 `getHrmUserInfoWithPage` |
| `attach` | 同一会话：改 pending 的 `staged`，或写会话 inbox。跨会话已有此人待确认：不写，回 `ALREADY_PENDING`。**不碰** ledger | 否 |
| `submit_confirmed` | `active=false`：**不写**（pending / ledger 都不改）；`active=true`：锁内标 `submitting`，成功则 `DEL` pending + **原会话** pending-idx + person-pending + ledger=`submitted` | 仅 `active=true` 且确认未过期：先 `getHrmSimpleInfo`，再 `doCreateRequest` |
| `status` | 只读点查（无 ID：可确认则 `PERSON_STATUS`；对账中则 `RECONCILIATION_REQUIRED`） | 否 |
| `cancel` | 是（删 pending + 原会话 pending-idx + person-pending，ledger 标 cancelled） | 否 |

**确认前就会写 Redis。** 两阶段确认需要 `confirmationId`、草稿、发送人、附件路径；Gateway 重启后才能继续确认。不是「员工点确认才第一次写 key」。不确认就不要**永久占着**：过期后可 `cancel`，或取消后重新 `prepare`。

### 7.1 `prepare`

必填 `draft`（**不要**传 `externalTicketId`，插件按 `WeComReceivedAt` + `message_id` 生成内部幂等号；模型传入会被忽略）：

| 字段 | 约束 |
| --- | --- |
| `ticketType` | `运维支持` / `权限申请` / `IT需求` |
| `systemName` | 必须能在 `system-options.json` 命中 |
| `location` | 可选。电脑/打印机/网络问题应传 `智园` / `大磡` / `深汕` / `越南` / `光明` / `泗洪`；不传时插件从 `systemName` 括号兑底。确认卡只读回执 `location` |
| `summary` | ≤ 200 字。确认卡用原话开头预览（长的约 20 字加 `...`），不要把长文当摘要 |
| `problemDescription` | ≤ 6000 字 |
| `demandType` / `monthlyHours` | 仅 IT 需求必填 |

可选：`impactScope`、`occurredAt`、`attemptedMeasures`。本轮企微 inbound 图片/文件由插件自动暂存，**不必**传 `attachments[]`。仍可选用 `attachments[]`：`localPath` 必填，且必须在 inbound 目录内。`message_received` 需要 `oa-workflow-bridge-redis` **和** `wecom-openclaw-plugin` 都设 `hooks.allowConversationAccess: true`（见 3.6 / 5.2），否则只靠工具 ctx 上的媒体路径。插件**不会**扫描 inbound 目录兜底。

成功：`AWAITING_CONFIRMATION` + `confirmationId` + `expiresAt` + `retentionHours` + 顶层 `location` + `summary.problemSummary` / `summary.location` + `attachmentCount` / `imageCount` / `documentCount`（不含凭据、不含 base64、不含原始 SenderId）。确认卡须回显问题 / 地点 / 附件；本会话确认卡不要 24 小时提示，拦截卡仍提示。

**同一提交人全局只允许一张待确认单**（跨 `/new` 仍拦住）。再 `prepare` 会返回 `ALREADY_PENDING`，回执带已存在的 `confirmationId`、`expiresAt`、`retentionHours`、`sameSession`、`summary`、`location`、附件计数，以及内部 `externalTicketId`（后者不要展示给员工）。索引键含 `identity`，群聊里不同发送人互不影响。跨会话只能确认或取消，不能 `attach`。员工可见拦截卡须回显上一张的 `summary` / `location` / 附件计数。

### 7.2 `attach`

员工把问题和附件分几条发过来时用。**不销毁 pending、不换 `confirmationId`、不改工单状态**，所以不要为了加附件去 `cancel` + `prepare`。

| 传入 | 行为 | 回执 |
| --- | --- | --- |
| 带 `confirmationId` | 校验原发送人 / 未过期 / 非 `submitting`；**同一 OpenClaw 会话**才把本轮 inbound 追加进 `pending.staged`。另一会话已有此人待确认单则不追加 | `ATTACHED` + `addedCount` + 累计 `attachmentCount` / `imageCount` / `documentCount`；跨会话则 `ALREADY_PENDING`（`sameSession=false`，同样带 `summary` / `location` / 附件计数） |
| 不带 `confirmationId` | 落到会话 inbox（`{prefix}:inbox:{identity}:{session}` + `staging/inbox-…/`），等 `prepare` 认领。若此人在**另一会话**已有待确认单，不写入 inbox | `BUFFERED` + 同上计数；跨会话则 `ALREADY_PENDING` |

本轮没有可暂存的新文件时返回 `NO_NEW_ATTACHMENT`（**不是**失败，但上层必须如实告诉员工没收到，不能凭空承诺）。此回执**不清** hook 缓冲。企微已落盘、日志有 `remembered N inbound`、但员工仍看到「没有检测到新文件」，先核 3.6 的会话键与两个 `allowConversationAccess`。超过单文件 10 MB / 合计 25 MB / 最多 10 个时返回 `ATTACHMENT_LIMIT_EXCEEDED`，pending 不变。也可显式传 `attachments[]`，规则与 `prepare` 相同。

`imageCount` / `documentCount` 在 `attach` 阶段按**文件名**判定，仅供回话；真正的图片 / 文档分流在提交前按文件头判定，以 `submit_confirmed` 回执为准。

### 7.3 `submit_confirmed`

同一 `confirmationId` 仅原发送人可确认（跨 `/new` 按人认，不要求原 OpenClaw 会话）。可选 `supplement`（≤ 2000 字）。**同一会话**确认消息若又带 inbound 文件，插件自动追加：合并会话缓存与本轮工具 ctx 媒体路径，**排除 prepare 已暂存的同一路径**（当场提交不会把同一张图写两遍）；也可再传 `attachments`。**另一会话**确认只提交旧单已暂存附件，不并入本会话新图，也不清空本会话 inbound（留给处理完旧单后的新单）。并发第二次在进程内锁下不会第二次调 OA。

**`active=false` 闸门：** 校验 pending / 原发送人 / 过期后直接返回 `OA_BRIDGE_INACTIVE`，**不**把 `supplement` 写入 pending，**不**标 `submitting`，**不**调 OA。规则包按 `active=true` 执行；真正建单看实际加载的 `bridge-config.json`。确认前改稿必须 `cancel` 再 `prepare`。`supplement` 只在 `active=true` 时并入 `wtxqmskftp`。

创建接口：`POST https://adtekoa.com/api/workflow/paService/doCreateRequest`。成功判定：`code=SUCCESS` 且返回 **数字** `requestid`。`otherParams` 现网插件发 `isnextflow`（取自 `bridge-config.json`，仓库样例 `"0"`）、`delReqFlowFaild=1`、`isVerifyPer=1`（后两项写死在 `src/mapping.mjs`）。`isnextflow=1`：建单后 OA 自动流转；`=0` 也是正常建单，只是不自动流转、停在申请人节点。**现网为生产测试开关，配置 `"0"`**；项目可用后把 json 改成 `"1"` 并重启 Gateway，不要改源码。官方 `clry` 始终必填：插件按 `systemName` 写入 `system-handlers.json` 中的负责人 id，模型不传人员 id。字段释义见 [Ecology 流程创建 API 说明.md](Ecology%20流程创建%20API%20说明.md)。

Token：`POST /api/ec/dev/auth/applytoken`，RSA PKCS1 加密 AppSecret；进程内缓存约 25 分钟（OA token 约 30 分钟有效）。`doCreateRequest` 的 Header `userid` 是 RSA 加密后的**申请人**人员 id（`pending.oaRequesterId`），与表单 `xqsqr` 同一人；不要用接口账号。只读预检 `getCreateWorkflowList` 仍用接口账号。

| 业务字段 | OA 字段 |
| --- | --- |
| 申请人 | Header `userid`（RSA 加密 `pending.oaRequesterId`）与 `xqsqr`（明文），同一人员 id |
| 申请部门 / 岗位 / 办公地点 | `xqsqbm` / `gw` / `bgdd`。提交前认证 `GET /api/hrm/simpleinfo/getHrmSimpleInfo?userid=`（token + appid + RSA 申请人，与建单同一套钥匙）。缺任一资源 ID 则 `OA_PROFILE_INCOMPLETE`；`status=false` / `002` / 网络失败则 `OA_PROFILE_LOOKUP_FAILED`。都不调建单 |
| 处理人员 | `clry`。始终必填。插件按 `systemName` 写入 `system-handlers.json` 的负责人 id（多人逗号分隔）。模型不传人员 id。缺配置则拒绝建单 |
| 工单类型 | `sqlx`：运维支持 `0`、权限申请 `1`、IT 需求 `2` |
| 系统 | `wtlx` / `szxt` / `szxtxq`（`system-options.json`） |
| 需求类型 / 月节约工时 | `xqlx1` / `yjygsh`（仅 IT 需求） |
| 问题详情 | `wtxqmskftp`：问题文字 + 影响范围 / 发生时间 / 已尝试措施 / 最终补充。inbound **图片**压缩为 JPEG 后以 `<img src="data:image/jpeg;base64,…">` 嵌在文字后。**不**写入 Aidy 工单编号 |
| 文档附件 | `scfj`：只传文档。HTTP `fieldValue` 为数组的 JSON 字符串 `"[{\"filePath\":\"base64:<裸base64>\",\"fileName\":\"<含扩展名>\"}]"`。`filePath` 须带 `base64:` 前缀。有文档才写。图片不进此字段。`attachmentFieldName` 为空时带文档拒绝；仅有图片不写 `scfj`。字段释义见 [Ecology 流程创建 API 说明.md](Ecology%20流程创建%20API%20说明.md) |

流程标题：`[{externalTicketId}] {summary}`，截断 120 字。`externalTicketId` 由插件生成，只作 Redis 幂等键与标题前缀，不进员工状态卡。

成功回执除数字 `requestId` 外还带顶层 `summary` / `location` 与 `attachmentCount` / `imageCount` / `documentCount`（按实际写入 OA 的分流计数）。员工可见「已提交到 OA」块须回显 `问题：`，工单号只认数字 `requestId`。

### 7.4 `status` / `cancel`

`status`：不带 `confirmationId` 时按人点查。可确认的待确认返回 `PERSON_STATUS`（当前待确认不含草稿正文，但含 `summary` / `location` / 附件计数，加上 `submittedCount` 与最多 5 条 `submitted[].requestId`，以及完整 `recent`）。当前 pending 为 `submitting`/`unknown` 时**顶层码是 `RECONCILIATION_REQUIRED`**（仍带 `pending`），`hintZh` 为人工核对，不要当成 `PERSON_STATUS` 去发确认卡。无 pending 时 `hintZh` 已写好员工可见列表。**不支持按 OA 工单号查询具体进度。** 带 ID 时先读 pending，没有再按 idx 读 ledger。身份不匹配视为 `NOT_FOUND`。会话可以不同（允许 `/new` 后查本人的单）。pending 未过期且非 `submitting`/`unknown` 才返回 `AWAITING_CONFIRMATION`；过期则回收 pending/staging/inbox，ledger 记 `expired`，返回 `CONFIRMATION_EXPIRED`；`submitting`/`unknown` 返回 `RECONCILIATION_REQUIRED`。pending 已不在、只剩 ledger 时，**不要把 ledger 小写 `status` 当工具码**（否则对不上 `hintZh` 表）；归一见 **7.5.2**。成功/失败回执带 `hintZh`（给员工看的短句）；确认卡 / 提交成功仍由 Agent 按模板拼装。

`cancel`：只能取消仍存在且**未过期**的 pending。**跨会话也可以取消**，只认原发送人，不要求回到建单会话。`submitting` / `unknown` 时返回 `RECONCILIATION_REQUIRED`。`expiresAt` 已过则与 `status` / `submit_confirmed` 同一套：`CONFIRMATION_EXPIRED`，回收 pending / staging，ledger 记 `expired`，**不是** `CANCELLED`。宽限过后 key 已被 Redis 回收时，带 ID 的 `cancel` 也是 `CONFIRMATION_EXPIRED`（7.5.2）。未过期取消后带原 ID 的 `status` 返回 **`CANCELLED`**（Redis ledger 仍写小写 `cancelled`）。

`cancel` 删除 staging 与该单 inbox。**同一 OpenClaw 会话**的改稿仍可回灌附件；明确取消后下一轮 `message_received` 丢掉回灌附件。换了 `sessionId` 后取消不把旧图灌进新对话。

### 7.5 错误码

所有 `oa_workflow` 回执都走 `textResult` → `withHintZh`（`src/hints.mjs`）。模型看到的中文是 **`hintZh`**，不是英文 `message`。Agent 规则：有确认卡 / 拦截卡 / 提交成功模板时走模板；**否则原样输出 `hintZh`，不要贴英文 `message`**。不要给每个 JSON 字段加中文注释。`hintZhFor` 先把 `code` 转大写再查表：`HTTP_5xx` 走人工核对，其它 `HTTP_*` 走 OA 拒绝。码不在表里则没有 `hintZh`。

| 码 | 含义 |
| --- | --- |
| `OA_BRIDGE_INACTIVE` | `active=false`，未调 OA。仍先校验 pending / 原发送人 / 过期；不存在则 `NOT_FOUND`，错人则 `SENDER_MISMATCH` |
| `OA_IDENTITY_MAPPING_REQUIRED` | `adapter=off`：跳过适配器且不读映射文件，身份恒为空。现网 `adapter=on` 不用此码。工具 JSON **不**含 `mappingCode` |
| `OA_IDENTITY_NOT_CONFIGURED` | `adapter=on` 但主进程没有 `WECOM_IDENTITY_CORPID` / `WECOM_IDENTITY_SECRET`（宿主机有 txt 不够） |
| `OA_IDENTITY_NOT_FOUND` | `adapter=on` 时未查到人员 id |
| `WECOM_IDENTITY_TOKEN_FAILED` | 自建应用 `gettoken` 被拒（Secret 错或不是那套应用） |
| `WECOM_IDENTITY_OUT_OF_SCOPE` | 发送人不在自建应用可见范围 |
| `WECOM_IDENTITY_ALIGN_MISMATCH` | 明文 userid 与扩展属性「工号」不一致 |
| `WECOM_IDENTITY_INVALID_SENDER` | 可信 SenderId 为空。`hintZh` 与其它身份未开通码相同 |
| `WECOM_OPENUSERID_INVALID` | 加密 userid 无法转换成明文 |
| `OA_IDENTITY_INACTIVE` | 人事状态为离职/解聘/退休/无效，或次账号 |
| `OA_IDENTITY_AMBIGUOUS` | 同一工号查到多人 |
| `OA_IDENTITY_LOOKUP_FAILED` | 企微或人事 HTTP 失败（非上列明确码）。同一请求**不重试**；回执形态见身份适配器说明第 8.1 节 |
| `OA_PROFILE_INCOMPLETE` | 提交前 `getHrmSimpleInfo` 已认证成功，但未得到部门 / 岗位 / 办公地点资源 ID。pending 退回待确认，**未调建单** |
| `OA_PROFILE_LOOKUP_FAILED` | 资料接口未登录（`errorCode=002`）、超时 / 网络 / HTTP 拒绝 / 非 JSON。同一请求不重试；pending 退回待确认，**未调建单**，不要标 `unknown` |
| `UNTRUSTED_CONTEXT` | 非 wecom 或缺少可信发送人/会话 |
| `ALREADY_SUBMITTED` | 该工单号已成功建单。带数字 `requestId` 时 `hintZh` 会写工单号。Agent 有提交成功模板时走模板，`hintZh` 是兜底 |
| `ALREADY_PENDING` | 已有待确认。触发：同一内部幂等号 pending 未过期；或**同一提交人全局已有另一张**待确认单（跨会话也算）。回执带该单的 `confirmationId` / `expiresAt` / `retentionHours` / `sameSession` / `summary` / `location` / 附件计数 / 内部 `externalTicketId`（后者不要展示给员工）。`sameSession=false` 时跨会话 `attach` 也会返回此码。无 `hintZh`，走拦截卡 |
| `ATTACHMENT_LIMIT_EXCEEDED` | 超过单文件 10 MB / 合计 25 MB / 最多 10 个。收件当时就返回，pending 不变 |
| `RECONCILIATION_REQUIRED` | `submitting` / `unknown`，禁止自动重试 |
| `SENDER_MISMATCH` | 非原发送人确认（不要求原会话） |
| `CONFIRMATION_EXPIRED` | 超过 `expiresAt`。`status` / `submit_confirmed` / `cancel` 都是此码（回收 pending，ledger=`expired`）；只剩 ledger 时带 ID 的点查也归一成此码（不再回小写 `expired`） |
| `STAGING_MISSING` | 本机附件暂存丢失，未调 OA；可 cancel 后重新 prepare |
| `NOT_FOUND` | 无此 confirmationId，身份/会话不匹配，或旧 confirmation 已因工单号复用失效 |
| `NOT_CONFIGURED` | 未注入 OA 建单凭据（`OA_API_USER_ID` / `OA_APP_SECRET`）。与 `OA_IDENTITY_NOT_CONFIGURED` 不是同一码 |
| `INVALID_CONFIGURATION` | OA 人员 id / 公钥等配置非法 |
| `TOKEN_NETWORK_ERROR` / `TOKEN_REJECTED` | 换 token 网络失败或被拒 |
| `NETWORK_OUTCOME_UNKNOWN` | 提交过程网络中断，ledger 标 unknown |
| `PARAM_ERROR` | Ecology `doCreateRequest` 明确拒绝（字段 / 附件格式等）。**直接把 OA 的 `code` 回给模型** |
| `OA_CREATE_REJECTED` | OA 没给字符串 code；或 ledger `failed` 经 7.5.2 归一。禁止自动再提交 |
| `OA_ERROR` | `OAClientError` 默认码 |
| `SYSTEM_INNER_ERROR` | OA 内部错误，标 `unknown`，禁止自动重试 |
| `HTTP_400` 等 `HTTP_4xx` | OA HTTP 非 2xx 且非 5xx |
| `HTTP_500` 等 `HTTP_5xx` | OA HTTP 5xx，按对账处理 |
| `INVALID_RESPONSE` | OA 返回不是 JSON |
| `MISSING_REQUEST_ID` | OA 声称成功但没有数字 `requestId`，标 `unknown` |
| `DRAFT_INVALID` | 必填空或超长（`ticketType` / `systemName` / `summary` / `problemDescription` 等） |
| `INVALID_TICKET_TYPE` | 工单类型不是运维支持 / 权限申请 / IT需求 |
| `SYSTEM_NOT_ALLOWED` | 当前类型不允许该 `systemName` |
| `SYSTEM_UNMAPPED` | 系统名对不上 `system-options.json` |
| `INVALID_LOCATION` | `location` 不是智园 / 大磡 / 深汕 / 越南 / 光明 / 泗洪 |
| `LOCATION_MISMATCH` | `location` 与 `systemName` 括号园区不一致 |
| `INVALID_DEMAND_TYPE` | IT 需求类型非法 |
| `INVALID_MONTHLY_HOURS` | 月节约工时不是 ≥0 的数字 |
| `HANDLER_NOT_CONFIGURED` | 该系统未配处理人 |
| `ATTACHMENT_FIELD_NOT_CONFIGURED` | 带了文档但未配 `scfj` |
| `SUPPLEMENT_TOO_LONG` | 最终补充超过 2000 字 |
| `MISSING_CONFIRMATION_ID` | `cancel` / `submit_confirmed` 没带 `confirmationId` |
| `REDIS_UNAVAILABLE` | **预检**连不上 Redis 或 PING 失败；**运行时** Redis 断连（`ECONNREFUSED` 等）或 state store 未注入。不再伪装成 `VALIDATION_ERROR` |
| `WORKFLOW_NOT_CREATEABLE` | 预检：Redis 已通，但流程 602 不在可创建列表 |
| `PREFLIGHT_FAILED` | 预检其它失败（配置损坏、OA 凭据/网络等） |
| `VALIDATION_ERROR` | 未归类的参数失败。底稿校验已拆成上列专用码，不要再默认「请稍后重试」 |

`ATTACHED` / `BUFFERED` / `NO_NEW_ATTACHMENT` 是 `attach` 的**成功**回执（`ok: true`），不在本表；前两个的 `hintZh` 是「📎 已收到 …份图片/文档」。

#### 7.5.1 `hintZh`（员工可见短句）

实现在 `OA_tool/oa-workflow-bridge-redis/src/hints.mjs`。改中文只改这一处，再同步 `Aidy企微回复模板.md` / `AGENTS.md` 里**有独立模板**的块。

| 员工侧 | 哪些 `code` | Agent 怎么做 |
| --- | --- | --- |
| `❌ **还不能提交到 OA**` / 账号还没开通 | `OA_IDENTITY_NOT_FOUND` / `OA_IDENTITY_NOT_CONFIGURED` / `OA_IDENTITY_MAPPING_REQUIRED` / `OA_IDENTITY_INACTIVE`；`WECOM_IDENTITY_TOKEN_FAILED` / `OUT_OF_SCOPE` / `ALIGN_MISMATCH` / `INVALID_SENDER` | 有模板则用模板，或原样 `hintZh` |
| `❌ **确认准备失败**` / 请稍后重试 | `OA_IDENTITY_LOOKUP_FAILED` / `OA_IDENTITY_AMBIGUOUS`；`WECOM_OPENUSERID_INVALID`；`OA_PROFILE_*`；`VALIDATION_ERROR`；`NOT_CONFIGURED`（OA 建单凭据）；`INVALID_CONFIGURATION`；`TOKEN_*`；`UNTRUSTED_CONTEXT`；`REDIS_UNAVAILABLE`；`WORKFLOW_NOT_CREATEABLE`；`PREFLIGHT_FAILED` | 原样 `hintZh` |
| `❌ **确认准备失败**` / OA 拒绝了这张单，不要自动再提交 | `PARAM_ERROR`；`OA_CREATE_REJECTED`；`OA_ERROR`；`FAILED`；`HTTP_4xx` | **原样 `hintZh`**，禁止再 `submit_confirmed` |
| `⚠️ **OA 需要人工核对**` | `RECONCILIATION_REQUIRED`；`NETWORK_OUTCOME_UNKNOWN`；`SYSTEM_INNER_ERROR`；`MISSING_REQUEST_ID`；`INVALID_RESPONSE`；`HTTP_5xx`；`UNKNOWN`；`SUBMITTING` | 有模板则用模板；禁止自动重试 |
| `⏳ **这张确认单已过期**` | `CONFIRMATION_EXPIRED`；小写 `expired` 也会被转大写命中 | 原样 `hintZh` 或过期正文 |
| `✅ **这张单已经提交过**`（可带 `🎫 工单号`） | `ALREADY_SUBMITTED` | **优先**走「已提交到 OA」模板；无模板才用这条 `hintZh` |
| 工单类型和所属系统对不上 | `SYSTEM_NOT_ALLOWED` | 原样 `hintZh`，让模型回去再问，不要装成 OA 挂了 |
| 工单类型无效 | `INVALID_TICKET_TYPE` | 原样 `hintZh` |
| 必填不全或超长 | `DRAFT_INVALID` | 原样 `hintZh`，不要原样重试 |
| 地点非法 / 地点与系统不一致 | `INVALID_LOCATION` / `LOCATION_MISMATCH` | 原样 `hintZh` |
| IT 需求类型 / 月节约工时非法 | `INVALID_DEMAND_TYPE` / `INVALID_MONTHLY_HOURS` | 原样 `hintZh` |
| 该系统没配处理人 | `HANDLER_NOT_CONFIGURED` | 原样 `hintZh`，联系管理员 |
| 未配文档附件字段 | `ATTACHMENT_FIELD_NOT_CONFIGURED` | 原样 `hintZh`：去掉文档或联系管理员 |
| 系统还不能提交到 OA | `SYSTEM_UNMAPPED` | 原样 `hintZh` |
| 补充超过 2000 字 | `SUPPLEMENT_TOO_LONG` | 原样 `hintZh` |
| 缺少确认号 | `MISSING_CONFIRMATION_ID` | 原样 `hintZh`：先 `status` 再确认或取消 |
| 附件暂存丢失 / 非原提交人 / 找不到确认单 | `STAGING_MISSING` / `SENDER_MISMATCH` / `NOT_FOUND` | 原样 `hintZh` |
| 没有检测到新文件 / 附件超限 | `NO_NEW_ATTACHMENT` / `ATTACHMENT_LIMIT_EXCEEDED` | 原样 `hintZh` |
| `ℹ️ **已确认，但还不能创建 OA 工单**` | `OA_BRIDGE_INACTIVE` | 有模板则用模板 |

确认卡（`AWAITING_CONFIRMATION`）、拦截卡（`ALREADY_PENDING`）、取消（`CANCELLED`）、提交成功（`SUBMITTED`）**故意不写** `hintZh`。

#### 7.5.2 `status` 带 `confirmationId`：ledger 状态 → 工具码

Redis ledger JSON 的 `status` 仍是小写（`submitted` / `cancelled` / `expired` / `failed` / `unknown` / `submitting`）。pending 已不在时，工具回执 `code` 必须收成约定码，`hintZh` 才能命中：

| ledger `status` | 回执 `code` | `hintZh` |
| --- | --- | --- |
| `expired` | `CONFIRMATION_EXPIRED` | 确认单已过期 |
| `unknown` / `submitting` | `RECONCILIATION_REQUIRED` | 人工核对 |
| `failed` | `OA_CREATE_REJECTED` | OA 拒绝，不要自动再提交 |
| `cancelled` | `CANCELLED` | 无（走取消模板） |
| `submitted` | `ALREADY_SUBMITTED` | 已提交过 / 或走成功模板 |
| `awaiting_confirmation` | `AWAITING_CONFIRMATION` | 无（走确认卡） |

不带 `confirmationId` 时：pending 仍在且为 `unknown`/`submitting`，顶层同样收成 `RECONCILIATION_REQUIRED`（不要停在 `PERSON_STATUS`）。

不要再把 `expired` / `cancelled` 当工具 `code` 回给模型。

### 7.6 `system-options.json`（系统名 → OA 选项 ID）

`prepare` 的 `systemName` 必须与下表左侧 **完全一致**（含括号与地点）。ID 同时用于 `wtlx` / `szxt` / `szxtxq`，按工单类型选字段。电脑/打印机/网络问题另传 `location`（`智园` / `大磡` / `深汕` / `越南` / `光明` / `泗洪`）；不传时插件从系统名括号兑底。确认卡读回执 `location`，不要解析 `systemName`。这与提交时人事 `bgdd` 不是同一个字段。

| 系统名（`systemName`） | ID |
| --- | --- |
| OA系统 | 2 |
| 企业微信 | 3 |
| ERP（金蝶）系统 | 4 |
| 邮箱系统（国内） | 5 |
| MES系统（大磡） | 6 |
| MES系统（深汕） | 7 |
| MES系统（越南B部） | 8 |
| 文件管理系统（国内） | 9 |
| 电脑/打印机/网络问题（智园） | 10 |
| 电脑/打印机/网络问题（大磡） | 11 |
| 电脑/打印机/网络问题（深汕） | 12 |
| 电脑/打印机/网络问题（越南） | 13 |
| 电脑/打印机/网络问题（光明） | 14 |
| 电脑/打印机/网络问题（泗洪） | 15 |
| OA开发支持 | 16 |
| 其他 | 17 |
| ERP开发支持 | 18 |
| 北森招聘系统 | 19 |
| 文件管理系统（越南） | 20 |
| 邮箱系统（越南） | 21 |
| MES系统（越南C部） | 23 |
| 法大大电子签平台 | 24 |

---

## 8. 测试与预检

### 8.1 单元测试

```powershell
cd .\oa-workflow-bridge-redis
npm test
```

覆盖：字段映射、OA 客户端（含网络中断 → unknown）、认证 `getHrmSimpleInfo`（申请人 Header、`002` → `OA_PROFILE_LOOKUP_FAILED`）、按 key 的 Redis 状态读写、工具确认/幂等/附件追加不覆盖、过期 cancel 为 `CONFIRMATION_EXPIRED`（不是 `CANCELLED`）、staging 缺失与 orphan GC、inactive 不调 OA 但仍校验 confirmationId、secret-resolver **只测环境变量**（无映射目录 / 无 DPAPI / 无路径穿越用例）、工单号复用后旧 confirmation 不串单且旧 pending 删除、预检 Redis PING、inbound 会话键 / `/new`（`inbound-media.test.mjs`）、attach / 跨会话 / inbox TTL（`attach.test.mjs`）、hintZh（`hints.test.mjs`）、`AGENTS.md` ↔ `ticket-type-systems.json` 一致性（`workspace-sync.test.mjs`）、日志脱敏。

### 8.2 只读预检（Redis + OA）

Gateway Up，且已注入 `OA_REDIS_URL` 与 OA 凭据后：

```bash
# Docker
docker exec -it aidy-gateway node \
  /home/node/.openclaw/extensions/oa-workflow-bridge-redis/scripts/readonly-preflight.mjs
```

脚本会先 **PING Redis**，再调用 `getCreateWorkflowList`（**不建单**）。预检结束会关闭本次 Redis 连接。

成功示例：

```json
{"ok":true,"code":"READ_ONLY_PREFLIGHT_PASSED","workflowId":602,"workflowName":"...","redis":"PONG","redisKeyPrefix":"oa-workflow-bridge"}
```

Redis 不可达或 PING 失败（exit 1），**不会**标为通过，此时尚未调用 OA：

```json
{"ok":false,"code":"REDIS_UNAVAILABLE","message":"..."}
```

Redis 已通但流程 602 不可创建（exit 2）：`WORKFLOW_NOT_CREATEABLE`。OA 凭据/网络等其它失败：`PREFLIGHT_FAILED` 或 OA 客户端错误码（如 `NOT_CONFIGURED`）。

Windows 原生（在插件目录）：

```powershell
node .\scripts\readonly-preflight.mjs
```

### 8.3 Redis 连通性手动检查

```bash
redis-cli -u "$OA_REDIS_URL" PING
# 应返回 PONG

# 用已知工单号 / confirmationId 点查，不要对生产做 KEYS / SCAN
redis-cli -u "$OA_REDIS_URL" GET 'oa-workflow-bridge:ledger:IT-20260805-121500-A1B2'
redis-cli -u "$OA_REDIS_URL" GET 'oa-workflow-bridge:pending:OA-MXXXXX-XXXXXXXX'
redis-cli -u "$OA_REDIS_URL" GET 'oa-workflow-bridge:idx:confirmation:OA-MXXXXX-XXXXXXXX'
```

前缀以 `bridge-config.json` 的 `redis.keyPrefix` 为准。不要手工编辑这些 JSON、不要批量 DEL ledger。

本机测试要一次性清掉全部业务 key：见 [../Redis 独立实例部署手册.md](../Redis%20独立实例部署手册.md) **9.4**（`FLUSHDB`）。生产不要做。

---

## 9. 配置注意与回滚

`plugins.allow` / `plugins.load.paths` / `plugins.entries` 一律使用 `oa-workflow-bridge-redis`。

若旧配置里还留着 `oa-workflow-bridge`（本地 `state.json` 方案），**删掉**后再重启 Gateway。两个 id 都会注册工具 `oa_workflow`，同时加载会冲突。

**不停 OA、只关闭实时提交：** `active=false` 并移出 `oa_workflow` 白名单。pending / ledger 仍留在 Redis。

文件版 `oa-workflow-bridge`（`state.json`）已废弃。本仓库**不维护**切回文件版的步骤。生产只走 Redis 版。历史上已提交的 OA 单仍在 OA 侧。

**不要**把文件版 `state.json` dump 进 Redis。key 模型是按工单拆开的，不是一份大 JSON。也不要把 Redis dump 拷进 `state.json`。

---

## 10. 正式切换门槛

预切流已完成：`alsoAllow` 含 `oa_workflow`，workspace 规则按两阶段确认、**按 `active=true` 执行**。仓库样例 `bridge-config.json` 亦为 `true`。现网是否调用 `doCreateRequest` 以 **实际加载的** `~/aidy/extensions/oa-workflow-bridge-redis/bridge-config.json` 为准。

下列运维项用于核对真正建单。**未按第 4.2 节给两包装 `redis` 时，`prepare` 就会失败，到不了建单**（2026-09-02 现网曾发生，现已装齐）。OA 已确认文档附件字段为 `scfj`；实际加载的 json 若仍为空，**带文档**必须拒绝。图片走 `wtxqmskftp` 内嵌，不依赖该配置：

- [x] 现网 `tools.alsoAllow`（全局 + `itservicedeskagent`）已含 `oa_workflow`；两处一致
- [ ] 确认就是要跑 **单实例 Redis 版**，而不是文件版
- [ ] Redis 持久化（AOF）与密码已配置，内存策略 `noeviction`，Gateway 可稳定连接
- [ ] Docker：`OPENCLAW_STATE_DIR=/home/node/.openclaw`，重启后 staging 仍在；数据不在 `/mnt/c`
- [x] Docker：已按第 4.2 节用官方镜像给**两包**装依赖（桥接 `node_modules/redis` / `jpeg-js` / `pngjs`，适配器 `node_modules/redis` 都存在）；宿主未装 apt npm
- [ ] 主进程已注入 `OA_REDIS_URL`（第 5.5 节，只判断有无，不打印）
- [x] 主进程已注入 `WECOM_IDENTITY_CORPID` / `WECOM_IDENTITY_SECRET`（宿主机有 txt **不够**；须 compose 挂载 + entrypoint export + `down && up`。校验见身份适配器说明 10.7）
- [ ] `npm test` 通过（Windows 原生 / 开发机；Docker 路径不要求在宿主跑）
- [ ] OA AppSecret 已轮换，只读预检通过（含 `"redis":"PONG"`）
- [ ] 至少一名**非接口账号**测试用户：`SUBMITTED` 后 OA 里该单出现在该员工账号下（Header `userid` 与 `xqsqr` 都是申请人）
- [ ] 流程 602 字段、附件字段、路由责任人核对正确
- [ ] 沙箱文本 / 图片 / 文件测试通过：图片出现在 `wtxqmskftp`，文档出现在 `scfj`；空配置时不要带文档报成功
- [ ] 企微私聊、群聊、Gateway 重启回归通过
- [ ] 待确认后补一张图：回「图片已收到」，日志有 `attach attached added=1`，无 wecom `before_prompt_build` blocked
- [ ] Docker：`OA_API_USER_ID` / `OA_APP_SECRET` / `WECOM_IDENTITY_CORPID` / `WECOM_IDENTITY_SECRET` 已注入，只读预检不再报 PowerShell
- [ ] `plugins.allow` 中 **没有** `oa-workflow-bridge`
- [ ] `oa-workflow-bridge-redis` 与 `wecom-openclaw-plugin` 的 `entries` 都有 `hooks.allowConversationAccess: true`
- [ ] 有回滚方案（`active=false` 并移出工具白名单）。**不要**切回文件版 `oa-workflow-bridge`
- [x] 智能表格观察期已结束；规则包禁止 `wecom_mcp`。现网旁路已清；若 docker logs 再出现 `smartsheet_get_records`，按第 11 节核 `~/aidy` 是否被旧文件覆盖

---

## 11. 排错

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 插件未出现在 list | 不在 `plugins.allow` 或 path 错误 | 补 allow / paths，确认是 `oa-workflow-bridge-redis`，重启 Gateway |
| `plugin path not found: .../oa-workflow-bridge`、Restarting (78) | json 仍指向文件版目录 | allow / paths / entries **全部**改为 `oa-workflow-bridge-redis`；不要两个 id 同时留。`compose down && up`。Restarting 时不要 exec |
| 日志是 `loaded in inactive-by-default mode` | 实际加载了文件版 | 改 paths / allow 为 Redis 版 id |
| 工具注册冲突 | allow 中仍有旧 id `oa-workflow-bridge` | **只保留** `oa-workflow-bridge-redis` |
| 员工「确认准备失败 / 后台确认服务异常」，工单号已有但无待确认 | 插件已 loaded，但 Redis **客户端包**未装（备份恢复或只装桥接时会再发） | 日志必有 `Cannot find package 'redis'`。按第 4.2 节给桥接**和**身份适配器都装依赖，再 `down && up`。不要先去查 OA HTTP 或重新授权企微文档 |
| `Redis init failed: Cannot find package 'redis'` | 未按 4.2 装依赖，或备份恢复丢掉了 `node_modules` | 同上。`loaded (Redis state)` **不能**证明 `import('redis')` 已成功 |
| 日志 `Cannot find module 'jpeg-js'`（Require stack 含 `image-embed.mjs`）；`listening` 只有 wecom 插件 | 2026-09-08 桥接增加图片压缩依赖后，现网 `node_modules` 未重装 | 企微能聊、`oa_workflow` 未注册。按第 4.2 节重装桥接（核对 `jpeg-js` / `pngjs`），Gateway `down && up`。不要先当模型或企微故障 |
| Redis init failed（无 `Cannot find package`） | URL 错误、Redis 未启动、网络不通 | 检查 `OA_REDIS_URL`、`redis-cli PING`；包已装时恢复后重试即可，不必为「第一次失败」重启 Gateway |
| docker logs 出现 `smartsheet_get_records` / `wecom_mcp` | `~/aidy` 的 `alsoAllow` 被旧配置覆盖，或 workspace 仍是旧智能表格规则 | 与缺 `redis` 包是两件事。现网规则包已禁该工具。核对见 `../WeCom 通道插件接入手册.md` 9.2。errcode `851014` 不要当成 OA 故障 |
| 日志里主机是 `127.0.0.1` | 仍在用 `bridge-config.json` 兜底，entrypoint 未注入 | 第 5.5.2.3 节；容器内不要用 `127.0.0.1` |
| `NOAUTH` / `WRONGPASS` | Gateway 与 Redis 两边密码不一致 | 见 `../Redis 独立实例部署手册.md` 密码分边 |
| 预检 `REDIS_UNAVAILABLE` | 容器内连不上 Redis，或 PING 失败 | 查 `OA_REDIS_URL`、独立 Redis 是否在跑、是否误用 `127.0.0.1` |
| 运行时 `oa_workflow` 回 `REDIS_UNAVAILABLE` | Redis 断连或 state store 未注入。以前会伪装成 `VALIDATION_ERROR` | 先查独立 Redis / `OA_REDIS_URL`。回执带「请稍后重试」`hintZh` |
| `PARAM_ERROR` / `OA_CREATE_REJECTED` / `HTTP_4xx` | Ecology 明确拒绝或 HTTP 4xx | 员工侧「OA 拒绝了这张单，不要自动再提交」。**禁止**再 `submit_confirmed` |
| `HTTP_5xx` / `SYSTEM_INNER_ERROR` / `MISSING_REQUEST_ID` | OA 结果不明 | 「OA 需要人工核对」。ledger 可能是 `unknown`。禁止自动重试 |
| `SYSTEM_NOT_ALLOWED` / `INVALID_TICKET_TYPE` / `DRAFT_INVALID` | 模型底稿与规则清单对不上 | 原样 `hintZh` 让模型改 draft，不要当成 OA 挂了 |
| `HANDLER_NOT_CONFIGURED` / `ATTACHMENT_FIELD_NOT_CONFIGURED` / `SYSTEM_UNMAPPED` | 插件配置缺处理人或附件字段 | 联系管理员；不要让员工「稍后重试」 |
| `status` 带 ID 得到小写 `expired` / `cancelled` | 旧插件把 ledger 状态当 `code` | 现网须同步本仓库 2026-09-14 之后的桥接（7.5.2）。新回执是 `CONFIRMATION_EXPIRED` / `CANCELLED` |
| 预检 `WORKFLOW_NOT_CREATEABLE` | Redis 已通，流程 602 对当前账号不可创建 | 核对 OA 权限与 `workflowId` |
| `OA_BRIDGE_INACTIVE` | 现网加载的 `bridge-config.json` 为 `active=false` | 未调 OA。规则包按 `true` 执行时不应长期出现；不要改走智能表格 |
| 单据出现在接口账号名下 | `doCreateRequest` Header `userid` 仍加密了 `OA_API_USER_ID` | 确认已部署本仓库 2026-09-03 之后的桥接：Header 必须 RSA 加密 `pending.oaRequesterId`。`xqsqr` 填对不够 |
| `NOT_CONFIGURED` | 未注入 **OA** 凭据（`OA_API_USER_ID` / `OA_APP_SECRET`） | 与 `OA_IDENTITY_NOT_CONFIGURED` 不是同一码 |
| `OA_IDENTITY_NOT_CONFIGURED` | 转换凭据未进主进程 | 第 5.5.1 / 5.5.2；校验见身份适配器说明 10.7。只 `restart` 不够 |
| `OA_IDENTITY_NOT_FOUND` | 适配器未查到人员 id | 核对自建应用可见范围、工号对齐、人事接口 |
| `OA_PROFILE_INCOMPLETE` / `OA_PROFILE_LOOKUP_FAILED` | 提交前申请人资料现查失败 | 未调建单。pending 仍在，可再确认。匿名 GET 现网是 `002`，必须带 token。核对认证后的 `simpleInfo.departmentid` / `jobtitle` / `locationid` |
| 企微已落盘、日志 `remembered N inbound`，员工仍看到「没有检测到新文件」 | `attach` 回了 `NO_NEW_ATTACHMENT`：hook 缓冲键与工具 ctx 不一致，或 wecom 的 `before_prompt_build` 被挡住 | 现网须同步本仓库 2026-09-10 之后的桥接（3.6 会话键候选）。两个插件都开 `hooks.allowConversationAccess`。成功日志为 `attach attached added=1`，不要只看 `remembered` |
| `WECOM_IDENTITY_TOKEN_FAILED` | 自建应用 Secret 错 | 不要复用 BotSecret；换该应用 corpsecret 后 `down && up` |
| `WECOM_IDENTITY_OUT_OF_SCOPE` | 测号不在自建应用可见范围 | 把测试人加进**该自建应用**可见范围（不是机器人范围） |
| `WECOM_IDENTITY_ALIGN_MISMATCH` | 明文 userid ≠ 扩展属性「工号」 | fail-closed，不能当 `xqsqr` |
| docker logs grep 不到 `oa_workflow` / `OA_IDENTITY_*` | 插件 tool 回执不写 docker stdout | **预期**。查会话 jsonl，见身份适配器说明 10.7 |
| 员工「还不能提交到 OA」且页脚「身份待核验」 | 两件事 | 页脚缺姓名是公开版通道缺省；是否映射只认 `oa_workflow` 的 `code` |
| `ALREADY_PENDING` | 该工单号已有待确认 | 先 `status`/`cancel`，不要再 prepare |
| `SENDER_MISMATCH` | 不是原发送人 | 必须同一企微发送人确认；不要求原 OpenClaw 会话 |
| `UNTRUSTED_CONTEXT` | 非 wecom 或缺少发送人/会话 | 先跑通企微插件；群聊用实际发送人 |
| pending 丢失 | Redis 无 AOF、误删 key | 开启持久化；ledger 永久 key 勿手动 DEL |
| `STAGING_MISSING` | 本机附件暂存目录被删，或未设 `OPENCLAW_STATE_DIR` | 取消后重新 prepare；不要标成 unknown |
| `CONFIRMATION_EXPIRED` | 超过 `pendingTtlHours`（`status` / `submit_confirmed` / `cancel` 都是此码） | 直接重新 prepare，不要再 cancel |
| `RECONCILIATION_REQUIRED` | ledger 为 submitting / unknown | **禁止**自动再 submit；人工对账步骤见 [OpenClaw Gateway Docker 运维手册.md](../OpenClaw%20Gateway%20Docker%20运维手册.md) **12.5** |
| `status(旧 confirmationId)` 为 `NOT_FOUND` | 同一工单号已重新 prepare | 预期；用新 confirmationId 查询 |
| `NOT_CONFIGURED` / 缺 OA 凭据（Docker） | 未注入 `OA_API_USER_ID` / `OA_APP_SECRET`。插件**不会**回退 DPAPI | 按第 5.5、第 6 节补 secret / entrypoint 后 `down && up` |
| `docker exec` 里 `OA_REDIS_URL` 为空 | exec 不跑 entrypoint | 查主进程 environ（第 5.5.2.3 节），不要据此判失败 |
| `Command 'npm' not found`（宿主） | WSL / Linux 服务器默认没有 Node | **不要** `apt install npm`。按第 4.2 节用官方镜像安装 |
| `Cannot find package 'redis'` / `Cannot find module 'jpeg-js'` / 插件加载失败 | 未装依赖，或 `node_modules` 被清 / 备份未含；或只装了桥接没装适配器；或只装了旧的 `redis`、未装 `jpeg-js` / `pngjs` | 按第 4.2 节给**两包**重装后再 `down && up` |
| npm `EACCES` / Permission denied | 挂载目录不是 uid 1000 可写 | 先 `sudo chown -R 1000:1000 ~/aidy/extensions` 再跑 4.2 |
| `compose ps` 的 IMAGE 是 `ghcr.io/openclaw/openclaw:2026.9.2` 或 `:latest`，手册命令却在拉 `openclaw/openclaw:latest` | 本机没有 Hub 名；Docker 按仓库名匹配 | 用第 4.2 节与 **IMAGE 列同名**的那一段，不要 `docker pull openclaw/openclaw:latest`；或先 `docker tag` 再走「Hub 名」 |
| `docker images` 没有 `openclaw/openclaw` | Gateway 用的是 GHCR 名（方案 A 未 tag，或 yml 已写 ghcr） | 不是缺镜像。按第 4.2 节「GHCR 名」安装 |

---

## 12. 禁止事项

- 不要在 `plugins.allow` 中写旧 id `oa-workflow-bridge`
- 不要用本插件做多 Gateway / 多副本（以后用 SQL 存文件）
- 不要把 pending 的 Redis TTL 当过期判定——判定只看 JSON `expiresAt`，TTL 只是宽限后的兜底回收（见 3.3）
- 不要把 `SUBMITTED` 理解成 Redis / 会话 jsonl / `media/inbound` / `idmap` 全空（见 3.3.1）。不要手工 `DEL ledger` 或 `idmap`「做清理」
- 不要给 `ledger` / `idx` 设 Redis `EX`/`TTL`（ledger 被回收会破坏幂等）
- 不要把附件 base64 写入 Redis
- 不要对 `{prefix}:pending:*` / `{prefix}:ledger:*` 做 `SCAN`/`KEYS` 当业务读写或批量 DEL
- 不要在生产 Redis 使用 `FLUSHDB` / `FLUSHALL`（本机测试清空见 Redis 手册 9.4）
- 不要把 Redis 密码写入 `openclaw.json` 明文或 compose `environment:`（用 entrypoint + secrets）
- 不要把 OA AppSecret、API User ID 写入 `openclaw.json`
- 不要把身份映射文件挂进 workspace 或 `.openclaw`
- 不要用接口账号人员 id 作为 `doCreateRequest` 的 Header `userid`（必须 RSA 加密申请人人员 id，否则单据落到接口账号头上）
- 不要把 Redis dump 拷进文件版 `state.json`，也不要把 `state.json` 整份写入 Redis
- 不要手工编辑生产 ledger（会破坏幂等）
- 不要在 `unknown` 状态自动重试 submit
- 不要对 `PARAM_ERROR` / `OA_CREATE_REJECTED` / `HTTP_4xx` 自动再 `submit_confirmed`
- 不要把工具回执英文 `message` 发给员工（无模板时原样输出 `hintZh`，见 7.5）
- 不要再配 `OA_SECRET_SOURCE`、映射目录或 PowerShell / DPAPI 密钥脚本；`secret-resolver.mjs` 已不读这些路径
- 不要在 `active=false` 时改 AGENTS.md 声称 OA 已通
- 不要按姓名模糊匹配 OA 申请人
- 不要在 `attachmentFieldName` 为空时带附件报成功
- 不要只在宿主机写 `wecom_identity_*.txt` 却不改 compose / entrypoint（会 `OA_IDENTITY_NOT_CONFIGURED`）
- 不要用安装手册里尚无 `WECOM_IDENTITY_*` 的 entrypoint 整段覆盖已接 OA 的 `entrypoint.sh`（工位 6.4.2 / Linux 第 7 节第一份都会丢掉转换凭据）
- 不要用 `docker logs | grep OA_IDENTITY` 判断没调 `prepare`（回执在会话 jsonl）
- 不要把 `~/aidy/secrets/` 提交到 git
- 不要在 Gateway 容器内把 Redis 写成 `127.0.0.1`
- 不要在 Docker 宿主用 `apt install npm` 或另装 Node 来装本插件依赖
- 不要把 `npm install` 写进 `docker-compose.yml` 或 `entrypoint.sh`
- 不要在 Gateway 启动后再 `docker exec` 补装依赖（首次加载已缺模块）
- 不要只给桥接装 `redis`、不给 `wecom-oa-identity-adapter` 装（miss 路径同样 `Cannot find package 'redis'`）
- 不要用本机 `docker images` 里没有的仓库名跑插件 `npm install`（常见：本地只有 `ghcr.io/openclaw/openclaw:latest` 却写 `openclaw/openclaw:latest`）

---

## 13. 相关文档

| 文档 | 内容 |
| --- | --- |
| `../Aidy 现网加固与演进全景.md` | OA 主路径、切入范围、各层 I/O |
| [OA插件与Redis链路.md](OA插件与Redis链路.md) | 节点图、hop、五 action 点查哪些 key |
| [工单会话隔离与资料回收场景.md](工单会话隔离与资料回收场景.md) | 同一人全局一张待确认；跨会话只能确认或取消；24h 回收 |
| `企微到OA身份与数据流.md` | appid / 调用者 / 申请人、通道加密 userid、Redis `idmap` |
| [身份适配器说明.md](身份适配器说明.md) | 转换层：独立包已验证；Redis `idmap`；第 10.7 节查会话回执 |
| `Ecology 流程创建 API 说明.md` | applytoken / getHrmSimpleInfo / doCreateRequest / 字段表 |
| `system-options.json` / `system-handlers.json` / `ticket-type-systems.json` | 系统名 → 选项 ID / 处理人 id / 类型白名单 |
| `../Redis 独立实例部署手册.md` | 独立 Redis、连接契约、备份轮换；Gateway compose / entrypoint 见本文 5.5 |
| `../外部系统 Tool 插件设计规范.md` | 插件形式：固定 action、可信上下文、两阶段确认 |
| `../OpenClaw Gateway WSL2-Docker 安装手册.md` | 工位 WSL2 Gateway Docker 全链路 |
| `../OpenClaw Gateway Linux 服务器安装手册.md` | Linux 服务器 Gateway 安装（独立完整路径） |
| `../WeCom 通道插件接入手册.md` | 企微通道与 wecom_mcp |
| `../OpenClaw Gateway Docker 运维手册.md` | 日常启停、备份、巡检；**10.4** 两处 inbound 原件 24 小时 cron |
| `openclaw/OA_WORKFLOW_CONTRACT.md` | OA 流程契约 |
| [第三方凭据注入与配置中心演进.md](../第三方凭据注入与配置中心演进.md) | 凭据与安全边界 |
| [OpenClaw Plugins](https://docs.openclaw.ai/plugins) | 官方插件机制、allow / load.paths |
| [OpenClaw Building plugins](https://docs.openclaw.ai/plugins/building-plugins) | Tool 插件开发 |
| [OpenClaw Plugin hooks](https://docs.openclaw.ai/plugins/hooks) | `gateway_stop` 清理连接 |
| [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/) | `/run/secrets/` 注入 |
| [Ecology API 文档](https://e-cloudstore.com/ec/api/applist/index.html#/) | OA 接口参考 |
