# OA Workflow Bridge 接入手册

适用对象：部署和维护 OA 桥接插件 **`oa-workflow-bridge`** 的工程师。按 **单 Gateway、一个业务** 部署。

本文是插件的唯一正文：存储、工具契约、错误码、部署、预检、排错、禁止事项都在这里。MySQL 怎么准备见 [../MySQL 数据库准备.md](../MySQL%20数据库准备.md)。OA 接口与字段见 [Ecology 流程创建 API 说明.md](Ecology%20流程创建%20API%20说明.md)。身份转换细节见 [身份适配器说明.md](身份适配器说明.md)。

| 项 | 现状 |
| --- | --- |
| 插件目录 / id | `OA_tool/oa-workflow-bridge/`，id `oa-workflow-bridge`，注册工具 `oa_workflow` |
| 状态存储 | 独立机器上的 **MySQL**：`oa_ticket` / `oa_inbox` / `oa_identity` 三张表 |
| 身份转换 | 插件内 `src/identity/`（企微 `user/get` → 工号 → OA 人员 id），缓存在 `oa_identity` |
| 并发锁 | 进程内队列（`withStateLock`）+ 库层唯一约束兜底「同一人一张待确认」 |
| 附件 | 本机 staging 目录，字节不进库、不进模型 |
| 实时建单 | `bridge-config.json` 的 `active=true` 才调 `doCreateRequest` |
| 流转 | `isnextflow` 现网 `"0"`：建单成功但停在申请人节点；项目可用后改 `"1"` 并重启 |
| npm 依赖 | `mysql2`、`jpeg-js`、`pngjs`（见 4.2） |

不要水平扩展：两个 Gateway 连同一个库，锁仍是各进程自己的队列，附件也在各自本地盘。

---

## 1. 架构

```text
员工企微 ──► wecom 通道（加密 userid，附件落盘 media/inbound）
               │
               ▼
         xA Agent（AGENTS.md 规则，只调 oa_workflow）
               │ prepare / attach / submit_confirmed / status / cancel
               ▼
         oa-workflow-bridge
           ├── src/identity/   企微 user/get → 工号 → getHrmUserInfoWithPage → OA 人员 id
           ├── MySQL           oa_ticket / oa_inbox / oa_identity
           ├── 本机 staging     {OPENCLAW_STATE_DIR}/oa-workflow-bridge/staging/
           └── Ecology         applytoken → getHrmSimpleInfo → doCreateRequest（流程 602）
```

模型只整理文字事实（类型、系统、摘要、描述）；插件负责身份、确认态、幂等、附件、处理人、建单。模型不传人员 id、OA 字段名、流程 id、内部工单号。

员工可见「已建单」只认：回执 `SUBMITTED` 且有**数字** `requestId`。

### 1.1 代码结构

| 文件 | 职责 |
| --- | --- |
| `index.mjs` | 插件入口：连库建表、注册工具、媒体 hook、`/new` / `session_end` 清 inbox、每 10 分钟到期回收 |
| `src/tool.mjs` | 工具 schema、分发、错误码归一 |
| `src/actions/*.mjs` | 五个 action，各一个文件；`common.mjs` 放共用的冲突判定 / 回执字段 |
| `src/store.mjs` | 三张表的读写、进程锁、staging 路径、到期回收 |
| `src/db.mjs` | MySQL 连接池、建表语句、只读表检查 |
| `src/config.mjs` | `bridge-config.json`、`systems.json` 加载与校验 |
| `src/mapping.mjs` | draft 校验（含未命中兜底）、内部幂等号、OA 请求体 |
| `src/oa-client.mjs` / `src/hrm-profile.mjs` | Ecology token、建单、提交前资料现查 |
| `src/identity/` | 企微与人事点查、`oa_identity` 缓存 |
| `src/inbound-media.mjs` / `src/attachments.mjs` / `src/image-embed.mjs` | 收集 inbound 路径、暂存、图片压缩 / 文档 base64 |
| `src/hints.mjs` | 回执 `hintZh`（员工可见短句） |
| `systems.json` | 所属系统 → OA 选项 ID、处理人 id、允许的工单类型（唯一维护处） |

---

## 2. 数据存储

### 2.1 三张表

