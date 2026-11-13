# Redis OA 流程解析（小白版）

适用对象：已经听说 Aidy 用工单走 OA，但还不清楚 **Redis 里到底存了什么** 的同事。

部署命令、YAML、错误码、启停顺序仍以 [OA Workflow Bridge（Redis）接入手册.md](OA%20Workflow%20Bridge（Redis）接入手册.md) 为准。节点图与 hop 以 [OA插件与Redis链路.md](OA插件与Redis链路.md) 为准。身份转换步骤以 [身份适配器说明.md](身份适配器说明.md) 为准。

**本文只讲：** Redis 就是 key → value；本项目一共 **10 种**钥匙（桥接 8 把 + 身份 2 把）；每把钥匙的完整内容长什么样；五个 action 怎么改这些钥匙。键名 / TTL / 谁写的规范表以 [OA Workflow Bridge（Redis）接入手册.md](OA%20Workflow%20Bridge（Redis）接入手册.md) **3.1** 为准，不要在本文再维护一份。源码对照：`oa-workflow-bridge-redis/src/state-store.mjs`、`tool.mjs`，以及 `wecom-oa-identity-adapter/src/cache.mjs`。

阅读顺序见 [../README.md](../README.md)。

---

## 1. 先记住一件事

员工在企微说话时，Aidy **不会立刻建 OA**。它先在 Redis 里放一张「待你确认」的纸条；你回复「确认提交」后，插件才去 Ecology 建流程 602。

Redis 只管这几张纸条。附件文件、OA HTTP、企微转换都不进 Redis。

Redis 在这里不是「整个 OA 系统」，也不是花名册。它只是 Gateway 旁边的一台**小柜子**：一张工单确认前、确认中、确认后的几张纸条，外加「这个企微人对应哪个 OA 人」的缓存。

---

## 2. Redis 就是字典：左边 key，右边 value

Python 里可以想成：

```python
redis = {
    "钥匙": "内容",
}
```

本项目业务路径一共只用 **10 种钥匙**（桥接 8 把 + 身份 2 把），没有别的。前缀默认是 `oa-workflow-bridge`（插件 id 虽带 `-redis`，钥匙前缀默认不带）。

现网容器里不要用 `127.0.0.1` 连 Redis，要连独立实例主机名（文档是 `aidy-redis:6379`）。业务路径禁止用 `KEYS *` / `SCAN` 扫全库，只能点查这一张工单的钥匙。

---

## 3. 文档里那些词是什么意思

| 你看到的词 | 白话 |
| --- | --- |
| **Gateway** | 跑 OpenClaw 的那个 Docker 容器。插件都在这个进程里。 |
| **pending** | 「待确认底稿」。确认前提交按钮还没按。 |
| **ledger** | 「这张工单号的台账」。**这一张** `IT-…` 对 OA 只许成功建一次，永久留下。不是「刚交过就不能再交」的冷却，也不挡新工单号。详见 5.4。 |
| **idx** | 「确认单号 → 工单号」的目录。pending 删掉后，还能用确认单号去查台账。 |
| **pending-idx** | 「这个人在这个会话挂着哪张待确认」。群聊里要带人，否则会互相顶掉。跨 `/new` 的闸门不是它，是 `person-pending`。 |
| **person-pending** | 「这个人现在有没有待确认」。同一人全局一张，换会话也拦住。 |
| **person-tickets** | 「这个人最近几张单的摘要」。没有草稿正文，方便 `/new` 后查进度。 |
| **inbox** | 「还没 prepare 之前，先甩过来的附件清单」。默认 30 分钟。 |
| **person-inbox** | 「这个人当前 inbox 落在哪个会话」。换会话时靠它清旧 inbox，避免 SCAN。 |
| **idmap** | 「这个企微人已经查过，对应哪个 OA 人员数字 id」。命中就不用再调企微/人事。 |
| **idmiss** | 「这个人最近查失败了」。10 分钟内不要再打企微/人事。 |
| **mappingCode** | 把加密的企微 userid 做 SHA-256，只取前 24 位十六进制。这是查找键，**不是工号、不是姓名**。 |
| **confirmationId** | 一次性确认单号，形如 `OA-XXXX-YYYY`。只有原发送人能确认（换了 OpenClaw 会话也可以）。 |
| **externalTicketId** | 插件生成的 Aidy 内部幂等号，形如 `IT-20260904-112700-ABCD`。员工可见工单编号是 OA 的数字 `requestId`。 |
| **GET / SET / DEL** | 读一把钥匙 / 写一把钥匙 / 删一把钥匙。 |
| **SET EX / SET PX** | 写入时带过期秒数 / 毫秒数。身份缓存用 `EX`；pending 用 `PX` 兜底；ledger / idx **不用**。 |
| **TTL** | Time To Live，钥匙多久自动消失。 |
| **MULTI / EXEC** | 几条 Redis 命令打包一起提交，避免只写了一半。 |
| **SCAN / KEYS** | 扫全库。本项目业务路径**禁止**用。 |
| **进程内锁** | 同一个 Gateway 里排队，一次只处理一张单。**不是** Redis 分布式锁。 |
| **AOF + noeviction** | Redis 重启尽量不丢数据；内存满了也不随意踢掉 key。 |
| **prefix** | 钥匙名前缀，默认 `oa-workflow-bridge`。 |
| **expiresAt** | pending JSON 里的过期时间（毫秒时间戳）。**是否过期只看它**；Redis 另外按「它 + 60 秒」删 key。 |

