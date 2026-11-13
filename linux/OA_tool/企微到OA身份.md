# 企微到 OA：身份与数据流

适用对象：已经拿到 OA 应用凭据、准备把 xA 工单接到 Ecology 流程 602 的工程师。

部署命令、Compose、entrypoint、错误码以 [OA Workflow Bridge 接入手册.md](OA%20Workflow%20Bridge%20接入手册.md) 为准，本文不重复操作步骤。Ecology HTTP 细节见 [Ecology 流程创建 API 说明.md](Ecology%20流程创建%20API%20说明.md)。企微安装仍以 [../WeCom 通道插件接入手册.md](../WeCom%20通道插件接入手册.md) 为准。

**本文只讲：** 谁是调用者、谁是申请人、通道回传了什么、工号怎么变成人员 id、身份如何进 `oa_identity` 缓存。身份转换的接口、失败码与凭据只在 第 9 节 写全。

---

## 1. 当前状态

| 项 | 状态 |
| --- | --- |
| Agent 主路径 | 只走 `oa_workflow` 两阶段确认后建单 |
| 生产留痕 | 独立 MySQL `oa_ticket`；**不**走智能表格 |
| OA 桥接插件 | `oa-workflow-bridge`，规则包按 `active=true` |
| Agent 工具白名单 | **已**加入 `oa_workflow`；**不要**加入 `wecom_mcp` |
| 员工可见口径 | 只有 `SUBMITTED` + 数字 `requestId` 才能说已创建 OA |
| 身份映射 | MySQL `oa_identity` 缓存（`identity.adapter=on`），miss 时插件内身份转换现查。已验证通过 |
| 身份转换 | 插件内 `src/identity/`（原独立包已并入）；设计见 第 9 节 |

不要再把智能表格当作规则源或台账。

OA 开发确认（2026-09-01）：

- appid 是应用固定值，由管理员从接口账号所属应用中提供。
- 人员 id 是 OA 每个账号的内部数字 id，不是 appid、不是工号。
- 若从企微建流程，必须用对应**工号**查询人员 id。
- 企微通讯录侧按他们的说法只存人员工号（指管理后台「账号」怎么配，**不是**通道字段名）。

Gateway 现网实测（2026-09-01，智能机器人 WebSocket）：

- 入站 `aibot_msg_callback` / `aibot_event_callback` 的 `body.from.userid` 为 **`wo` 开头的加密 userid**（open_userid），不是明文通讯录账号，也不是 OA `workcode`。
- 官方说明：机器人由企业超级管理员创建时为明文 userid，否则为加密 userid，需自建应用 `openuserid_to_userid` 才能转明文。
- **不能把该字段直接当工号现查**，必须先经身份转换后再写入 `oa_identity` 缓存。

核对命令（不要把完整 `userid` / `response_url` 贴进群或 git）：

```bash
docker logs xa-gateway --since 10m 2>&1 | grep -E 'aibot_msg_callback|"userid"'
```

看 `from.userid` 形态即可：`wo` 长串 = 加密；与企微管理后台「账号」相同才可能是明文。

---

## 2. 三种身份，不要混

管理员从某个 OA 账号的应用里取出 appid、AppSecret，只解决「哪个应用在调接口」。建单时仍然有两种人。AppSecret 是密钥，不是第四种人。

| 名称 | 形态 | 谁提供 | 写到哪 | 用在哪 |
| --- | --- | --- | --- | --- |
| **appid** | 字母数字和连字符，如 `2026-09-01-xxxx` | OA 开发：该应用的固定许可证号 | 部署目录 `bridge-config.json` 的 `appId` | 每个 Ecology 请求 Header `appid` |
| **AppSecret** | UUID 形态密钥，16–512 字符 | OA 控制台；曾暴露的必须先轮换 | `~/xa/secrets/oa_app_secret.txt` → `OA_APP_SECRET` | RSA 加密后换 token |
| **接口账号人员 id** | **1–18 位纯数字** | 该应用所属 OA 账号的内部 `id`（已知工号可自查，见下） | `~/xa/secrets/oa_api_user_id.txt` → `OA_API_USER_ID` | 只读预检 Header `userid`。**不是** `doCreateRequest` 的 Header。仍须注入 |
| **申请人人员 id** | **1–18 位纯数字** | 正在聊天的员工；身份转换按工号点查后写入缓存 | `oa_identity`（键 `mapping_code`） | `doCreateRequest` Header `userid`（RSA 加密）与表单 `xqsqr` |

`2026-09-01-…` 这类字符串是 **appid**，不能写入 `oa_api_user_id.txt`。通道回传的 `wo…` 加密串也**不能**落库或当作 `xqsqr`。插件对人员 id 的校验是 `^\d{1,18}$`，不符合则 `INVALID_CONFIGURATION` 或视为未映射。

**appid + AppSecret 换 token 不会返回人员 id。** 但若已知该接口账号的**工号**，现网可用人事接口自查，不必等管理员口述数字：