| 表 | 一行是什么 | 主要列 | 回收 |
| --- | --- | --- | --- |
| `oa_ticket` | 一张确认单 | `confirmation_id`（PK）、`external_ticket_id`、`sender_code`、`session_code`、`status`、`active_sender`（唯一）、`draft_json`、`staged_json`、`request_id`、`error_code`、`expires_at` | 不删。终态时清空 `draft_json` / `staged_json`，只留台账 |
| `oa_inbox` | 一个人 prepare 之前 `attach` 的附件清单 | `sender_code`（PK）、`session_code`、`items_json`、`expires_at` | 30 分钟到期；`/new`、`session_end`、换会话、被 prepare 认领时立刻删 |
| `oa_identity` | 发送人 → OA 人员 id 缓存 | `mapping_code`（PK）、`oa_user_id`、`miss_code`、`expires_at` | 命中 24 小时；查不到的负缓存 10 分钟 |

- `sender_code` / `mapping_code` = SHA-256(企微加密 SenderId) 截前 24 位；`session_code` 同理来自 OpenClaw `sessionId`（无则 `sessionKey`）。原始 SenderId、明文 userid、工号**不落库**。
- 时间都是毫秒 BIGINT，不依赖 MySQL 时区。JSON 存 TEXT，由插件序列化。
- 建表语句在 `src/db.mjs`。插件启动时 `CREATE TABLE IF NOT EXISTS`，库本身由 DBA 先建（见 MySQL 准备文档）。

### 2.2 工单状态

```text
prepare ──► awaiting_confirmation ──submit──► submitting ──OA 成功──► submitted
                 │    ▲                           │
                 │    └── 资料 / 附件没备齐（未调 OA）┘
                 │                                ├── OA 明确拒绝 ──► failed
                 │                                └── 结果不明 ──────► unknown（人工对账）
                 ├── cancel ──► cancelled
                 └── 满 24 小时 ──► expired
```

- 占「同一人全局一张待确认」名额的状态：`awaiting_confirmation`、`submitting`、`unknown`。此时 `active_sender = sender_code`，唯一索引在库层面保证一人一张；其余状态 `active_sender = NULL`。
- 进入 `submitted` / `cancelled` / `expired` / `failed` 时清空描述与附件清单（员工资料随之删除），保留单号、状态、时间供对账。
- 同一内部幂等号（`external_ticket_id`）可能有多行：取消 / 过期后同一条消息可再 prepare。幂等判断看最新一行：`submitted` → `ALREADY_SUBMITTED`；`submitting` / `unknown` → `RECONCILIATION_REQUIRED`；仍有效的待确认 → `ALREADY_PENDING`。

### 2.3 到期回收

过期判定只看 `expires_at`。回收有两处，结果一样：

1. 任一工具调用碰到已到期的单，当场记 `expired`、删该会话 inbox 与本单 staging。
2. `index.mjs` 每 10 分钟（工具调用后也顺带，最多每分钟一次）跑 `cleanupExpired`：到期待确认单记 `expired`；删过期 `oa_inbox` / `oa_identity` 行；回收孤儿 staging 目录（刚建 10 分钟内的目录先放过，避免误删并发 prepare 的半成品）。

`submitting` / `unknown` 的单不在定时回收里过期，留给人工对账。

### 2.4 并发

`src/store.mjs` 的 `withStateLock` 是进程内 Promise 队列（可重入）。prepare 的「读 inbox → 搬附件 → 写工单 → 删 inbox」、attach 的「认领单还是写 inbox」、cancel / 过期删 inbox，都在锁内，互相不会吞附件。`submit_confirmed` 在锁内标 `submitting` 并登记进行中；并发的第二次确认等第一次结果，回 `ALREADY_SUBMITTED`，不会二次调 OA。附件编码与 OA HTTP 在锁外。

### 2.5 附件

- 单文件 10 MB、合计 25 MB、最多 10 个，在 `prepare` / `attach` 收件当时校验（`ATTACHMENT_LIMIT_EXCEEDED`）。
- 源文件必须在 `{stateDir}/media/inbound/` 或 `{stateDir}/workspace/media/inbound/`（`realpath` 校验）。插件不扫描目录，只认本轮 hook / 工具 ctx 给的路径。
- 暂存：`{OPENCLAW_STATE_DIR}/oa-workflow-bridge/staging/{confirmationId}/`；建单前 inbox：同级 `staging/inbox-{sender}-{session}/`。
- 提交时图片压缩成 JPEG 嵌进 `wtxqmskftp`，文档转 `base64:` 写 `scfj`。base64 不进库、不进模型。
- 附件缓冲按「提交人 + 会话」隔离。hook 与工具 ctx 的会话键可能不同，读取时会试候选键；群聊不回退到裸 `sessionKey`，避免串图。口径见 [工单会话隔离与资料回收场景.md](工单会话隔离与资料回收场景.md)。
- `message_received` 需要 `oa-workflow-bridge` 与 `wecom-openclaw-plugin` 都设 `hooks.allowConversationAccess: true`。