十把钥匙名字如下（`{prefix}` = `oa-workflow-bridge`）。TTL / 谁写见 OA 手册 **3.1**；第 5 节把每把的 value 摊开。

```text
oa-workflow-bridge:pending:{confirmationId}            ← 待确认 JSON
oa-workflow-bridge:ledger:{工单号}                     ← 台账 JSON
oa-workflow-bridge:idx:confirmation:{确认单号}         ← 存的是工单号字符串
oa-workflow-bridge:pending-idx:{identity}:{session}    ← 该人该会话当前确认单号
oa-workflow-bridge:person-pending:{identity}           ← 该人全局当前确认单号
oa-workflow-bridge:person-tickets:{identity}           ← 该人最近状态摘要
oa-workflow-bridge:inbox:{identity}:{session}          ← 建单前附件清单 JSON
oa-workflow-bridge:person-inbox:{identity}             ← 该人当前 inbox 落在哪个 session
oa-workflow-bridge:idmap:{mappingCode}                 ← { oaUserId, cachedAt }
oa-workflow-bridge:idmiss:{mappingCode}                ← 短错误码
```

---

## 4. 假数据（下面所有例子共用这一套）

下面不是真人员、不是真企微号，只为把 key / value 摊开看。

| 假数据 | 值 |
| --- | --- |
| 企微加密 userid | `woFAKEOPENUSERIDEXAMPLE0001` |
| mappingCode / identity | `103417dabf1825e4b03b03e0`（对上面做 SHA-256，取前 24 位） |
| 会话哈希 session | `e8b9b86e9fbc3f999572922e` |
| Aidy 工单号 | `IT-20260904-112700-A1B2` |
| 确认单号 | `OA-M9K2H1-AABBCCDDEEFF0011` |
| OA 人员数字 id | `4357` |

`identity`（pending / ledger 里）和 `mappingCode`（idmap 的查找键）算法相同：都是 SHA-256 截前 24 位。

---

## 5. 十把钥匙，把 value 全部打开

### 5.1 身份命中缓存 `idmap`（适配器写，桥接只读）

```text
KEY:
  oa-workflow-bridge:idmap:103417dabf1825e4b03b03e0

VALUE（字符串，里面是 JSON）:
  {"oaUserId":"4357","cachedAt":"2026-09-04T03:27:00.000Z"}

过期：SET 时带 EX 86400 秒（24 小时）。到期 Redis 自己删掉。
```

读出来只要 `oaUserId`。**没有**姓名、工号、`wo…` 加密串。

### 5.2 身份失败负缓存 `idmiss`（只有查失败才出现）

```text
KEY:
  oa-workflow-bridge:idmiss:103417dabf1825e4b03b03e0

VALUE（普通字符串，不是 JSON）:
  OA_IDENTITY_NOT_FOUND

过期：SET 时带 EX 600 秒（10 分钟）。
```

这 10 分钟内再 `prepare`，直接报这个错误码，不再打企微/人事。查成功时这把钥匙**不会出现**。

### 5.3 待确认底稿 `pending`

`prepare` 成功后才有。确认提交成功后会被 **DEL 删掉**。不是 Redis 全空：ledger / idx / idmap 留下；本单 staging 会删。删留全表只在 [OA Workflow Bridge（Redis）接入手册.md](OA%20Workflow%20Bridge（Redis）接入手册.md) **3.3.1**。