```text
POST https://adtekoa.com/api/hrm/resful/getHrmUserInfoWithPage
Content-Type: application/json
Body: { "params": { "workcode": "工号" } }
→ data.dataList[].id  →  oa_api_user_id.txt
```

2026-09-01 在 `adtekoa.com` 实测：本接口**不带** token / appid / userid 也能按工号返回。`applytoken` 与 `doCreateRequest` 仍要认证 Header，两套不要混。身份转换运行时人事点查与现网实测一致（**不带**认证 Header），每次只查当前发送人一条。只抄 `id`，完整响应含敏感人事字段，不要贴到群或仓库。HTTP 细节见 [Ecology 流程创建 API 说明.md](Ecology%20流程创建%20API%20说明.md) 第四步。

AGENTS.md 系统表是「所属系统 → 建议责任人姓名」，**不是**身份映射，姓名也不传给 OA（OA 处理人 id 在插件 `systems.json`）。

---

## 3. Header userid 必须是申请人，单据才会落到该员工账号下

张三在企微对机器人说「电脑坏了」时：

| 角色 | 是谁 | 出现位置 | 业务含义 |
| --- | --- | --- | --- |
| 换 token | 应用挂在其下的那个 OA 账号 | `applytoken`：`appid` + 加密 Secret；**无 userid** | 机器人用哪套钥匙开门 |
| 流程创建者 / 申请人 | 张三 | 建单 Header `userid` = RSA(张三人员 id)；表单 `xqsqr` = 同一人员 id | 这张单出现在张三的 OA 账号下 |

Secret **只**出现在换 token；后续接口不再带 Secret。不要理解成每一次请求都同时带 Secret 和加密 userid。

若建单 Header 仍用接口账号人员 id，单据会落到接口账号头上，即使 `xqsqr` 填了张三。xA 因此把 `doCreateRequest` 的 Header `userid` 改成加密后的申请人人员 id；`xqsqr` 仍写同一申请人。只读预检 `getCreateWorkflowList` 仍用接口账号。

管理员还需确认：该应用能否以员工身份创建流程 602（插件 `otherParams.isVerifyPer=1`）。未授权时建单会失败。

---

## 4. 端到端流程

全景（含运行时拓扑、预切流主路径、两阶段确认、数据库摘要）只在 [../xA 现网加固与演进全景.md](../xA%20现网加固与演进全景.md) 写全。本节只保留接到 OA 的身份相关骨架。

```text
员工企微（文字 / 图片 / 文件）
  → wecom-openclaw-plugin
        body.from.userid → SenderId → ctx.requesterSenderId（现网：加密 userid）
  → OpenClaw Gateway
  → xA Agent（理解、澄清、整理 draft；不直调 OA HTTP）
        └─ oa_workflow
              → prepare：哈希 SenderId → 同号幂等 → 此人是否已有待确认（有则拦在查身份之前）→ 查 oa_identity（miss 则转换并写缓存）→ 写 oa_ticket（不调建单）
              → 原发送人确认 → submit_confirmed → getHrmSimpleInfo（部门/岗位/地点）→ applytoken（通常已缓存）→ doCreateRequest → 流程 602
```

模型只整理事实。不能传入 URL、凭据、`workflowId`、OA 字段名，也不能覆盖 `requesterSenderId`。建议责任人姓名不传给 OA，由流程 602 自己路由。

员工不必在对话里报工号。通道每次消息都会带可信 `from.userid`。现网该值是加密串，**不是**工号；查找键是哈希后的 `mappingCode`，工号只在身份转换内存里用于人事点查。

---

## 5. 各层输入与输出

分层总表只在 [../xA 现网加固与演进全景.md](../xA%20现网加固与演进全景.md) 第 4 节写全。本节展开 **身份相关** 字段：通道 body、inbound、可信上下文、以及接到 Ecology 时三种人分别出现在哪。

### 5.1 企业微信推给插件的 body（现网日志）

智能机器人 `aibot_msg_callback`（私聊文本示例结构，**不要保存真实 userid / response_url**）：

| 字段 | 含义 | 现网 |
| --- | --- | --- |
| `msgid` | 消息去重 id | 有 |
| `aibotid` | 机器人 BotId | 有 |
| `chattype` | `single` / `group` | 私聊为 `single` |
| `chatid` | 群会话 id | 仅群聊 |
| `from.userid` | 发送人 | **`wo` 开头加密 userid** |
| `from.corpid` | 操作者企业 | 内部机器人通常不返回 |
| `msgtype` | `text` / `image` / `file` / `voice` / `video` / `mixed` / `event` | 文本为 `text` |
| `text.content` | 正文 | 有 |
| `image` / `file` / `voice` / `video` / `mixed` | 附件 url + aeskey | 有附件时 |
| `quote` | 引用消息 | 可选 |
| `response_url` | 一次性回复地址 | 敏感，勿外传 |
| `create_time` / `event` | 事件（如 `enter_chat`） | 进会话事件无正文 |