Docker 必须设 `OPENCLAW_STATE_DIR=/home/node/.openclaw`，否则 staging 不在挂载卷上，确认时会 `STAGING_MISSING`。

---

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

缺地点（电脑类 1–6、邮箱 / 文件国内越南、MES 地点）、一次说了多个系统、明显不是 IT 的事，仍由 AGENTS.md 规则先问清，不走兜底。

---

## 4. 安装

### 4.1 前置

| 项 | 要求 |
| --- | --- |
| MySQL | 5.7+ / 8.x（MariaDB 10.6+ 亦可）。已按 MySQL 准备文档建库、建账号、放通 3306 |
| OpenClaw Gateway | 已跑通企微插件（否则没有可信 `requesterSenderId`） |
| OA 凭据 | appId / 公钥在 `bridge-config.json`；`OA_API_USER_ID` / `OA_APP_SECRET` 走 secret |
| 实例数 | 仅 1 个 Gateway |

### 4.2 安装依赖

部署时装一次，`node_modules` 留在挂载目录 `~/xa/extensions/oa-workflow-bridge/`，Gateway 启动时不再访问 npm。宿主不装 Node，借 OpenClaw 镜像里的 Node 跑一次性容器。镜像名以 `docker compose ps` 的 IMAGE 列 / `docker images` 为准（现网钉 `ghcr.io/openclaw/openclaw:2026.9.2`）：

```bash
sudo chown -R 1000:1000 ~/xa/extensions
```

```bash
docker run --rm --user 1000:1000 -e HOME=/tmp -e NPM_CONFIG_CACHE=/tmp/npm-cache \
  -v "$HOME/xa/extensions/oa-workflow-bridge:/app" -w /app \
  ghcr.io/openclaw/openclaw:2026.9.2 \
  npm install --omit=dev
```

国内超时在末尾追加 `--registry=https://registry.npmmirror.com`。核对后再 `down && up`：

```bash
ls ~/xa/extensions/oa-workflow-bridge/node_modules/{mysql2,jpeg-js,pngjs}
```

| 缺什么 | 现象 |
| --- | --- |
| `jpeg-js` / `pngjs` | 插件整包加载失败：`Cannot find module 'jpeg-js'`；企微能聊，`oa_workflow` 没注册 |
| `mysql2` | 插件已 loaded，紧接着 `MySQL init failed: Cannot find package 'mysql2'`；员工侧「确认准备失败」 |

不要：宿主 `apt install npm`；把 `npm install` 写进 compose / entrypoint；Gateway 起来后再 `docker exec` 补装（已加载失败，补完还得重启）。从备份恢复（备份排除 `node_modules`）、`package.json` 依赖变化时重装。

开发机跑测试：`npm install && npm test`。单元测试用 Node 内置 SQLite 跑同一套建表语句，不需要 MySQL、不需要 OA 网络。

---

## 5. 接入 Gateway

### 5.1 `openclaw.json`

```json
"plugins": {
  "allow": ["oa-workflow-bridge", "wecom-openclaw-plugin"],
  "load": { "paths": ["/home/node/.openclaw/extensions/oa-workflow-bridge"] },
  "entries": {
    "oa-workflow-bridge": { "enabled": true, "hooks": { "allowConversationAccess": true } },
    "wecom-openclaw-plugin": { "enabled": true, "hooks": { "allowConversationAccess": true } }
  }
}
```

全局与 `itservicedeskagent` 两处 `tools.alsoAllow` 都只写 `oa_workflow`。旧 id `oa-workflow-bridge-redis` / `wecom-oa-identity-adapter` 不要再出现在 `allow` / `paths` / `entries`。现网整份样例见 `../workspace-rules/openclaw.json`。

### 5.2 `bridge-config.json`