```text
KEY:
  oa-workflow-bridge:pending:OA-M9K2H1-AABBCCDDEEFF0011
```

VALUE：

```json
{
  "confirmationId": "OA-M9K2H1-AABBCCDDEEFF0011",
  "identity": "103417dabf1825e4b03b03e0",
  "session": "e8b9b86e9fbc3f999572922e",
  "oaRequesterId": "4357",
  "draft": {
    "externalTicketId": "IT-20260904-112700-A1B2",
    "ticketType": "运维支持",
    "ticketTypeValue": "0",
    "systemName": "电脑/打印机/网络问题（智园）",
    "systemField": "wtlx",
    "systemOptionId": 12,
    "summary": "电脑无法开机",
    "problemDescription": "今早电脑按电源没反应",
    "impactScope": "",
    "occurredAt": "",
    "attemptedMeasures": "",
    "demandType": "",
    "demandTypeValue": "",
    "monthlyHours": ""
  },
  "staged": [
    {
      "storedName": "01-截图.png",
      "fileName": "截图.png",
      "size": 12345,
      "sourcePath": "/home/node/.openclaw/media/inbound/xxxx.png"
    }
  ],
  "createdAt": "2026-09-04T03:27:01.000Z",
  "expiresAt": 1757047621000,
  "submissionState": null
}
```

| 字段 | 意思 |
| --- | --- |
| `identity` | 发送人哈希，必须和当前聊天的人一致，否则不能确认 |
| `session` | 建单时的会话哈希。确认 / 取消只认人，**不要求回到这个会话**。跨会话不能补附件 |
| `oaRequesterId` | 已经查好的 OA 人员数字 id，后面建单用 |
| `draft` | Agent 整理好的工单正文 |
| `staged` | 附件只记文件名、大小和本机源路径，**图片本身不在 Redis**。`sourcePath` 是给「取消后改稿」用的：取消会删掉附件副本，靠它把图片重新捡回来 |
| `expiresAt` | 毫秒时间戳。**是否过期只看它**；Redis 另外按「它 + 60 秒」设 `PX` 作兜底回收 |
| `submissionState` | 平时 `null`；正在建单时变成 `"submitting"`；结果不明时变成 `"unknown"` |

提交过程中会多写 `submissionState`：`submitting` 或 `unknown`。

### 5.4 工单台账 `ledger`（永久留着）

```text
KEY:
  oa-workflow-bridge:ledger:IT-20260904-112700-A1B2
```

VALUE（prepare 刚成功时）：

```json
{
  "status": "awaiting_confirmation",
  "confirmationId": "OA-M9K2H1-AABBCCDDEEFF0011",
  "identity": "103417dabf1825e4b03b03e0",
  "session": "e8b9b86e9fbc3f999572922e",
  "externalTicketId": "IT-20260904-112700-A1B2",
  "updatedAt": "2026-09-04T03:27:01.000Z"
}
```

建单成功后变成：

```json
{
  "status": "submitted",
  "confirmationId": "OA-M9K2H1-AABBCCDDEEFF0011",
  "identity": "103417dabf1825e4b03b03e0",
  "session": "e8b9b86e9fbc3f999572922e",
  "externalTicketId": "IT-20260904-112700-A1B2",
  "requestId": "1379641",
  "updatedAt": "2026-09-04T03:28:10.000Z"
}
```

失败时可能带 `errorCode`（不会写入凭据或附件内容）。

**防什么、不防什么（不要理解成冷却）：**

- **会拦：** 还是这一张 `IT-…` / 同一个确认号。模型幻觉多调一次 `submit_confirmed`、员工说「再提交」但模型仍拿刚成功的确认号、OA 结果不明（`unknown`）又拿同一号再 prepare。第二次不再打 OA。
- **不拦：** 下一句开了一张**新**工单号（同一人把同一件事又说一遍）。提交成功后立刻再 `prepare` 是允许的。按人同时只能有一张待确认，靠的是 `person-pending`，不是 ledger。
- **不是最近才有效：** 这条 key **没有过期时间**。一周后再拿同一个号来，照样 `ALREADY_SUBMITTED`。所以 Redis 内存会随工单量涨，满了加内存，不要给 ledger 加 TTL。