**通道 body 不含：** 姓名、部门、工号、OA 人员 id。

`enter_chat` 同样只有加密 `from.userid`，没有聊天正文。

### 5.2 官方插件写入 OpenClaw inbound

`@wecom/wecom-openclaw-plugin` 的 `monitor.ts` → `finalizeInboundContext`：

| 字段 | 来源 |
| --- | --- |
| `SenderId` | `body.from.userid`（现网 = 加密串） |
| `From` | 私聊 `wecom:<userid>`；群聊 `wecom:group:<chatid>` |
| `To` / `OriginatingTo` | `wecom:<chatid 或 userid>` |
| `MessageSid` | `msgid` |
| `ChatType` | `single` / `group` |
| `SessionKey` / `AccountId` | 路由后的会话与账号 |
| `Body` | 文本；纯附件则为媒体占位符 |
| `MediaPath(s)` / `MediaType(s)` | 下载后的本地 inbound 路径 |
| `ReplyToBody` | 引用文本 |
| `ResponseUrl` / `ReqId` | 回复用 |
| `WeComFrame` | 完整原始帧 |
| `Timestamp` / `Provider` / `Surface` | 通道元数据 |

群聊必须以**实际发送人**的 `from.userid` 建单，不能用群 `chatid` 代替人员。

公开版官方插件 **没有** `WeComIdentityVerified`、`SenderName`、部门路径、大区/区域、工号。Agent 规则已按缺省执行：没有已核验展示字段时状态栏写「身份待核验」/「未获取」，不得用 OA 身份缓存填姓名。通道若额外回传姓名/部门，只用于展示和区域缩小，**不是** `aibot_msg_callback` 自带的，也不能当成 OA 现查工号。

### 5.3 `oa_workflow` 可信上下文（模型改不了）

```text
messageChannel = wecom
requesterSenderId = SenderId = from.userid（现网：加密串）
sessionKey 或 sessionId
agentAccountId
```

没有工号、没有姓名。插件只对 `requesterSenderId` 做 SHA-256。

员工不可见：原始 SenderId、本地路径、base64、`response_url`。

### 5.4 Agent 整理 draft

| 输入 | 输出 |
| --- | --- |
| 可信企微上下文 + 已注入 `AGENTS.md` + 对话事实 | `ticketType`、`systemName`、摘要、描述；IT 需求另加需求类型与月节约工时。建议责任人不进 OA。**不要**传 `externalTicketId` |
| 插件（`prepare`） | 内部幂等号 `IT-YYYYMMDD-HHMMSS-XXXX`（工单台账 / 流程标题，不给员工看） |

### 5.5 （已删除）智能表格观察留痕

Agent 不再调用 `wecom_mcp`，不再写「工单」子表。成功口径只认 `oa_workflow` 回执。

### 5.6 主路径：`oa_workflow`

五个 action（`prepare` / `attach` / `submit_confirmed` / `status` / `cancel`）的契约、替换旧单与 `replyZh` 见 [OA Workflow Bridge 接入手册.md](OA%20Workflow%20Bridge%20接入手册.md) 第 7 节。与身份相关的只有两点：`prepare` 时才查申请人（查不到不建单）；确认只认原发送人，不要求原对话。

### 5.7 插件 → Ecology

| 接口 | 请求 | 成功 | 说明 |
| --- | --- | --- | --- |
| `POST /api/ec/dev/auth/applytoken` | Header：`appid` + RSA 加密 AppSecret | `status=true` 且 `code=0` 且有 token | 无 body；**无 userid**；token 约 30 分钟，插件缓存约 25 分钟 |
| `POST /api/workflow/paService/doCreateRequest` | Header：token + `appid` + RSA 加密**申请人**人员 id；Body 见下表 | `code=SUCCESS` 且数字 `requestid` | Header `userid` 与 `xqsqr` 都是聊天员工，单据才会落到该员工账号下。网络中断 / 5xx / 无单号 → `unknown`，禁止自动重试 |
| `POST /api/workflow/paService/getCreateWorkflowList` | Header：token + `appid` + RSA 加密**接口账号**人员 id；body `{ conditions: { wfIds: "602" } }` | 列表含 602 | 只读预检；不建单 |
| `POST /api/hrm/resful/getHrmUserInfoWithPage` | Body：`params.workcode` = 工号；Header 仅 `Content-Type` | `data.dataList[].id` | **身份转换 miss 路径调用**；须 OA IP 白名单。不要在桥接 `oa-client.mjs` 里调本接口。绑接口账号人员 id 时也可手工用 |
| `GET /api/hrm/simpleinfo/getHrmSimpleInfo?userid=` | Header：token + `appid` + RSA 加密**申请人**人员 id（与建单同一套）。Query `userid` 为同一人 | `simpleInfo.departmentid` / `jobtitle` / `locationid` | **桥接 `submit_confirmed` 调用**（`hrm-profile.mjs` + `OAClient.authenticatedRequest`）。写入 `xqsqbm` / `gw` / `bgdd`。匿名现网 `002`。与上一行不是同一接口 |