```json
{
  "active": true,
  "baseUrl": "https://adtekoa.com",
  "appId": "…",
  "workflowId": 602,
  "isnextflow": "0",
  "publicKeySpkiBase64": "…",
  "attachmentFieldName": "scfj",
  "pendingTtlHours": 24,
  "inboxTtlMinutes": 30,
  "maxAttachmentBytes": 10485760,
  "maxTotalAttachmentBytes": 26214400,
  "mysql": { "host": "MySQL 主机 IP 或域名", "port": 3306, "user": "xa_oa", "database": "xa_oa" },
  "identity": { "adapter": "on" }
}
```

| 字段 | 说明 |
| --- | --- |
| `active` | `false` 时确认会回 `OA_BRIDGE_INACTIVE`，不调 OA，待确认单不动 |
| `isnextflow` | 只认字符串 `"0"` / `"1"`。现网 `"0"` 不自动流转；改 `"1"` 后重启 Gateway，不改源码 |
| `mysql.*` | 非机密连接参数。**密码不写这里**，走 `OA_MYSQL_PASSWORD` |
| `identity.adapter` | `on`：按企微发送人自动查 OA 人员 id；`off`：不查，`prepare` 回 `OA_IDENTITY_MAPPING_REQUIRED` |

### 5.3 compose 与 entrypoint（凭据注入方式不变）

宿主机 secret 文件 → compose `secrets` → entrypoint `export` 环境变量 → 插件读环境变量。仓库 `docker/` 已是现网写法：

| secret 文件 | 环境变量 | 谁用 |
| --- | --- | --- |
| `oa_mysql_password.txt` | `OA_MYSQL_PASSWORD` | 插件连 MySQL |
| `oa_api_user_id.txt` / `oa_app_secret.txt` | `OA_API_USER_ID` / `OA_APP_SECRET` | 换 OA token、只读预检 |
| `wecom_identity_corpid.txt` / `wecom_identity_secret.txt` | `WECOM_IDENTITY_CORPID` / `WECOM_IDENTITY_SECRET` | 身份转换（自建应用，不是机器人 Bot） |

```sh
# entrypoint.sh 片段
export OA_MYSQL_PASSWORD="$(tr -d '\n' < /run/secrets/oa_mysql_password)"
export OA_API_USER_ID="$(tr -d '\n' < /run/secrets/oa_api_user_id)"
export OA_APP_SECRET="$(tr -d '\n' < /run/secrets/oa_app_secret)"
export WECOM_IDENTITY_CORPID="$(tr -d '\n' < /run/secrets/wecom_identity_corpid)"
export WECOM_IDENTITY_SECRET="$(tr -d '\n' < /run/secrets/wecom_identity_secret)"
```

改 secret、插件路径后必须 `docker compose down && docker compose up -d`，env 不热更。`docker exec` 看不到这些变量（exec 不跑 entrypoint），不要据此判失败。

MySQL 在另一台机器上，Gateway 走局域网直连 3306，compose 不再需要 `xa-shared` 外部网络，也没有「先起 Redis」的启动顺序。

### 5.4 验证加载

```bash
docker logs xa-gateway 2>&1 | grep oa-workflow-bridge | tail -5
```

应看到 `loaded (MySQL state)`，且没有 `MySQL init failed`。

---

## 6. 身份

| 身份 | 来源 | 用途 |
| --- | --- | --- |
| 企微加密 SenderId | 通道 `requesterSenderId` | 只取哈希作 `sender_code` / `mapping_code` |
| 申请人 OA 人员 id | `oa_identity` 缓存；miss 时 `user/get`（失败回退 `openuserid_to_userid`）→ 明文 userid 即工号 → `getHrmUserInfoWithPage` | 建单 Header `userid`（RSA 加密）与表单 `xqsqr` |
| 接口账号 `OA_API_USER_ID` | secret | 只用于换 token 与只读预检 |

命中缓存 0 次外部 HTTP。企微 / 人事 HTTP 不重试；`NOT_CONFIGURED` / `TOKEN_FAILED` 不写负缓存，其它失败码写 10 分钟负缓存。身份失败时不写工单。错误码与排查见 [身份适配器说明.md](身份适配器说明.md)。手工排查：

```bash
docker exec -it xa-gateway node /home/node/.openclaw/extensions/oa-workflow-bridge/scripts/manual-resolve.mjs <open_userid>
```