正文（状态机、错误码）以 [OA Workflow Bridge（Redis）接入手册.md](OA%20Workflow%20Bridge（Redis）接入手册.md) **3.3** 为准。

`status` 只会是这些字：

| 状态 | 含义 |
| --- | --- |
| `awaiting_confirmation` | 已 prepare，等待原发送人确认 |
| `submitting` | 已进入提交，正在调 OA（或正在读本地附件） |
| `submitted` | OA 返回数字 `requestid` |
| `failed` | OA 明确拒绝。pending 已删，同一确认号不能再交；修正后 **换新工单号** 再 prepare |
| `unknown` | 网络中断 / HTTP 5xx / 成功但无单号；**禁止自动重试** |
| `cancelled` | 用户取消待确认 |

### 5.5 目录 `idx`（确认单号 → 工单号）

```text
KEY:
  oa-workflow-bridge:idx:confirmation:OA-M9K2H1-AABBCCDDEEFF0011

VALUE（普通字符串，不是 JSON）:
  IT-20260904-112700-A1B2
```

pending 删掉以后，`status` 就靠这把钥匙去找 ledger。

### 5.6 会话索引 `pending-idx`（这个人这个会话现在挂着哪张单）

```text
KEY:
  oa-workflow-bridge:pending-idx:103417dabf1825e4b03b03e0:e8b9b86e9fbc3f999572922e

VALUE（普通字符串，不是 JSON）:
  OA-M9K2H1-AABBCCDDEEFF0011
```

作用：同一个人在**同一个 OpenClaw 会话**里，方便点查这张单。企微有时会把「电脑死机」和随后的截图拆成两条投递。`cancel` 或提交成功时必须删**建单时那个会话**的这把钥匙，不能只删当前 `/new` 会话。

钥匙里同时含**人**和**会话**：群里两位同事各建各的单，互不影响。

**同一人跨 `/new` 不许开第二张待确认，靠的是下一节 `person-pending`，不是这把钥匙。**

### 5.7 建单前的附件暂存 `inbox`

员工先甩了一张图、还没说清是什么问题时，附件先存到这里，等 `prepare` 时整批搬进那张单。

```text
KEY:
  oa-workflow-bridge:inbox:103417dabf1825e4b03b03e0:e8b9b86e9fbc3f999572922e

VALUE（字符串，里面是 JSON）:
  {"items":[{"storedName":"01-截图.png","fileName":"截图.png","size":12345,
             "sourcePath":"/home/node/.openclaw/media/inbound/xxxx.png"}],
   "updatedAt":"2026-09-08T08:00:00.000Z"}

过期：SET 时带 PX = inboxTtlMinutes（默认 30 分钟，对齐 OpenClaw 空闲新会话）。`/new` / session_end 会立刻删掉。
```

为什么只有 30 分钟，不像 pending 那样 24 小时：员工发完文件就走开、始终没说清问题的情况很常见；群聊空闲 30 分钟也会开新会话。这些附件不该跨过新会话。`prepare` 认领之后这把钥匙立刻删掉。写 inbox 时会同时写下一节 `person-inbox`，两把钥匙同一套 `PX`。

### 5.8 当前 inbox 落点 `person-inbox`

```text
KEY:
  oa-workflow-bridge:person-inbox:103417dabf1825e4b03b03e0

VALUE（普通字符串，不是 JSON）:
  e8b9b86e9fbc3f999572922e
```

作用：记住这个人**当前**那份尚未 `prepare` 的 inbox 落在哪个 session 码上。员工 `/new` 或 `sessionId` 变了之后，`attach` / `prepare` 先 `GET` 这把钥匙：若指向旧会话，就 `DEL` 旧 `inbox` + 本机 inbox 目录，再写新会话。这样不用 `SCAN` 全库。

`/new` / `session_end` 会立刻把这把钥匙和对应 inbox 一起删掉。`prepare` 认领 inbox 后也一起删。

### 5.9 按人闸门 `person-pending`（这个人现在有没有待确认）

```text
KEY:
  oa-workflow-bridge:person-pending:103417dabf1825e4b03b03e0

VALUE（普通字符串，不是 JSON）:
  OA-M9K2H1-AABBCCDDEEFF0011
```