建单 Body：

| OA 字段 | 含义 | 值 |
| --- | --- | --- |
| `xqsqr` | 需求申请人 | 映射后的**员工**人员 id |
| `xqsqbm` / `gw` / `bgdd` | 申请部门 / 岗位 / 办公地点 | 提交前认证 `getHrmSimpleInfo` 现查的资源 ID |
| `clry` | 处理人员 | 始终必填。插件按 `systems.json` 的 `handlers` 写入负责人 id。模型不传 |
| `sqlx` | 申请类型 | 运维支持 `0` / 权限申请 `1` / IT需求 `2` |
| `wtlx` / `szxt` / `szxtxq` | 所属系统 | `systems.json` 的 `optionId`（系统名 → 选项 ID） |
| `xqlx1` / `yjygsh` | 需求类型 / 月节约工时 | 仅 IT 需求 |
| `wtxqmskftp` | 问题详情 | 描述 + 影响范围 + 发生时间 + 已尝试措施 + 最终补充。inbound **图片**压缩后以 data URI 内嵌。**不**写 xA 工单号 |
| `scfj` | 文档附件 | 只写文档。HTTP `fieldValue` 为数组的 JSON 字符串，见 [Ecology 流程创建 API 说明.md](Ecology%20流程创建%20API%20说明.md)。有文档才写。图片不进此字段。仓库样例 `attachmentFieldName=scfj`；空配置时带文档必须拒绝 |
| `requestName` | 标题 | `[工单号] 摘要`，截断 120 字 |
| `otherParams` | 流转 | `isnextflow` 取自 `bridge-config.json`（现网 `"0"`），`delReqFlowFaild=1`，`isVerifyPer=1`。`1`：建单后 OA 自动流转；`0`：正常建单、不自动流转（现网生产测试）。项目可用后改 json 为 `"1"` 并重启 Gateway |
| `workflowId` | 流程 | `602` |

附件字段官方名为 `scfj`，只收文档。仓库样例 `attachmentFieldName=scfj`；实际加载的 json 若仍为空，带文档必须拒绝，不能只留「原件见企微」后报成功。图片走 `wtxqmskftp` 内嵌，不写 `scfj`。

---

## 6. 现行：发送人如何变成申请人

运行时**不会**把 `wo…` 当工号，也**不会**在桥接 `oa-client.mjs` 里调 `getHrmUserInfoWithPage`。提交前部门 / 岗位 / 地点走另一条接口 `getHrmSimpleInfo`，见 5.7 与 [../xA 现网加固与演进全景.md](../xA%20现网加固与演进全景.md) 第 7 节。

```text
企微 requesterSenderId（现网：加密 userid）
  → SHA-256 截前 24 位小写十六进制 = mappingCode
  → 查 oa_identity（mapping_code）
      命中 → 数字 oaUserId → Header userid + xqsqr
      miss → 身份转换 resolve(senderId)
                user/get（回退 openuserid_to_userid）
                → 明文 userid 对齐 OA workcode
                → getHrmUserInfoWithPage
                → 写 oa_identity（24h）
```

缓存命中：0 次外部 HTTP。未查到人员：`OA_IDENTITY_NOT_FOUND` / `WECOM_IDENTITY_ALIGN_MISMATCH` / `OA_IDENTITY_INACTIVE` 等，**不写 pending、不调建单**。

运行时查找键是 **`mappingCode`**，不是工号、不是姓名。工号只在内存里作为人事接口的查找键。禁止按姓名模糊匹配。

原始 SenderId / 工号 / 明文 userid 不落库、不写日志、不回给员工。`oa_identity` 只存数字人员 id（或失败码）与过期时间。

---

## 7. 身份只有一套缓存

身份权威只有 MySQL 表 `oa_identity`（插件 `src/identity/` 写、读）。不要另做文件映射、定期花名册或第二套存储。工单附件落本机 staging，与身份缓存不是一类东西。

禁止：按姓名模糊搜；把工号、appid、`wo…` 加密串直接当 `xqsqr` 或建单 Header `userid`；用接口账号人员 id 填所有人的申请人或建单 Header。

---

## 8. 落地清单（不改插件的前提下）