（默认不读写缓存；`--write-cache` 才写 `oa_identity`。）

---

## 7. `oa_workflow` 工具 API

Schema `additionalProperties: false`。可信上下文必须是：`messageChannel = wecom`、有 `requesterSenderId`、有 `sessionKey` 或 `sessionId`。群聊按实际发送人建单。

| action | 写库 | 调 OA |
| --- | --- | --- |
| `prepare` | 插入一行 `awaiting_confirmation`；认领并删除该会话 inbox | 不调建单；身份 miss 时查企微 / 人事 |
| `attach` | 同会话：追加本单 `staged_json`；尚无待确认：写 `oa_inbox`；跨会话已有待确认：不写，回 `ALREADY_PENDING` | 否 |
| `submit_confirmed` | `active=false` 不写；否则标 `submitting`，结果写 `submitted` / `failed` / `unknown` | `getHrmSimpleInfo` → `doCreateRequest` |
| `status` | 只在发现到期单时记 `expired` | 否 |
| `cancel` | 记 `cancelled`，删 inbox / staging | 否 |

### 7.1 `prepare`

`draft` 必填 `summary`（≤200，确认卡用原话开头预览）、`problemDescription`（≤6000，只抄员工文字）。`ticketType` / `systemName` 命中才传，未命中按 3.1 兜底。电脑类传 `location`（智园 / 大磡 / 深汕 / 越南 / 光明 / 泗洪），不传时插件从系统名括号兑底。IT 需求另要 `demandType`、`monthlyHours`。可选 `impactScope` / `occurredAt` / `attemptedMeasures`（员工没说不要传）。不要传 `externalTicketId`：插件按 `WeComReceivedAt`（Asia/Bangkok）+ `message_id` 生成 `IT-YYYYMMDD-HHMMSS-XXXX`，只作幂等键与流程标题前缀。

成功：`AWAITING_CONFIRMATION` + `confirmationId` + `expiresAt` + `retentionHours` + `location` + `summary.{problemSummary, ticketType, systemName, location, attachmentCount, imageCount, documentCount}`。

同一提交人全局一张待确认：已有别的单（含其它会话）→ `ALREADY_PENDING`，回执带该单 `confirmationId` / `expiresAt` / `retentionHours` / `sameSession` / `summary` / `location` / 附件计数（`externalTicketId` 不展示给员工）。冲突在查身份**之前**拦下。

### 7.2 `attach`

不换 `confirmationId`、不改状态。带 `confirmationId`，或同会话已有待确认：追加到该单 → `ATTACHED`。尚无待确认：写 inbox → `BUFFERED`。另一会话已有此人待确认 → `ALREADY_PENDING`（`sameSession=false`）。本轮没有新文件 → `NO_NEW_ATTACHMENT`（不清 hook 缓冲，员工重发可再试）。计数按文件名估，最终图片 / 文档分流以提交回执为准。

### 7.3 `submit_confirmed`

只认原发送人（不要求原会话）。跨会话确认只提交旧单已暂存的附件；同会话确认消息若又带新图会并入。可选 `supplement`（≤2000，只在 `active=true` 时写进描述）。

| OA 侧结果 | 状态 | 回执 |
| --- | --- | --- |
| 数字 `requestid` | `submitted`，删 staging | `SUBMITTED` + `requestId` + `summary` / `location` / 实际附件计数 |
| 资料 / 附件没备齐（`OA_PROFILE_*`、`STAGING_MISSING`），未调建单 | 退回 `awaiting_confirmation` | 对应错误码，可再确认或取消 |
| 明确拒绝（`PARAM_ERROR`、`HTTP_4xx` 等） | `failed`（记 `error_code`），删 staging | 原码；禁止自动再提交，可让员工重新报 |
| 结果不明（网络中断、`HTTP_5xx`、`SYSTEM_INNER_ERROR`、无 requestid） | `unknown` | 原码 / `RECONCILIATION_REQUIRED`；禁止自动重试 |
| OA 已建单但写库失败 | `unknown`（带 `request_id`） | `RECONCILIATION_REQUIRED` + `requestId` |