作用：同一人**全局**最多一张待确认，换了 OpenClaw 会话（`/new`、群聊空闲 30 分钟）也拦住。再 `prepare` 或跨会话 `attach` 都是 `ALREADY_PENDING`。查进度、确认、取消只认这把钥匙指向的那张单，不要求回到原来的会话。

`cancel` 或提交成功时和 pending 一起删掉。删掉之后，这个人才能再开新单。

### 5.10 按人近期状态 `person-tickets`

```text
KEY:
  oa-workflow-bridge:person-tickets:103417dabf1825e4b03b03e0

VALUE（字符串，里面是 JSON 数组，最多 20 条）:
  [{"confirmationId":"OA-M9K2H1-AABBCCDDEEFF0011","status":"submitted",
    "requestId":"1379641","updatedAt":"2026-09-04T03:30:00.000Z"}]
```

没有草稿正文、没有附件路径。`/new` 之后问进度，靠它告诉员工最近已提交的数字 `requestId`。

---

## 6. 整条 Redis 处理流程（按时间）

```text
员工发「电脑坏了」
        │
        ▼
① Agent 先读工作区规则（不碰 Redis）
   必须唯一命中类型 + 系统，否则不问 Redis、不 prepare
        │
        ▼
② oa_workflow.prepare
   GET ledger           → 这张工单号是不是已经提交过 / 正在提交
   GET person-pending   → 这个人是不是已经挂着另一张待确认（跨会话也算）
   GET idmap            → 这个企微人有没有缓存的 OA 人员 id
        │  miss
        ▼
③ 身份适配器（只在 miss 时）
   GET idmiss     → 最近失败过就直接报错，不再打外部接口
   调企微 + 人事（这些不是 Redis）
   SET EX idmap   → 只缓存数字 oaUserId，24 小时
        │  成功才继续
        ▼
④ 附件拷到本机 staging（不进 Redis）
   若 sessionId 已变：先 GET person-inbox，指向旧会话则清掉旧 inbox
   GET inbox           → 建单前 attach 过的附件，认领进本单后立刻 DEL
        │
        ▼
⑤ MULTI 一次写 pending + ledger + idx + pending-idx + person-pending
   （pending / pending-idx / person-pending 带宽限 PX；ledger / idx 无 TTL）
   SET pending         → 待确认底稿
   SET ledger          → 状态 awaiting_confirmation
   SET idx             → 确认单号能找回工单号
   SET pending-idx     → 这个人这个会话挂着哪张单
   SET person-pending  → 这个人全局挂着哪张单
   DEL inbox + person-inbox  → 认领完就不再留建单前缓冲
        │
        ▼
员工看到待确认正文（回显问题 / 地点 / 附件 + 补充引导句 + `**请回复**` + `1. 确认提交` / `2. 取消`；本会话补充直接发图或再写一句）
        │
        ├── 取消 ──────────► DEL pending + 原会话 pending-idx + person-pending，ledger 改成 cancelled
        ├── 改稿 ──────────► 先 cancel，再重新 prepare（仅同一会话）
        └── 确认提交（本会话或 `/new` 后的新会话都可以）
                │
                ▼
⑥ submit_confirmed
   GET pending → 核对是不是原发送人、有没有过期（不要求原会话；另一会话确认不并入新图）
   active=false → 直接 OA_BRIDGE_INACTIVE，pending 不动，不建 OA
   active=true  → 锁内把 pending 标成 submitting
                → 锁外查部门/岗位/地点、调 Ecology 建单
                → 成功：DEL pending + 原会话 pending-idx + person-pending，ledger 改成 submitted（本单 staging 也删；idmap / 对话历史留下，见接入手册 3.3.1）
```

身份失败时 **pending 不会写**，也不会建 OA。

---

## 7. 一张工单走完，Redis 里长什么样

把 Redis 想象成 Excel。

### A. 第一次聊天，身份还没缓存

| KEY | VALUE |
| --- | --- |
| （十把都还没有） | |

### B. 身份查成功（还没 prepare 完）

| KEY | VALUE |
| --- | --- |
| `oa-workflow-bridge:idmap:103417dabf1825e4b03b03e0` | `{"oaUserId":"4357","cachedAt":"..."}` |

### C. prepare 成功，等员工确认