1. 把管理员给的 **appid** 写入实际加载的 `~/xa/oa-bridge-config.json`（不要写进 `oa_api_user_id.txt`）。规则包按 `active=true`；现网是否调用 `doCreateRequest` 看该文件。
2. **AppSecret** 写入 `~/xa/secrets/oa_app_secret.txt`（`printf`、chmod 600、uid 1000）。不要提交 git、不要贴到群聊。
3. **接口账号人员 id**：已知该账号工号时，按 Ecology 第四步调 `getHrmUserInfoWithPage`，只把 `data.dataList[].id` 写入 `oa_api_user_id.txt`。也可请管理员从人员卡片读取。不要把工号、appid 或 `wo…` 写入该文件。
4. 确认 RSA 公钥 `publicKeySpkiBase64` 是否仍为现网 `bridge-config.json` 那一把；新应用若给了新 `spk` 必须更换。
5. `identity.adapter=on`。自建应用 `WECOM_IDENTITY_CORPID` / `WECOM_IDENTITY_SECRET`：**宿主机写 txt 不够**，必须 compose 挂载 + entrypoint 在 `exec` 前 export + `compose down && up`。漏挂时 `prepare` 回执是 `OA_IDENTITY_NOT_CONFIGURED`。整份 YAML / 脚本见仓库 `docker/` 与 OA 桥接接入手册 5.3；校验见 第 9 节 第 9 节。
6. 按 OA 桥接接入手册 **4.2** 装依赖（`mysql2` / `jpeg-js` / `pngjs`），并按 [../MySQL 数据库准备.md](../MySQL%20数据库准备.md) 准备好库。缺包或连不上库时员工见「确认准备失败」。
7. 跑只读预检 `readonly-preflight.mjs`（库可连、表已建 + 流程 602 可创建，不建单）。
8. 测试企微号 `prepare`：应命中或写入 `oa_identity`，得到 `confirmationId`。不要把日志里的 `wo…` 当作工号或 `xqsqr`。
9. 现网白名单**已经**含 `oa_workflow`，**不要**含 `wecom_mcp`。规则包已落地；docker logs 若再出现 `smartsheet_get_records`，见 WeCom 手册 9.2。不要移出 `oa_workflow`。

预检 `TOKEN_REJECTED`：secret、appid、公钥三者之一不对。  
`INVALID_CONFIGURATION` / `NOT_CONFIGURED`：缺数字接口账号 id，或格式不是纯数字（这是 **OA 建单**凭据）。  
`OA_IDENTITY_NOT_CONFIGURED`：转换凭据未进 Gateway 主进程（compose 未挂或 entrypoint 未 export）。与上一码不是同一件事。  
`docker logs` grep 不到 `OA_IDENTITY_*` 是预期；查会话 jsonl，见 9.9 节。

---

---

## 9. 身份转换（企微 → 工号 → OA 人员 id）

### 9.1 定位

| 项 | 现状 |
| --- | --- |
| 代码 | OA 桥接插件内 `oa-workflow-bridge/src/identity/`（`resolve.mjs`、`wecom-client.mjs`、`oa-hrm.mjs`、`errors.mjs`）。原独立包 `wecom-oa-identity-adapter` 已并入，不再单独部署 |
| 进程形态 | Gateway 进程内模块，由 `prepare` 调用。不是单独服务、不是插件、不注册模型 tool |
| 开关 | `bridge-config.json` 的 `identity.adapter`：`on`（现网）/ `off` |
| 缓存 | MySQL 表 `oa_identity`（命中 24 小时，失败负缓存 10 分钟） |
| 对齐策略 | 企微明文 userid 就是 OA 工号；扩展属性「工号」若存在必须相等 |
| 凭据 | 自建应用 `WECOM_IDENTITY_CORPID` / `WECOM_IDENTITY_SECRET`（不是机器人 BotSecret） |

为什么要转换：现网 `requesterSenderId` 是 `wo` 开头的加密 userid，直接当工号查人事会找不到人。

```text
通道 wecom-openclaw-plugin
  → ctx.requesterSenderId = open_userid（加密串）
oa_workflow.prepare → src/identity/resolve
  → 查 oa_identity；miss 时 企微 user/get → 明文 userid（= 工号）→ getHrmUserInfoWithPage → 数字人员 id → 写 oa_identity
  → 人员 id 写进工单 oa_requester_id
oa_workflow.submit_confirmed
  → Header userid（RSA）与 xqsqr = 同一人员 id
  → 另调 getHrmSimpleInfo 取 xqsqbm / gw / bgdd（hrm-profile.mjs，不是身份转换）
```

通道凭据（BotId / BotSecret）、转换凭据（自建应用 corpid / secret）、OA 凭据（appid / AppSecret）是三套，不能混。

---

### 9.2 稳定契约

| 项 | 规则 |
| --- | --- |
| 查找键 | `mapping_code` = SHA-256(`requesterSenderId`) 截前 24 位小写十六进制（与工单 `sender_code` 相同） |
| 值 | 仅 1–18 位数字 `oa_user_id`；或失败时的短错误码 `miss_code` |
| 禁止落库 / 日志 | `open_userid`、明文 userid、工号、人事 PII、AppSecret、corpsecret |
| `xqsqr` / 建单 Header `userid` | 员工人员 id；不是接口账号、不是 `wo…`、不是 appid、不是工号 |

---