请求体：Header `userid` = RSA(申请人人员 id)；表单 `xqsqr`、`xqsqbm` / `gw` / `bgdd`（提交前 `getHrmSimpleInfo` 现查）、`sqlx`、系统字段、`wtxqmskftp`、`clry`（`systems.json`）、IT 需求 `xqlx1` / `yjygsh`、有文档才写 `scfj`。`otherParams`：`isnextflow` 取配置，`delReqFlowFaild=1`、`isVerifyPer=1` 写死。流程标题 `[{externalTicketId}] {summary}`（≤120）。token 进程内缓存约 25 分钟。

### 7.4 `status` / `cancel`

`status` 不带 `confirmationId`：可确认的待确认 → `PERSON_STATUS`（`pending` 带摘要 / 地点 / 附件计数，`recent` 最多 20 条，`submittedCount` + 最多 5 条 `submitted[].requestId`）；待确认是 `submitting` / `unknown` → 顶层 `RECONCILIATION_REQUIRED`。不支持按 OA 工单号查进度。

`status` 带 `confirmationId`（别人的单视为 `NOT_FOUND`）：

| 单的状态 | 回执 `code` |
| --- | --- |
| 待确认（未过期） | `AWAITING_CONFIRMATION` |
| 待确认已到期 | `CONFIRMATION_EXPIRED`（同时记 `expired`） |
| `submitting` / `unknown` | `RECONCILIATION_REQUIRED` |
| `submitted` | `ALREADY_SUBMITTED`（带 `requestId`） |
| `cancelled` | `CANCELLED` |
| `expired` | `CONFIRMATION_EXPIRED` |
| `failed` | `OA_CREATE_REJECTED` |

同一条消息取消后再 prepare，旧 `confirmationId` 仍按它自己的状态回答（`CANCELLED`），不会串到新单。

`cancel`：原发送人、跨会话也可。已到期 → `CONFIRMATION_EXPIRED`（记 `expired`，不是 cancelled）；`submitting` / `unknown` → `RECONCILIATION_REQUIRED`。成功 `CANCELLED`，删 staging 与该会话 inbox；同一会话取消会把附件放回缓冲，供同轮「cancel + prepare」改稿；`/new` 后的取消不回灌。

### 7.5 错误码与 `hintZh`

所有回执经 `withHintZh`（`src/hints.mjs`）补员工可见短句 `hintZh`。Agent：有确认卡 / 拦截卡 / 提交成功模板时用模板，否则原样输出 `hintZh`，不贴英文 `message`。`HTTP_5xx` 归人工核对，其它 `HTTP_*` 归 OA 拒绝。

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
| 其它 | `MISSING_CONFIRMATION_ID`（先 status）、`STAGING_MISSING`、`SENDER_MISMATCH`、`NOT_FOUND`、`NO_NEW_ATTACHMENT`、`ATTACHMENT_LIMIT_EXCEEDED`、`OA_BRIDGE_INACTIVE` |

`AWAITING_CONFIRMATION`、`ALREADY_PENDING`、`CANCELLED`、`SUBMITTED` 故意不带 `hintZh`，由 AGENTS.md 模板拼装。`ATTACHED` / `BUFFERED` 的 `hintZh` 是「📎 已收到 …份图片 / 文档」。

`DB_UNAVAILABLE`：运行时连不上库或库报错（连接拒绝、超时、账号无权限等）；`DB_SCHEMA_MISSING`：预检发现表不在。

---

## 8. 测试与预检

### 8.1 单元测试

```bash
cd OA_tool/oa-workflow-bridge && npm install && npm test
```

覆盖：字段映射与兜底、OA 客户端、资料现查、身份转换与缓存、五个 action（确认 / 幂等 / 并发提交 / 跨会话 / 附件追加与 inbox / 过期 / 对账态）、到期回收与孤儿目录、库层唯一约束、预检、日志脱敏、`AGENTS.md` ↔ `systems.json` 一致性。

真实 MySQL 集成测试默认跳过，指向**测试库**时才跑（会清空三张表）：

```bash
OA_MYSQL_TEST_HOST=<测试库主机> OA_MYSQL_TEST_USER=xa_oa OA_MYSQL_TEST_DATABASE=xa_oa_test OA_MYSQL_PASSWORD=<密码> npm test
```

### 8.2 只读预检

Gateway 起来、secret 已注入后：