| KEY | VALUE |
| --- | --- |
| `...:idmap:...` | 同上 |
| `...:pending:OA-M9K2H1-AABBCCDDEEFF0011` | 第 5.3 节那整段 pending JSON |
| `...:ledger:IT-20260904-112700-A1B2` | `status=awaiting_confirmation` |
| `...:idx:confirmation:OA-M9K2H1-AABBCCDDEEFF0011` | `IT-20260904-112700-A1B2` |
| `...:pending-idx:...` | `OA-M9K2H1-AABBCCDDEEFF0011` |
| `...:person-pending:...` | `OA-M9K2H1-AABBCCDDEEFF0011` |

### D. 员工点确认，正在调 OA

pending 多一个字段：`"submissionState": "submitting"`  
ledger 的 `status` 改成 `"submitting"`  
其它钥匙还在。

### E. OA 建单成功

| KEY | VALUE |
| --- | --- |
| `...:idmap:...` | 还在（24h 后自己过期） |
| `...:pending:OA-M9K2H1-...` | **没了（DEL）** |
| `...:pending-idx:...` | **没了（DEL）**，必须是建单时那个会话的钥匙 |
| `...:person-pending:...` | **没了（DEL）**，这个人才能再开新单 |
| `...:person-tickets:...` | 多了一条 `submitted` + 数字 `requestId` |
| `...:inbox:...` | 本来就没了（`prepare` 认领时已删） |
| `...:ledger:IT-20260904-112700-A1B2` | `status=submitted`，多了 `"requestId":"1379641"` |
| `...:idx:confirmation:OA-M9K2H1-...` | 还在，方便以后查进度 |

附件副本 `staging/{confirmationId}/` 此时已从本机删掉。通道 `media/inbound` 原件、企微会话 jsonl **不会**因此清空。磁盘 / 会话缓存 / token 的删留全表只在接入手册 **3.3.1**，本节只画 Redis 钥匙。

---

## 8. 五个 action 各自碰哪些钥匙

| 员工/模型在做什么 | action | Redis 实际干什么 |
| --- | --- | --- |
| 「我整理好工单了，请你确认」 | `prepare` | 先读 ledger、**person-pending**、idmap；session 变了则按 **person-inbox** 清旧 inbox，再读 inbox 认领附件；成功后一次写入 pending + ledger + idx + pending-idx + person-pending，并删掉 inbox / person-inbox |
| 员工又发来一张图 / 一个文档 | `attach` | 已有待确认单且**同一会话**：读 pending → 把附件追加进 `staged` → 写回 pending。还没建单：若 `person-inbox` 指向别的 session 则先清旧 inbox，再 `SET inbox` + `SET person-inbox`。**另一会话已有此人待确认**：不写，回 `ALREADY_PENDING`。**不碰** ledger |
| 「这单现在什么状态」 | `status` | **只读**。不带 ID：读 person-pending + person-tickets。带 ID：先看 pending（只核身份，不要求原会话）；没有再走 idx → ledger |
| 「算了，取消」 | `cancel` | 删 pending、原会话 pending-idx、person-pending，ledger 写成 cancelled；idx 留下方便以后点查。跨会话也可以取消 |
| 「确认提交」 | `submit_confirmed` | 读 pending（只核原发送人）→ 标 submitting → 调 OA → 成功就删 pending、原会话 pending-idx、person-pending |

`attach` 存在的理由：以前员工补一张图，模型只能「取消 + 重新建单」，工单编号会变，附件还可能丢。现在补图就只是补图。

`status` 有个容易误解的点：pending 还在、**身份对得上**时（不要求原会话），**未过期**才返回「待确认」。已经过期会返回 `CONFIRMATION_EXPIRED`；正在提交或结果未知会返回 `RECONCILIATION_REQUIRED`，不要再引导员工点确认。

同一工单号 `cancel` 后再 `prepare`：新 confirmation 写入新 idx，旧 idx 删除。`status(旧 confirmationId)` 返回 `NOT_FOUND`，不会串到新单。仅 cancel、尚未再 prepare 时，Redis ledger 仍是小写 `cancelled`，工具回执 `code` 是 **`CANCELLED`**（不要再把 ledger 小写状态直接当工具码）。码表见接入手册 **7.5.2**。

---

## 9. 两套过期，不要混