### 9.3 企微转换 API

| 步 | 接口 | 输入 | 输出 |
| --- | --- | --- | --- |
| 换 token | `GET https://qyapi.weixin.qq.com/cgi-bin/gettoken` | 自建应用 `corpid` + `corpsecret` | `access_token`；进程内缓存 90 分钟（官方 2 小时） |
| 主路径 | `GET https://qyapi.weixin.qq.com/cgi-bin/user/get` | token + `requesterSenderId` | `userid`；扩展属性「工号」 |
| 回退 | `POST https://qyapi.weixin.qq.com/cgi-bin/batch/openuserid_to_userid` | `{ "open_userid_list": [senderId] }` | `userid_list[].userid` |

- 成员必须在该自建应用**可见范围**内。`user/get` 返回 81013 / 60011 记 `WECOM_IDENTITY_OUT_OF_SCOPE`，不再回退。
- `invalid_open_userid_list` 非空记 `WECOM_OPENUSERID_INVALID`。
- token 失效类 errcode 清进程内 token 缓存并记 `WECOM_IDENTITY_TOKEN_FAILED`。
- 每次只转当前发送人一条；日志不记 `open_userid` 和明文 userid。

### 9.4 工号对齐

| 情况 | 动作 |
| --- | --- |
| 明文 userid 等于 OA `workcode` | 用它点查人事 |
| 扩展属性「工号」存在且不等于 userid | fail-closed：`WECOM_IDENTITY_ALIGN_MISMATCH` |
| 没有扩展属性「工号」 | 把明文 userid 当 workcode（现网已验证口径） |

### 9.5 OA 人事点查

| 项 | 要求 |
| --- | --- |
| 接口 | `POST https://adtekoa.com/api/hrm/resful/getHrmUserInfoWithPage`，Body `{ "params": { "workcode": "<工号>" } }` |
| 认证 | 与现网实测一致：只带 `Content-Type`，不带 token / appid / userid；须 OA 管理员把 Gateway 出口 IP 加白。不要把这种写法推广到建单 |
| 成功 | `code="1"` 且 `totalSize=1`，取 `dataList[0].id` |
| 拒绝 | 0 条 → `OA_IDENTITY_NOT_FOUND`；多条 → `OA_IDENTITY_AMBIGUOUS`；`status` ∈ 4/5/6/7 或 `accounttype=1` → `OA_IDENTITY_INACTIVE` |
| PII | 整段 `dataList` 不写日志、不落库、不回给员工 |

---

### 9.6 `resolve` 流水线

| 序 | 动作 | 失败码 |
| --- | --- | --- |
| 1 | 校验 `senderId` 非空，算 `mapping_code` | `WECOM_IDENTITY_INVALID_SENDER` |
| 2 | 查 `oa_identity`：有未过期 `oa_user_id` 直接返回 | — |
| 3 | 有未过期 `miss_code` 直接抛出该码，不打企微 / 人事 | 上次的码 |
| 4 | 读 `WECOM_IDENTITY_CORPID` / `WECOM_IDENTITY_SECRET` | `OA_IDENTITY_NOT_CONFIGURED` |
| 5 | `user/get`，必要时 `openuserid_to_userid` | `WECOM_OPENUSERID_INVALID` / `WECOM_IDENTITY_OUT_OF_SCOPE` / `WECOM_IDENTITY_TOKEN_FAILED` |
| 6 | 工号对齐 | `WECOM_IDENTITY_ALIGN_MISMATCH` |
| 7 | `getHrmUserInfoWithPage` | `OA_IDENTITY_NOT_FOUND` / `OA_IDENTITY_AMBIGUOUS` / `OA_IDENTITY_INACTIVE` / `OA_IDENTITY_LOOKUP_FAILED` |
| 8 | 写 `oa_identity`（`oa_user_id`，24 小时） | — |

失败时写 10 分钟负缓存（`miss_code`），**但** `OA_IDENTITY_NOT_CONFIGURED` / `WECOM_IDENTITY_TOKEN_FAILED` 不写，免得补完凭据还被挡。身份失败不写工单、不调建单。

#### 9.6.1 无重试与回执

企微、人事同一 HTTP 请求**不自动重试**。企微超时 20 秒，人事超时 30 秒。`user/get` → `openuserid_to_userid` 是协议回退，不是重试；负缓存期间再 `prepare` 直接回上次的码。

回给模型的 JSON 只有 `ok` / `code` / `message`（不含 `mapping_code`、SenderId、HTTP 原文、明文 userid、工号），例如：

```json
{ "ok": false, "code": "OA_IDENTITY_LOOKUP_FAILED", "message": "OA HR request failed" }
```