```bash
docker exec -it xa-gateway sh -c 'export OA_MYSQL_PASSWORD="$(tr -d "\n" < /run/secrets/oa_mysql_password)" OA_API_USER_ID="$(tr -d "\n" < /run/secrets/oa_api_user_id)" OA_APP_SECRET="$(tr -d "\n" < /run/secrets/oa_app_secret)"; node /home/node/.openclaw/extensions/oa-workflow-bridge/scripts/readonly-preflight.mjs'
```

先连库并检查三张表（不建表、不写数据），再调 `getCreateWorkflowList`（不建单）。

| 结果 | 退出码 |
| --- | --- |
| `{"ok":true,"code":"READ_ONLY_PREFLIGHT_PASSED","workflowId":602,"db":"OK",…}` | 0 |
| `DB_UNAVAILABLE`（连不上 / 密码错 / 无权限，未调 OA） | 1 |
| `DB_SCHEMA_MISSING`（表还没建：Gateway 至少启动成功过一次才会建） | 1 |
| `WORKFLOW_NOT_CREATEABLE`（库通，流程 602 对接口账号不可创建） | 2 |
| `PREFLIGHT_FAILED` / OA 客户端码（如 `NOT_CONFIGURED`） | 1 |

### 8.3 人工点查与对账

用已知 `confirmationId` / OA 单号点查，不要手改状态：

```sql
SELECT confirmation_id, external_ticket_id, status, request_id, error_code,
       FROM_UNIXTIME(updated_at / 1000) AS updated
  FROM oa_ticket WHERE confirmation_id = 'OA-…';

-- 待人工对账
SELECT confirmation_id, request_id, error_code, FROM_UNIXTIME(updated_at / 1000)
  FROM oa_ticket WHERE status IN ('unknown', 'submitting');

-- 与 OA 逐号对账：小A 成功提交的单号
SELECT request_id, FROM_UNIXTIME(updated_at / 1000) FROM oa_ticket
 WHERE status = 'submitted' ORDER BY updated_at;
```

`unknown` 的处理：在 OA 里按流程标题 `[IT-…]` 或时间找这张单。找到了 → 告诉员工单号；没找到 → 让员工重新报。确认后可由 DBA 把该行 `status` 改成 `submitted`（补 `request_id`）或 `failed`，同时 `active_sender = NULL` 释放名额。

---

## 9. 从 Redis 版切换（停机清空）

本次重构选「停机清空」，不迁移 Redis 数据：

1. 通知员工停用窗口。确认没有处理中的单：在旧 Redis 点查本人 / 已知单，`unknown` 的先按旧手册对账完。
2. `cd ~/xa && docker compose down`。
3. 按 MySQL 准备文档建库建账号，写 `~/xa/secrets/oa_mysql_password.txt`（chmod 600）。
4. 用仓库 `docker/` 覆盖 `~/xa/docker-compose.yml`、`~/xa/entrypoint.sh`；用 `workspace-rules/openclaw.json` 的 `plugins` 段覆盖现网（id 改成 `oa-workflow-bridge`）；用 `workspace-rules/workspace/AGENTS.md` 覆盖现网工作区。
5. 删除 `~/xa/extensions/oa-workflow-bridge-redis` 与 `~/xa/extensions/wecom-oa-identity-adapter`；拷入 `OA_tool/oa-workflow-bridge`，把现网 `appId` / 公钥 / `active` 与 MySQL 主机账号写进它的 `bridge-config.json`；按 4.2 装依赖。
6. 删除旧 staging：`rm -rf ~/xa/config/oa-workflow-bridge-redis`。
7. `docker compose up -d`，看日志 `loaded (MySQL state)`，跑 8.2 预检。
8. 企微 `/new` 后走一遍：报修 → 确认 → 拿到数字单号；查进度；取消。
9. 确认无误后再停旧 Redis（`~/xa-redis`），按需保留其数据备份做历史查证。

切换后员工「查进度」看不到切换前已提交的单号（Redis 台账未迁移），这些单在 OA 侧照常存在。身份缓存会在首次报修时自动重建。

回滚：`active=false` 可只停建单；完全回退需恢复旧插件目录、旧 compose / entrypoint / openclaw.json 与旧 Redis。

---

## 10. 排错