| | pending / pending-idx / person-pending | ledger / idx / person-tickets | inbox / person-inbox | idmap / idmiss |
| --- | --- | --- | --- | --- |
| 谁写 | 桥接插件 | 桥接插件 | 桥接插件 | 身份适配器 |
| Redis 过期 | `SET PX` = `expiresAt` + 60 秒宽限（兜底回收） | **不设**。钥匙会一直在 | `SET PX` = `inboxTtlMinutes`，默认 30 分钟；两把一起写、一起删 | `SET EX`：idmap 约 24h，idmiss 约 10 分钟 |
| 业务过期 | pending JSON 里的 `expiresAt`（默认 24 小时），**判定只看它** | 无 | 就是 Redis 过期 | 就是 Redis 过期 |

所以：确认条不会在 `expiresAt` 之前消失；Gateway 重启后，只要 Redis 还在，员工仍可以确认。身份缓存会过期，过期后再聊天会重新转换一次。

到期后的 60 秒宽限内，`submit_confirmed`、`status`、`cancel` **都返回** `CONFIRMATION_EXPIRED`（回收 pending / staging，ledger 写成 `expired`），**不是** `CANCELLED`。**宽限过后 Redis 已经把 pending 删掉**，带 ID 的点查同样是 `CONFIRMATION_EXPIRED`（并把 ledger 补成 `expired`），不要再报 `NOT_FOUND`。直接重新 `prepare`。台账（ledger）永久保留，所以防重复不受影响。过期时会清理对应本机 staging；卡在 `submitting` / `unknown` 的那份 staging 先留着，与宿主机 24 小时清 inbound 原件不是同一套。

---

## 10. 身份这条支路（Redis 只当缓存）

查找键是 **`mappingCode`**，不是工号、不是姓名。缓存命中：0 次外部 HTTP。明文 userid、工号、`wo…` 都不进 Redis。

```text
企微加密 userid（wo… 那种长串）
    → 算出 mappingCode（哈希，不是工号）
    → GET idmap
         有  → 直接得到 oaUserId（1–18 位数字）
         无  → GET idmiss
                有负缓存 → 立刻失败
                没有     → 调企微转明文 → 当工号查 OA 人事
                         → 成功 SET EX idmap
                         → 失败 SET EX idmiss
```

桥接 **只 GET idmap**，自己不写身份缓存。转换步骤与错误码只在 [身份适配器说明.md](身份适配器说明.md) 写全。

---

## 11. 三个容易晕的点

1. **Redis 不是锁。** 「锁是进程内队列」意思是同一个 Gateway 里排队，避免两张确认单同时改同一把钥匙。两个 Gateway 连同一 Redis 会双写 OA，所以生产是单 Gateway。

2. **附件不进 Redis。** 文件拷到本机 `staging/{confirmationId}/`，pending 里只记文件名和大小。真正建单时：图片压缩转 data URI 写入 `wtxqmskftp`，文档转 base64 写入 `scfj`。`attachmentFieldName` 为空时带文档必须拒绝。

3. **「身份待核验」不是 Redis 没映射。** 那是企微通道没给展示姓名。OA 申请人有没有映射，只看 `oa_workflow` 回执码（例如 `OA_IDENTITY_NOT_FOUND`）。

---

## 12. 对照源码

Redis 读写在 Node：`oa-workflow-bridge-redis/src/state-store.mjs`、`tool.mjs`，身份缓存在 `wecom-oa-identity-adapter/src/cache.mjs`。不要在本文再维护一份 Python 对照实现。点查样例命令见 OA Redis 手册第 11 节。

---

## 13. 相关文档

| 文档 | 内容 |
| --- | --- |
| [OA插件与Redis链路.md](OA插件与Redis链路.md) | 节点图、hop、五 action 点查 key |
| [OA Workflow Bridge（Redis）接入手册.md](OA%20Workflow%20Bridge（Redis）接入手册.md) | 部署、工具契约、错误码、Key 生命周期；**3.3.1 `SUBMITTED` 后删留** |
| [身份适配器说明.md](身份适配器说明.md) | miss 路径、凭据注入 |
| [企微到OA身份与数据流.md](企微到OA身份与数据流.md) | appid / 调用者 / 申请人、通道字段 |
| [../Aidy 现网加固与演进全景.md](../Aidy%20现网加固与演进全景.md) | 全景：哪些进 OA / 不进 |
| [工单会话隔离与资料回收场景.md](工单会话隔离与资料回收场景.md) | 同一人跨会话只能确认/取消，不能补件/开新单 |
| [../Redis 独立实例部署手册.md](../Redis%20独立实例部署手册.md) | 独立 Redis、AOF、密码分边 |