员工可见：`OA_IDENTITY_NOT_FOUND` / `OA_IDENTITY_NOT_CONFIGURED` / `OA_IDENTITY_MAPPING_REQUIRED` / `OA_IDENTITY_INACTIVE` / `WECOM_IDENTITY_TOKEN_FAILED` / `WECOM_IDENTITY_OUT_OF_SCOPE` / `WECOM_IDENTITY_ALIGN_MISMATCH` / `WECOM_IDENTITY_INVALID_SENDER` →「还不能提交到 OA / 账号还没开通提交权限」；`OA_IDENTITY_LOOKUP_FAILED` / `OA_IDENTITY_AMBIGUOUS` / `WECOM_OPENUSERID_INVALID` →「确认准备失败」。回执 `hintZh` 已写好，原样输出即可。

---

### 9.7 缓存表 `oa_identity`

| 列 | 说明 |
| --- | --- |
| `mapping_code` | 主键，24 位 hex |
| `oa_user_id` | 命中时的数字人员 id |
| `miss_code` | 负缓存的短错误码 |
| `expires_at` | 毫秒时间戳；到期视为不存在，定时回收删除 |

手工点查（只读）：

```sql
SELECT oa_user_id, miss_code, FROM_UNIXTIME(expires_at / 1000) FROM xa_oa.oa_identity WHERE mapping_code = '<24 位 hex>';
```

员工换了工号 / 调岗离职要立刻生效时，可删该行，下次 `prepare` 重新现查。

---

### 9.8 配置与凭据

| 位置 | 内容 |
| --- | --- |
| `bridge-config.json` | `"identity": { "adapter": "on" }`。`off` 时不查，`prepare` 回 `OA_IDENTITY_MAPPING_REQUIRED` |
| `~/xa/secrets/wecom_identity_corpid.txt` / `wecom_identity_secret.txt` | compose `secrets` 挂载，entrypoint `export WECOM_IDENTITY_CORPID` / `WECOM_IDENTITY_SECRET`（仓库 `docker/` 已写好） |
| `openclaw.json` | **不涉及**。身份转换不是插件，不进 `plugins.allow` / `alsoAllow` |

只在宿主机写 txt 不够：必须 compose 声明 + entrypoint export + `down && up`。手工排查脚本：

```bash
docker exec -it xa-gateway node /opt/xa/oa-workflow-bridge/scripts/manual-resolve.mjs <open_userid>
```

默认不读写缓存；`--write-cache` 写 `oa_identity`（需 `OA_MYSQL_PASSWORD`）；`--show-userid` 才打印明文 userid（只在本机看，不要外传）。

---

### 9.9 排障：`OA_IDENTITY_NOT_CONFIGURED` 与会话回执

页脚「身份待核验」只表示公开版通道没有 `SenderName`，**不是**本错误。是否映射只认 `oa_workflow` 回执的 `code`。`docker logs` 里**不会**有 `OA_IDENTITY_*`（工具回执不写 stdout），`grep` 为空不能说明没调 `prepare`。

校验转换凭据（只判断有无，不要打印值）：

```bash
docker exec xa-gateway sh -c 'test -s /run/secrets/wecom_identity_corpid && test -s /run/secrets/wecom_identity_secret && echo WECOM_IDENTITY_FILES_OK || echo WECOM_IDENTITY_FILES_MISSING'
```

```bash
docker exec xa-gateway sh -c 'for d in /proc/[0-9]*; do tr "\0" "\n" < "$d/environ" 2>/dev/null | grep -q "^WECOM_IDENTITY_SECRET=" && { echo WECOM_IDENTITY_INJECTED; exit 0; }; done; echo WECOM_IDENTITY_MISSING; exit 1'
```

| 输出 | 含义 |
| --- | --- |
| `WECOM_IDENTITY_FILES_MISSING` | compose 未声明 / 未挂载 |
| `FILES_OK` + `WECOM_IDENTITY_MISSING` | 已挂文件，entrypoint 未 export 或未 `down && up` |
| 两项都 OK | 注入完成；若仍失败，看回执 `code` |

查本次 `prepare` 回执（不要 `cat` 整份 jsonl，里面有加密 userid）：

```bash
ls -lt ~/xa/config/agents/itservicedeskagent/sessions/*.jsonl | head -5
```

对**最新**那份（不要用 `.trajectory.jsonl` 做唯一依据：规则文件被 `read` 时也会命中同样字符串）：

```bash
python3 - <<'PY'
import json,re,pathlib
sess=pathlib.Path.home()/"xa/config/agents/itservicedeskagent/sessions"
cands=[p for p in sess.glob("*.jsonl")
       if ".trajectory." not in p.name and ".reset." not in p.name]
p=sorted(cands, key=lambda x: x.stat().st_mtime)[-1]
print("FILE", p.name)
codes=re.compile(r"(OA_IDENTITY_[A-Z_]+|WECOM_IDENTITY_[A-Z_]+|AWAITING_CONFIRMATION)")
for i,line in enumerate(p.open(encoding="utf-8",errors="replace"),1):
    try: o=json.loads(line)
    except Exception: continue
    name=o.get("toolName") or o.get("name") or (o.get("message") or {}).get("toolName")
    if name!="oa_workflow": continue
    hits=sorted(set(codes.findall(json.dumps(o,ensure_ascii=False))))
    print(f"L{i} hits={hits}")
PY
```