| 现象 | 处理 |
| --- | --- |
| `Cannot find module 'jpeg-js'`，`oa_workflow` 没注册 | 按 4.2 装依赖后 `down && up` |
| `MySQL init failed: Cannot find package 'mysql2'` | 同上 |
| `MySQL init failed: OA_MYSQL_PASSWORD is not configured` | compose 缺 `oa_mysql_password` secret 或 entrypoint 没 export；补完 `down && up` |
| `ECONNREFUSED` / `ETIMEDOUT` / `EHOSTUNREACH` | 主机或端口错；MySQL 未监听外网地址（`bind-address`）；防火墙未放通 Gateway → 3306 |
| `ER_ACCESS_DENIED_ERROR` | 密码错；账号 host 部分不含 Gateway 来源 IP；本机装的 MySQL 还留着匿名账号（见 MySQL 准备文档） |
| `ER_BAD_DB_ERROR` | 库没建，或 `mysql.database` 写错 |
| `ER_TABLEACCESS_DENIED_ERROR` / 建表失败 | 账号缺 `CREATE` / `INDEX` 权限 |
| 回执 `DB_UNAVAILABLE` | 上面几项之一；插件会在下次调用自动重连，不必为第一次失败重启 Gateway（初始化失败除外） |
| 插件不出现在 list / 工具冲突 | `allow` / `paths` / `entries` 全部改成 `oa-workflow-bridge`，旧 id 删干净 |
| 员工「还不能提交到 OA」 | 看会话回执里的具体码，按 [身份适配器说明.md](身份适配器说明.md)；`docker logs` 里 grep 不到工具回执是正常的 |
| 企微已落盘，员工仍看到「没有检测到新文件」 | 两个插件都要开 `hooks.allowConversationAccess`；成功日志是 `attach attached added=1` / `attach buffered added=1` |
| `STAGING_MISSING` | 没设 `OPENCLAW_STATE_DIR` 或 staging 被删；员工取消后重报 |
| `RECONCILIATION_REQUIRED` | 禁止自动重试；按 8.3 人工对账 |
| `PARAM_ERROR` / `HTTP_4xx` | OA 明确拒绝，单已结束；核对字段 / 附件格式，让员工重报 |
| 单据出现在接口账号名下 | Header `userid` 必须是申请人；确认部署的是本仓库插件 |
| `OA_BRIDGE_INACTIVE` | 现网 `bridge-config.json` 为 `active=false` |

---

## 11. 禁止事项

- 不要同时加载旧 id `oa-workflow-bridge-redis` 或旧适配器包。
- 不要多 Gateway 连同一个库。
- 不要把 MySQL 密码、OA AppSecret、接口账号写进 `openclaw.json`、`bridge-config.json` 或 compose `environment:`。
- 不要删 `oa_ticket` 历史行或改 `external_ticket_id`（会破坏幂等与对账）；对账改状态见 8.3。
- 不要把附件 base64 写进库。
- 不要对 `unknown` / `failed` 自动再 `submit_confirmed`。
- 不要用接口账号人员 id 当建单 Header `userid`。
- 不要按姓名模糊匹配申请人。
- 不要在宿主 `apt install npm`，不要把 `npm install` 写进 compose / entrypoint。
- 不要把 `~/xa/secrets/` 提交到 git。
- 不要在 `active=false` 时改 AGENTS.md 声称 OA 已通。

---

## 12. 相关文档

| 文档 | 内容 |
| --- | --- |
| [../MySQL 数据库准备.md](../MySQL%20数据库准备.md) | 裸装 MySQL 上建库、账号、网络、备份 |
| [../xA 现网加固与演进全景.md](../xA%20现网加固与演进全景.md) | 全链路、各层 I/O |
| [工单会话隔离与资料回收场景.md](工单会话隔离与资料回收场景.md) | 同一人全局一张待确认；跨会话只能确认或取消；24 小时回收 |
| [企微到OA身份与数据流.md](企微到OA身份与数据流.md) | appid / 调用者 / 申请人三种身份 |
| [身份适配器说明.md](身份适配器说明.md) | 身份转换步骤、凭据、错误码 |
| [Ecology 流程创建 API 说明.md](Ecology%20流程创建%20API%20说明.md) | applytoken / getHrmSimpleInfo / doCreateRequest / 字段表 |
| [../OpenClaw Gateway Docker 运维手册.md](../OpenClaw%20Gateway%20Docker%20运维手册.md) | 启停、备份、巡检 |
| [../外部系统 Tool 插件设计规范.md](../外部系统%20Tool%20插件设计规范.md) | 再接其它外部系统的插件形态 |
