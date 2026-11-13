# Aidy 提示词规则优化说明

适用对象：要改工作区规则、把规则包同步到 `~/aidy/workspace/`、或给 `openclaw.json` 加 `skipBootstrap` 的工程师。`oa_workflow` 错误码、身份适配、Compose 启停仍以各专项手册为准，本文不重复。

**本文只讲：** 提示词规则为什么改、改完怎么加载、关键词与确认口令、插件如何硬拦「类型 × 系统」、以及 `skipBootstrap` 怎么加。2026-09-04 起热路径**不再** `read` 状态卡 / 区域映射 / 本机台账：全部运行规则写进已注入的 `AGENTS.md`，幂等看 `oa_workflow`。

规则正文在 `openclaw/workspace-rules/`（人编映射另见 `openclaw/MAPPING_RULES.md` 等）。全景流程见 [Aidy 现网加固与演进全景.md](../Aidy%20现网加固与演进全景.md)。`openclaw.json` 字段见 [openclaw.json 配置参考.md](../openclaw.json%20配置参考.md)。阅读顺序见 [README.md](../README.md)。

对照官方：[Agent workspace](https://docs.openclaw.ai/concepts/agent-workspace)、[Agent runtime](https://docs.openclaw.ai/concepts/agent)、[config-agents — skipBootstrap](https://docs.openclaw.ai/gateway/config-agents)。

---

## 1. 结论

规则内容大体正确。真正拖慢现网的是**热路径多次 `read` 换多次 `model-fetch`**，以及页脚占位和模型扩写问题描述。

旧 `AGENTS.md` 要求每次会话开始依次 `read` 11 个文件。2026-09-02 包改为按场景读映射 / 工单号 / 状态卡。2026-09-04 起：映射、系统清单、工单号与 draft 口径写入已注入的 `AGENTS.md`。同日稍后：状态卡与区域映射也并入 `AGENTS.md`，热路径**禁止再 `read` 任何规则 Markdown**。同日再收紧：热路径**禁止**读写 `memory/ticket-ledger.md`，也禁止 `write` / `edit` / `memory_search` / `memory_get` / `message`。2026-09-09 起：热路径**禁止** `read` inbound 图片 / 文件，禁止根据图意或文档正文猜故障；只发附件只调 `attach`。工单幂等看本会话 `oa_workflow` 回执与插件 Redis。人员页脚文件与运行时不用的 JSON 导出已删除。

状态卡以对照表写入 `AGENTS.md`（员工可见三行格式不变），避免九套模板把单文件顶到截断点。官方默认 `bootstrapMaxChars=20000`，截断点之后的禁令会消失。落地后用 `/context detail` 确认 `AGENTS.md` 未被截断。

---

## 2. 官方注入 vs 旧指令

OpenClaw 在**新会话第一轮**把工作区 bootstrap 文件注入 Project Context。单文件默认上限 20000 字符，合计默认 60000。`MEMORY.md` 根目录存在才注入。缺失的必填文件会注入 missing-file 标记（`MEMORY.md` 除外）。

| 文件 | OpenClaw 行为 | 旧 AGENTS.md | 现网规则包 |
| --- | --- | --- | --- |
| `AGENTS.md` / `SOUL.md` / `IDENTITY.md` | 自动注入 | 会话开始再依次 read | **禁止重读**。2026.9.2 起 `TOOLS.md` **不再**自动注入，工具契约已并入 `AGENTS.md` 的 `## Tools` |
| `MEMORY.md` | 存在则注入；官方要求群聊不要加载私人记忆 | 每次都读，含企微群 | 只留索引；**禁止**再读。工单幂等看 `oa_workflow` / Redis，不读 `ticket-ledger.md` |
| `USER.md` / `HEARTBEAT.md` | 缺失会注入 missing-file 标记 | 未提供 | 已补短桩 |
| `BOOTSTRAP.md` | 全新 workspace 才生成；未设 `skipBootstrap` 可能被重建 | 禁止执行 | 规则禁止执行；配置见第 8 节 |
| `MAPPING_RULES.md` / `ROUTING_RULES.md` / `TICKET_SCHEMA.md` | 不自动注入 | 每次全读 | **禁止 read**；运行时副本在已注入的 `AGENTS.md`。改清单必须同步两处 |
| `TICKET_STATUS_BANNER.md` | 不自动注入 | 每次全读 | **禁止 read**；状态卡对照表在已注入的 `AGENTS.md`。改状态行必须同步两处 |
| `REGION_MAPPING.md` | 不自动注入 | 有已核验部门才读 | **禁止 read**；映射已写入 `AGENTS.md` |
| `OA_WORKFLOW_CONTRACT.md` | 不自动注入 | 每次全读 | 禁止 read；契约摘要在已注入的 `AGENTS.md`（含 `## Tools`） |

---

## 3. 现网规则怎么加载

`AGENTS.md` 决策树：先判断问候 / 进度 / 待确认 / 新问题，只走一条路径。会话开始一次性注入全部运行规则，热路径不要再 `read` 规则文件。

| 场景 | 读取 | 不读 |
| --- | --- | --- |
| 问候 / 你是谁 / 能力介绍 | 无（用已注入文件） | 任何规则 Markdown、台账、页脚 |
| 新工单或归属未定 | **无**（匹配、系统清单、区域映射都在 `AGENTS.md`） | `MAPPING_RULES.md` / `ROUTING_RULES.md` / `REGION_MAPPING.md` / `ticket-ledger.md` |
| 整理 draft / 调用 `oa_workflow` | **无**（draft 口径在 `AGENTS.md`；内部幂等号由插件生成） | `TICKET_SCHEMA.md`；HTTP / Redis / OA 字段名；本机台账 |
| 工单相关回复 | **无**（状态卡在 `AGENTS.md`） | `TICKET_STATUS_BANNER.md`、页脚、已注入文件 |
| 重放 / 进度 / 补充已有单 | **无文件**。`status` 不带 ID：有 pending 出确认卡；没有则原样输出 `hintZh`（条数 + 最多 5 条已提交单号）。**不要**按 OA 工单号查具体进度 | `memory/ticket-ledger.md`、问候不要打开台账 |
| 员工发了图片 / 文件 | **无**（只调 `attach`，凭回执说已收到；随单由插件自动暂存） | inbound 图片 / 文件、规则文件、台账；不要 `read`，不要按图意或文档正文猜故障，不要把路径抄进 draft |

不要输出人员 / 部门 / 大区 / 区域 / 耗时 / 模型 / Token 四行页脚。

### 3.1 文件职责

| 文件 | 职责 |
| --- | --- |
| `AGENTS.md` | 决策树 + 硬约束 + 口令 + 映射 + 清单（全集+排除）+ 区域 + draft + 员工可见回复 + `## Tools`；**无页脚**。OpenClaw 2026.9.2 不再注入 `TOOLS.md` |
| `SOUL.md` | 人格与语气；不扩写问题描述；不重复成功口径；不阅读附件内容 |
| `IDENTITY.md` | 名称、短介绍、完整自我介绍 |
| `OA_WORKFLOW_CONTRACT.md` | 两阶段确认与失败边界（人读；Agent 不 read） |
| `MAPPING_RULES.md` | 关键词、匹配顺序（人编；须同步 `AGENTS.md`；Agent 不 read） |
| `ROUTING_RULES.md` | 类型 → 系统名清单（人编；须同步 `AGENTS.md`；Agent 不 read） |
| `REGION_MAPPING.md` | 部门 → 区域（人编；须同步 `AGENTS.md`；Agent 不 read） |
| `TICKET_SCHEMA.md` | 工单号与 draft 约束（人编；须同步 `AGENTS.md`；Agent 不 read） |
| `TICKET_STATUS_BANNER.md` | 回执码 → 模板块对照（人读；须同步 `AGENTS.md` / `Aidy企微回复模板.md`；Agent 不 read） |
| `Aidy企微回复模板.md` | 员工可见全文（人编；须同步 `AGENTS.md`「用户可见回复」；Agent 不 read） |
| `USER.md` | 多用户服务台，不建个人画像 |
| `HEARTBEAT.md` | 心跳不建单、不联系员工 |
| `MEMORY.md` | 短索引；禁止写入凭据 / SenderId / `confirmationId`；Agent 不要再读 |

---

## 4. 必须保留的硬口径

这些重复是有意防御，已收成 `AGENTS.md` 一块，不要删含义：

- 只有工具回执 `code=SUBMITTED`（大小写不敏感）且含**数字** `requestId`，才能说已创建 OA。认回执字段 `requestId`。
- `OA_BRIDGE_INACTIVE` 不是成功，也不是改走其它系统。禁止循环 `submit_confirmed`（除非员工明确要求再次提交）。
- 零条或多条命中不得猜测系统，不得 `prepare`。
- 确认前改稿必须先 `cancel` 再 `prepare`。不要用 `submit_confirmed` 的 `supplement` 存改稿。
- 不得覆盖 `requesterSenderId`，不得传入 URL、凭据、流程 ID、OA 字段名、人员 id 或建议责任人。
- 禁止 `read` 任何附件。只发图 / 文件只调 `attach`，凭回执说话。`problemDescription` 只抄员工文字，不要写见图 / 见附件。

提示词是请求；`tools.alsoAllow`、工具 schema、`ticket-type-systems.json` 才是门禁。`wecom_mcp` 已不在白名单，规则点到即可。

---

## 5. 身份、区域、关键词、口令

### 5.1 现网短路径

公开版通道没有已核验姓名、部门、大区、区域。不要为此输出「身份待核验 / 未获取 / 计算中」页脚。不得用群名、历史工单、OA 映射或 SenderId 填姓名或地点。

无已核验部门且**本张工单**员工未说明故障地点时：电脑/打印机/网络问题，以及「邮箱系统（国内） / 邮箱系统（越南）」「文件管理系统（国内） / 文件管理系统（越南）」，必须请员工确认，禁止自动选（智园）/（深汕）等。已取消、已提交或历史工单里选过的园区不算「已说明」。`MES系统（越南B部）` 与 `MES系统（越南C部）` 不是同一项：未明确 B 部或 C 部时不得默认任一项。

### 5.2 关键词（相对旧包）

权威：关键词与匹配顺序以 `MAPPING_RULES.md` 为准（须同步已注入的 `AGENTS.md`）。插件认 `system-options.json` + `system-handlers.json` + `ticket-type-systems.json`。版本 `2026-09-07-oa-workspace-mapping-v4`。相对旧包收紧的冲突点：

| 冲突 | 旧词过宽 | 现网 |
| --- | --- | --- |
| 权限申请 | 单字「申请」「账号」 | 短语「申请权限 / 开通账号」。「申请看一下电脑开不了机」走运维支持 |
| IT 需求 | 「优化」「开发」「对接」 | 「IT需求 / 新增功能 / 流程新建」；单独「开发」不够 |
| OA 系统 | 单独「流程」 | 「OA流程 / OA审批 / 待办」 |
| 企业微信 | 「群聊」 | 已删除，避免群里电脑故障被当成企微系统 |
| 地点系统 | 无部门仍可能自动选园区 | 本张工单未说地点则停。取消/提交后新问题不得沿用上一张单的园区 |

### 5.3 当场提交与待确认口令

**当场提交**（跳过二次确认）：原话含 `帮我提交` / `立刻提交` / `马上提交` / `直接提交` / `帮我建单` / `不用确认` 等确定口吻，且类型与系统已唯一、事实已齐 → 同一轮 `prepare` 后立刻 `submit_confirmed`。不要问确认或取消。不要把「好的」「可以」当成当场提交。补地点之后若本单仍带该口吻，补齐后仍当场提交。描述里不要抄这些口令。

**待确认口令**只在没有当场提交口吻、且 `prepare` 已成功、正等待确认时生效。追问地点或补字段时，「好的」「可以」「不用了」只是在回答问题，不是提交；那里的数字按地点序号认（`1` 智园 … `6` 泗洪），不是确认口令。

员工确认卡不要写工单类型 / 所属系统；`💬 问题：` 只抄回执 `summary`（原话开头，长的带 `...`），不要贴 `problemDescription`。头行必须是 `📋 **当前工单**`（`**` 不要省）。问题 / 地点 / 附件写完后必须空一行，再写补充引导句（不要编号），再空一行，再写 `---`，再空一行，再写 `**请回复**`；`---` 紧贴上一行时字会变大。缺 `---` 或写成「请回复」都是错的。到 `2. 取消` 结束，不要 24 小时，不要写成 `3. 补充`，不要问「还需要补充吗」。差必填用 `📝 **当前工单**`，不要和确认卡混用。固定正文见 `Aidy企微回复模板.md`（运行时在 `AGENTS.md`）。差地点先回显再问：`📝 已记下：电脑死机。` + 园区 1–6。本会话确认卡：

```text
📋 **当前工单**

💬 问题：电脑死机
📍 地点：智园

内容不对或还缺信息，直接再写一句，或发图片、文档。

---

**请回复**
1. 确认提交
2. 取消
```

一次贴很长时只露开头：

```text
📋 **当前工单**

💬 问题：4 个厂区同时用一套系统接单号...

内容不对或还缺信息，直接再写一句，或发图片、文档。

---

**请回复**
1. 确认提交
2. 取消
```

跨 `/new` 碰到旧待确认时：用拦截卡，不要本会话确认卡；**不要让员工回到上一会话**。拦截卡保留「现在不能给上一张补图或改描述」和 24 小时。上一张抄 `status` / `ALREADY_PENDING` 的 `summary` / `location` / 附件计数，刚才说的抄本会话这一句。`/new` 后第一句新问题先不带 ID 调 `status`，有跨会话 pending 就出拦截卡，不要先问地点。拦截卡口令写成「确认提交上一张 / 取消上一张」，避免和地点 1–6 撞车：

```text
⚠️ **还有一张未提交的确认单**

上一张
💬 电脑死机
📍 智园
📎 2份图片、1份文档

刚才说的
💬 电脑蓝屏（尚未建单）

请先处理上一张，才能报新问题。

---

**请回复**
1. 确认提交上一张
2. 取消上一张

---

> 现在不能给上一张补图或改描述。
> 24 小时内未确认或取消，上一张会自动清除。
```

取消旧单且本会话已报新问题：同一轮「🗑️ **上一张已取消**（问题）」+ `---` 接力当前单（差地点则问 1–6，差邮箱/文件国内越南、MES B/C、IT 需求则复用 4b–4d，事实已齐则 `prepare` 出当前确认卡），禁止只回取消短句。附件回执按累计 `imageCount` / `documentCount`（1 也要写）：`📎 已收到 1份图片` / `📎 已收到 1份文档`；都有则 `📎 已收到 1份图片、1份文档`。不要写「文件已收到」，不要用 `<font>`。

- **确认提交**：`确认提交`、`确认`、`提交`、`提交吧`、`1`、`1.`、`1.确认提交`、`1. 确认提交`、`1、确认提交`。不要把「好的」「可以」「OK」「没问题」「就这样」「不用了」「不用补充」当成提交。同一句里还有新事实或 `补充：`，视为改稿。员工回「不用了」时用「请改口」正文再重发确认卡。
- **取消**：`取消`、`不要了`、`算了`、`先不提交`、`2`、`2.`、`2.取消`、`2. 取消`、`2、取消`。
- **补充不是口令**：直接发图片 / 文件（`attach`），或再写一句新事实（`cancel` 再 `prepare`）。**不必**打 `补充：`。成功后回执在上（`📎 已收到 N份图片` / `📎 已收到 N份文档` / `📝 已补充描述`），再重发待确认正文。
- **不是操作**（仅上一句已是确认卡时）：`3`、`3.`、`请回复`、`**请回复**`，或把补充引导句整句发回来（「内容不对或还缺信息…」/「还可以继续改文字…」）→ 重发待确认正文。问地点时 `3` 是深汕。

### 5.4 最少字段即可 prepare

必填：类型、系统、摘要、问题描述。电脑/打印机/网络问题另传 `location`。IT 需求另加需求类型、月节约工时。影响范围 / 发生时间 / 已尝试措施**默认不传**；员工没说就不要传，禁止写成「员工未说明」。`summary` 用员工原话开头：短的原样（如 `电脑死机`），长的截到约 20 字加 `...`（如 `4 个厂区同时用一套系统接单号...`），不要改写成另一句。`problemDescription` 只抄员工说过的问题本身：短句短抄，一次很长或断续多轮按顺序合并，不要丢掉细节，也不要贴到确认卡。地点只用于匹配所属系统并写入 `location`，**不要**写进描述。禁止「员工反馈」「现象描述」「待现场核实」「故障地点」「未进一步说明」和常识推断。提交成功后的企微正文用「已提交到 OA」块；数字 `requestId` 只放 `🎫 工单号：`，上一行回显 `💬 问题：`（抄回执 `summary`），不要再写「OA 单号」，不要补诊断建议。员工可见全文以 `Aidy企微回复模板.md` 为准。

---

## 6. 插件硬拦：类型 × 系统

旧逻辑：`mapping.mjs` 只查扁平的 `system-options.json`。提示词写「权限申请不能选电脑/打印机」，插件仍会接受。

现网：`prepare` 会加载 `oa-workflow-bridge-redis/ticket-type-systems.json`，与 `ROUTING_RULES.md` 三类清单对齐。非法组合抛 `System name is not allowed for this ticket type`。

| 类型 | 没有这些系统 |
| --- | --- |
| 权限申请 | 电脑/打印机/网络问题（各地点）、OA开发支持、ERP开发支持、北森招聘系统 |
| IT需求 | 「邮箱系统（国内）」、电脑/打印机/网络问题、OA开发支持、ERP开发支持、北森招聘系统 |

测试：`OA_tool/oa-workflow-bridge-redis` 下 `npm test`（含类型白名单用例）。只改 workspace 规则、不更新插件代码和该 JSON，白名单不会生效。

---

## 7. 把规则同步到现网 workspace

本仓库规则在 `openclaw/workspace-rules/`。现网工作区是 `~/aidy/workspace/`（容器 `/home/node/.openclaw/workspace`）。

```bash
# 在 WSL 家目录；不要覆盖已有 memory/ticket-ledger.md 时先备份
REPO=/mnt/f/workspace/ADK-OFFICE/openclaw/linux
cp -a ~/aidy/workspace/memory/ticket-ledger.md /tmp/ticket-ledger.md.bak 2>/dev/null || true
cp -r "$REPO/openclaw/workspace-rules/." ~/aidy/workspace/
cp "$REPO/openclaw/MAPPING_RULES.md" "$REPO/openclaw/ROUTING_RULES.md" \
   "$REPO/openclaw/REGION_MAPPING.md" "$REPO/openclaw/TICKET_SCHEMA.md" \
   "$REPO/openclaw/TICKET_STATUS_BANNER.md" "$REPO/openclaw/OA_WORKFLOW_CONTRACT.md" \
   ~/aidy/workspace/
# 若上面备份了台账，再拷回去
test -f /tmp/ticket-ledger.md.bak && cp /tmp/ticket-ledger.md.bak ~/aidy/workspace/memory/ticket-ledger.md
sudo chown -R 1000:1000 ~/aidy/workspace
```

`REPO` 换成本仓库路径。插件侧同时更新：

- `ticket-type-systems.json`（新文件）
- `src/mapping.mjs`、`src/config.mjs`、`src/tool.mjs`

工作区 Markdown 一般下一轮对话生效，通常不用重启 Gateway。改 `openclaw.json` 或插件代码后：配置热加载或 `restart`，插件 `load.paths` 变更必须重启。见运维手册。

---

## 8. 怎么加 `"skipBootstrap": true`

### 8.1 它做什么、不做什么

官方字段：`agents.defaults.skipBootstrap`。

- **做：** 禁止 OpenClaw 自动生成 `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`BOOTSTRAP.md`。你们已经自己维护规则包，应打开。
- **不做：** 不会停止注入**已有**规则。`AGENTS.md` 等仍进入 system prompt，这是需要的。
- **不要**设 `agents.defaults.contextInjection: "never"`。那会让工作区规则整包不进模型。

加开关前，确认 `~/aidy/workspace/` 已有第 7 节那套文件（含 `USER.md` / `HEARTBEAT.md` / `MEMORY.md`）。`skipBootstrap` 只阻止自动生成，不会替你补文件。

### 8.2 加在哪

`skipBootstrap` 加在 **`agents.defaults`**。

`bootstrapMaxChars` 和 `skills` **defaults 与 `itservicedeskagent` 都要写**。只写 defaults 时，2026.9.2 对已绑定 Agent 仍可能用内置默认（单文件 20000、Skill 不限制）。`/context detail` 的 tip 指向的是 `agents.entries.<id>.bootstrapMaxChars`，不是只改 defaults。

现网文件：`~/aidy/config/openclaw.json` → 容器内 `/home/node/.openclaw/openclaw.json`。改 git 仓库里的模板**不会**自动进容器。OpenClaw 2026.9.2 用 `agents.entries`（键名即 Agent id），不再用 `agents.list[]`。现网样例见配置参考第 15 节：

```json
"agents": {
  "defaults": {
    "skipBootstrap": true,
    "bootstrapMaxChars": 40000,
    "skills": []
  },
  "entries": {
    "itservicedeskagent": {
      "name": "ITServiceDeskAgent",
      "workspace": "/home/node/.openclaw/workspace",
      "agentDir": "/home/node/.openclaw/agents/itservicedeskagent/agent",
      "model": "${AIDY_DOMESTIC_MODEL_REF}",
      "bootstrapMaxChars": 40000,
      "skills": []
    }
  }
}
```

上面 `entries` 项只示意位置；完整 `identity` / `tools` / `thinkingDefault` 不要删，以现网文件为准。

### 8.3 校验

```bash
docker exec -it aidy-gateway node dist/index.js config validate
```

通过即可。多数字段热加载，新会话生效；`validate` 报错或行为没变再 `restart` Gateway。容器名以 `compose ps` 为准，不一定是 `aidy-gateway`。

### 8.4 现网已截断：加 `bootstrapMaxChars`

`/context detail` 实测（2026-09-10）：只改 `agents.defaults.bootstrapMaxChars` **不生效**。同一份 dump 仍是 `Bootstrap max/file: 20,000`，`AGENTS.md` raw **20,241** 被截成 `TRUNCATED`；`Skills list` 仍约 30 个。`skipBootstrap` **不会**放宽注入上限。

必须在 **`agents.defaults` 和 `agents.entries.itservicedeskagent` 两处都写**：

```json
"bootstrapMaxChars": 40000,
"skills": []
```

40000 给同步后的规则包留余量。合计 60,000 未超，不必改 `bootstrapTotalMaxChars`。

改完后按这个顺序，缺一步都会看起来「不生效」：

1. 改的是 **`~/aidy/config/openclaw.json`**（容器内 `/home/node/.openclaw/openclaw.json`），不是文档仓库里的副本。
2. `docker exec -it aidy-gateway grep -n bootstrapMaxChars /home/node/.openclaw/openclaw.json` 必须出现 **两处** `40000`（defaults + itservicedeskagent）。
3. `config validate`，然后 **`compose restart` Gateway**（不要只靠热加载）。
4. 企微里**单独一条**发 `/new`，再**单独一条**发 `/context detail`。旧会话会缓存截断后的 bootstrap 和 `skillsSnapshot`。`/context` 不是 inline shortcut，不能写在「帮我看下 /context detail」这种句子里。

通过标准：`Bootstrap max/file: 40,000`；`AGENTS.md` 为 `OK`；`Skills list` 为 0。

### 8.5 Skill 目录不是 `skills.entries` 全关

`skills.entries.<id>.enabled: false` 只关掉点了名的 bundled。省略 `agents.defaults.skills` 表示**不限制**。企微插件仍会把 `wecomcli-*` 注入 `<available_skills>`（现网 `/context detail` 曾 30 个、约 1 万字符）。

Aidy 必须在 **`agents.defaults` 和 `agents.entries.itservicedeskagent` 两处**都写：

```json
"skills": []
```

不要用 `skills.allowBundled` 当总开关（挡不住插件 skill）。改完须 restart + `/new`；目标 `Skills list` 为 0。正文见 [openclaw.json 配置参考.md](../openclaw.json%20配置参考.md) 第 11.3 节。

---

## 9. 不要做的事

- 不要把 `TICKET_STATUS_BANNER.md` 九套完整代码块原样粘进 `AGENTS.md`（用对照表，员工可见三行格式不变）。映射 / 路由 / 工单号 / 状态卡 / 区域已经在 `AGENTS.md`；落地后用 `/context detail` 确认未被 `bootstrapMaxChars`（默认 20000）截断。不要为了「再确认规则」在热路径 `read`。
- 不要把 `skills.entries.*.enabled: false` 当成「全部 skill 已关」。Aidy 必须在 defaults **和** `itservicedeskagent` 都写 `skills: []`，否则企微插件的 `wecomcli-*` 仍进 system prompt。
- 不要恢复已停用的回复状态栏。
- 不要在提示词里教模型 OA 字段名、`doCreateRequest`、HTTP `requestid`、Redis 键、SHA-256。模型只认工具回执的 `code` 与 `requestId`。
- 不要把 `wecom-oa-identity-adapter` 写入 `tools.alsoAllow`。
- 不要在 `active=false` 时把 `OA_BRIDGE_INACTIVE` 说成已创建 OA。
- 不要用 `openclaw doctor --fix` 当第一次生产试验（可能改 `agents.entries` 结构）。见运维手册。

---

## 10. 相关文档

| 文档 | 内容 |
| --- | --- |
| `openclaw/workspace-rules/AGENTS.md` | 运行规则（决策树 / 硬约束 / 口令 / 映射 / 清单全集+排除 / 区域 / draft / 员工可见回复 / `## Tools`；无页脚） |
| `openclaw/MAPPING_RULES.md` | 关键词与失败边界（人编，须同步 AGENTS.md） |
| `openclaw/ROUTING_RULES.md` | 类型 → 系统名清单（人编，须同步 AGENTS.md） |
| [Aidy企微回复模板.md](Aidy企微回复模板.md) | 员工可见全文；改一句必须同步 `AGENTS.md` |
| [OA Workflow Bridge（Redis）接入手册](../OA_tool/OA%20Workflow%20Bridge（Redis）接入手册.md) | `oa_workflow` 契约与错误码 |
| [openclaw.json 配置参考](../openclaw.json%20配置参考.md) 第 4.2 / 15 节 | `skipBootstrap` 字段；现网 json 样例 |
| [DashScope 兼容 Provider 配置手册](../DashScope%20兼容%20Provider%20配置手册.md) §2.5 | `MEMORY.md` 缺失导致二次 `model-fetch` |
| [Aidy 现网加固与演进全景](../Aidy%20现网加固与演进全景.md) | 各层 I/O；工作区规则在 `prepare` 之前用完 |