以 `name=oa_workflow` 那一行的 `hits` 为准。`OA_IDENTITY_NOT_FOUND` 等若只出现在 `name=read` 的行，那是规则正文，不是工具回执。

| 回执 `code` | 下一步 |
| --- | --- |
| `OA_IDENTITY_NOT_CONFIGURED` | 按上表补 compose / entrypoint / `down && up` |
| `WECOM_IDENTITY_TOKEN_FAILED` | 自建应用 Secret 不对，不要用 BotSecret |
| `WECOM_IDENTITY_OUT_OF_SCOPE` | 测号加入**该自建应用**可见范围 |
| `WECOM_IDENTITY_ALIGN_MISMATCH` | 明文 userid 与扩展属性「工号」不一致 |
| `OA_IDENTITY_NOT_FOUND` / `OA_IDENTITY_INACTIVE` | 人事按工号查不到或状态无效 |
| `AWAITING_CONFIRMATION` | 身份已通，pending 已写 |

不要把 jsonl 原文、`wo…`、`response_url` 或 secret 贴进群。

---

---

## 10. 禁止事项

- 不要把 appid、工号、登录名、带日期的账号名、`wo…` 加密 userid 当作人员资源 id 或 `xqsqr`。
- 不要把 OA AppSecret、API User ID 写入 `openclaw.json`。
- 不要把身份映射文件挂进 workspace 或 `.openclaw`（Agent 可能 `read` 到）。
- 不要按姓名模糊匹配申请人。
- 不要在 `active=false` 时改 `AGENTS.md` 声称 OA 已通。
- 不要在 `attachmentFieldName` 为空时带附件报成功。
- 不要为了「兼容随机字符串」只改一处插件正则：Ecology 仍要数字人员 id；`tool.mjs` 与 Windows 脚本同样校验。
- 不要把 `getHrmUserInfoWithPage` 的完整 JSON（密码密文、身份证、手机等）写入仓库、群聊或日志；只保留数字 `id`。
- 不要把现网「人事接口无认证可查」当成全员花名册扫描；每次只查当前发送人一条。
- 不要把 `aibot_msg_callback` 里的 `response_url`、完整 `from.userid` 提交 git 或转发到群。
- 不要假设 `requesterSenderId` 等于 OA 工号；现网已证明不是。
- 不要把企微转换或人事现查做成模型可调 tool；转换层是插件内部模块 `src/identity/`。
- 不要只在宿主机写 `wecom_identity_*.txt` 却不挂 compose、不 export（会 `OA_IDENTITY_NOT_CONFIGURED`）。
- 不要把页脚「身份待核验」当成 OA 申请人未映射。
- 不要把企微转换或人事点查做成模型可调 tool。
- 不要用机器人 BotSecret 当自建应用 corpsecret。
- 不要假设 `requesterSenderId` 等于工号。
- 不要把明文 userid、工号、`wo…` 或接口账号人员 id 写进 `xqsqr`、建单 Header、库、日志或员工回复。
- 不要对身份 HTTP 加自动重试；靠负缓存挡住短时间再打。
- 不要用人事接口扫全员花名册；每次只查当前发送人。
- 不要在缺转换凭据时改 `adapter=off`；补凭据（回执是 `OA_IDENTITY_NOT_CONFIGURED`）。
- 不要用 `docker logs | grep OA_IDENTITY` 判断没调 `prepare`。
- 不要按姓名模糊匹配申请人，不要让员工自报工号当正式绑定。
- 不要把 `~/xa/secrets/` 提交到 git。

---

## 11. 相关文档

| 文档 | 内容 |
| --- | --- |
| [../xA 现网加固与演进全景.md](../xA%20现网加固与演进全景.md) | OA 主路径、切入范围、各层 I/O |
| [OA Workflow Bridge 接入手册.md](OA%20Workflow%20Bridge%20接入手册.md) | 部署、凭据注入、工具契约、错误码 |
| [Ecology 流程创建 API 说明.md](Ecology%20流程创建%20API%20说明.md) | applytoken / 建单 / 用工号查人员 |
| [../外部系统 Tool 插件设计规范.md](../外部系统%20Tool%20插件设计规范.md) | 固定 action、可信上下文、两阶段确认 |
| [../WeCom 通道插件接入手册.md](../WeCom%20通道插件接入手册.md) | 企微通道安装 |
| `workspace-rules/workspace/AGENTS.md` | 唯一规则源：匹配、未命中兜底、OA 主路径；不含智能表格 |
| [企微智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463) | `from.userid` 明文 / 加密规则 |
| [openuserid_to_userid](https://developer.work.weixin.qq.com/document/path/101521) | 加密 userid 转明文（身份转换回退路径） |
