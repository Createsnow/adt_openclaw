# openclaw.json 配置参考

> 本文档由仓库根目录原文档**重组**而来：只调整章节归属与交叉引用，**不改变**部署步骤、命令、YAML、错误码或禁止事项。阅读顺序见 [README.md](README.md)。

适用对象：在 xA / WSL2 Docker 或 Linux 服务器环境维护 OpenClaw Gateway 的工程师。

本文档说明 `openclaw.json` 各顶层块及常用字段的含义与作用，并结合本仓库 `openclaw/openclaw.json` 举例。**完整、实时的字段列表以 OpenClaw 官方文档与本地 schema 为准。**

---

## 0. 文件基础

| 项 | 说明 |
| --- | --- |
| 默认路径 | `~/.openclaw/openclaw.json`（Docker 挂载时常为 `~/xa/config/openclaw.json` → 容器内 `/home/node/.openclaw/openclaw.json`） |
| 格式 | **JSON5**（允许注释、尾逗号）；校验时按 JSON Schema 严格验证 |
| 环境变量覆盖 | `OPENCLAW_CONFIG_PATH` 指向配置文件；`OPENCLAW_STATE_DIR` 指向状态目录 |
| 占位符 | 字符串中 `${VAR_NAME}` 引用环境变量（仅大写 `[A-Z_][A-Z0-9_]*`） |
| 热重载 | Gateway 监视文件变更；多数字段可热更新，**插件 load.paths、gateway 端口/bind 等需重启** |

**官方入口：**

- [Configuration（配置概览）](https://docs.openclaw.ai/gateway/configuration)
- [Configuration reference（完整字段参考）](https://docs.openclaw.ai/gateway/configuration-reference)
- [Configuration — agents](https://docs.openclaw.ai/gateway/config-agents)
- [Configuration — tools and custom providers](https://docs.openclaw.ai/gateway/config-tools)
- [Secrets Management](https://docs.openclaw.ai/gateway/secrets)

**本地校验：**

```bash
openclaw config validate
openclaw config schema          # 打印当前版本的 JSON Schema
openclaw config get <path>      # 读取单个路径
openclaw doctor --fix           # 修复常见配置问题
```

> **版本说明：** OpenClaw 2026.9.2 以 `agents.defaults` + `agents.entries` 描述多 Agent。xA 现网已迁到 **`agents.entries`**（键名即 Agent id）。旧模板若仍是 `agents.list[]`，升级镜像后用 `openclaw doctor --fix` 迁移，再 `config validate`。不要把 `list` 与 `entries` 混写。

---

## 1. 顶层结构总览

```text
openclaw.json
├── meta                 # OpenClaw 运行时元数据（非业务配置）
├── secrets              # 密钥解析 Provider（DPAPI / exec / file / env）
├── env                  # 内联环境变量、shell 环境导入
├── agents               # Agent 定义与默认行为
├── tools                # 全局工具权限策略
├── bindings             # 通道消息 → Agent 路由
├── channels             # 各消息通道配置（含插件通道）
├── gateway              # Gateway 进程：端口、绑定、鉴权
├── plugins              # 插件加载与白名单
├── models               # 模型 Provider 与 catalog
├── session              # 会话生命周期、DM 隔离
├── messages             # 消息投递、群聊 @、可见回复
├── skills               # Skill 加载与条目
├── mcp                  # MCP 服务器定义
├── hooks                # HTTP Webhook 入口
├── cron                 # 定时任务
├── logging / diagnostics / telemetry
└── …                    # 见第 12 节「其他顶层块」
```

**配置分层原则（官方）：**

- **根级兄弟节点**：基础设施、跨 Agent 默认值（gateway、channels、plugins、tools…）
- **`agents.defaults`**：Agent 循环行为的共享默认
- **`agents.entries.*`**：单个 Agent 的覆盖项（键名即 Agent id）

---

## 2. `meta`

OpenClaw 在保存配置时自动写入的运行时标记。

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `lastTouchedVersion` | string | 最后一次写入配置的 OpenClaw 版本 |
| `lastTouchedAt` | string | ISO 时间戳 |
| `migrations.*` | boolean | 已执行的配置迁移标记。2026.9.2 现网有 `modelPolicyAllowlist: true` |

**注意：** 旧 Windows 模板中的 `meta.handoffTemplate`、`sourceSnapshotDate` 等 **不是** OpenClaw 合法字段，会导致 `meta: Invalid input`，部署前必须删除。本仓库 `openclaw/openclaw.json` 里的 `lastTouchedVersion` / `migrations` 是合法字段，保留。

---

## 3. `secrets`

定义密钥如何从外部系统解析，供 `SecretRef` 和 exec 类凭据使用。

### 3.1 `secrets.providers`

| 字段 | 作用 |
| --- | --- |
| `source` | `env` \| `file` \| `exec` \| `store` |
| `command` / `args` | `exec` 时调用的外部解析器（如 PowerShell + DPAPI 脚本） |
| `path` | `file` 时的 JSON 密钥文件路径 |
| `timeoutMs` | exec 超时 |
| `maxOutputBytes` | exec  stdout 上限 |
| `jsonOnly` | 要求解析器只输出 JSON |
| `passEnv` | 传给 exec 子进程的环境变量白名单 |

**xA Windows 示例：** `enterprise-secrets` → `Resolve-OpenClawSecrets.ps1`  
**xA Docker：** 通常 **删除** 整个 `secrets.providers` 段，改用 entrypoint 注入 `${OPENCLAW_GATEWAY_TOKEN}` 等环境变量。

### 3.2 SecretRef 对象形态

用于 `gateway.auth.token`、模型 API Key、通道凭据等：

```json
{
  "source": "exec",
  "provider": "enterprise-secrets",
  "id": "gateway/xa-it-service/auth/token"
}
```

| source | id 含义 |
| --- | --- |
| `env` | 环境变量名，如 `OPENCLAW_GATEWAY_TOKEN` |
| `file` | JSON 文件内指针 |
| `exec` | 解析器中的逻辑密钥 ID |
| `store` | OpenClaw 内置密钥存储 |

详见 [Secrets Management](https://docs.openclaw.ai/gateway/secrets)。

---

## 4. `agents`

定义 Agent 身份、工作区、模型、工具策略等。

### 4.1 xA 现网 `agents.entries`（2026.9.2）

Agent id 是 **对象键名**，不再写 `id` 字段：

```json
"agents": {
  "defaults": { "skipBootstrap": true, "bootstrapMaxChars": 40000 },
  "entries": {
    "itservicedeskagent": {
      "name": "ITServiceDeskAgent",
      "workspace": "/home/node/.openclaw/workspace",
      "agentDir": "/home/node/.openclaw/agents/itservicedeskagent/agent",
      "model": "${XA_DOMESTIC_MODEL_REF}",
      "thinkingDefault": "off"
    }
  }
}
```

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `entries` 的键 | string | Agent 唯一 ID，如 `itservicedeskagent`；须与 `bindings[].agentId` 一致 |
| `name` | string | 内部显示名 |
| `workspace` | string | 工作区根目录（规则文件 AGENTS.md、幂等状态等） |
| `agentDir` | string | Agent 私有目录（auth-profiles、agent 级配置） |
| `model` | string | 主模型 ref，格式 `provider/model-name` |
| `thinkingDefault` | string | 会话思考级别；xA 用 `"off"` |
| `identity.name` | string | 对外展示名（如「小A」） |
| `identity.theme` | string | 角色主题描述，进入 system prompt |
| `identity.emoji` | string | 头像/反应默认 emoji |
| `identity.avatar` | string | 可选：工作区相对路径或 URL |
| `subagents.allowAgents` | string[] | 允许 `sessions_spawn` 的目标 Agent；`[]` 禁止子 Agent |
| `tools` | object | **该 Agent 专属**工具策略（见第 5 节） |

**路径约定（Docker）：**

```text
workspace  → /home/node/.openclaw/workspace
agentDir   → /home/node/.openclaw/agents/itservicedeskagent/agent
```

### 4.2 官方推荐的 `agents.defaults` + `agents.entries`

较新版本文档以 **对象 map** 描述多 Agent：

```json5
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "model": { "primary": "anthropic/claude-sonnet-4-6" },
      "sandbox": { "mode": "off" },
      "skills": ["github"]
    },
    "entries": {
      "main": { "default": true },
      "ops": { "workspace": "~/.openclaw/workspace-ops" }
    }
  }
}
```

常用 `agents.defaults` 字段（详见 [config-agents](https://docs.openclaw.ai/gateway/config-agents)）：

| 字段 | 作用 |
| --- | --- |
| `workspace` | 默认工作区 |
| `model.primary` / `fallbacks` | 主模型与回退链 |
| `models` | 模型别名、per-model 参数 |
| `thinkingDefault` | 思考级别 default |
| `heartbeat` | 定时心跳 Agent 运行 |
| `sandbox` | 工具沙箱：`mode` off/non-main/all；`scope` session/agent/shared |
| `skills` | Agent 可见 Skill **白名单**。省略 = 不限制；`[]` = 一个都不进 system prompt。xA 必须 `[]` |
| `skipBootstrap` | 跳过自动生成 AGENTS.md 等 |
| `bootstrapMaxChars` | 单份 bootstrap 文件注入上限（默认 20000）。现网 `AGENTS.md` 已超限，**defaults 与 `itservicedeskagent` 都要写 `40000`**；只写 defaults，2026.9.2 的 `/context detail` 仍可能显示 20,000 |
| `bootstrapTotalMaxChars` | 全部 bootstrap 合计上限（默认 60000）。xA 合计未超，一般不用改 |
| `utilityModel` | 内部短任务用的小模型 |

---

## 5. `tools`（全局工具策略）

控制 **Agent 能调用哪些工具**（工具名/id），与 **插件是否加载** 是两层门控。

### 5.1 核心字段

| 字段 | 作用 |
| --- | --- |
| `profile` | 基础工具模板：`minimal` \| `coding` \| `messaging` \| `full` |
| `alsoAllow` | 在 profile 基础上 **追加** 允许的工具名 |
| `allow` | 显式允许列表（与 `alsoAllow` **不能同作用域并存**） |
| `deny` | 拒绝列表（**deny 优先**） |
| `elevated.enabled` | 是否允许提权 exec 逃逸沙箱 |
| `elevated.allowFrom` | 按通道限制谁可提权 |
| `fs.workspaceOnly` | 文件工具仅限 workspace 内 |
| `media.image/audio/video.enabled` | 是否做 inbound 媒体理解 / 把媒体送给模型。xA **三项都必须 `false`**，否则发图会多一段 `reply.apply_media_understanding`（现网 7.2s）。这与 `alsoAllow` 不是同一层；`enabled: false` 才关掉 reply 流水线里的自动理解 |
| `sessions.visibility` | 会话树可见性，如 `tree` |
| `agentToAgent.enabled` | Agent 间调用 |
| `agentToAgent.allow` | 允许的 Agent id 列表 |
| `byProvider` | 按 provider/model 进一步收紧工具 |
| `toolsBySender` | 按消息发送人进一步收紧（纵深防御） |
| `sandbox.tools` | 沙箱会话内的额外工具门控 |

### 5.2 `profile` 预设含义

| profile | 大致包含 |
| --- | --- |
| `minimal` | 仅 `session_status` |
| `coding` | fs、runtime、web、sessions、memory、cron、部分 agents 工具等 |
| `messaging` | 消息与会话相关工具 |
| `full` | 不限制内置工具 |

xA 使用 **`minimal` + alsoAllow**，只打开 `oa_workflow`。**不要**把 `read` 加入 `alsoAllow`：2026.9.2 现网在 Agent 级 `deny` 含 `group:fs`，热路径禁止读附件与规则文件；inbound 由插件自动暂存。不要把 `write` / `edit` / `memory_search` / `memory_get` / `message` / `wecom_mcp` 加入 `alsoAllow`。插件 `bridge-config.json` 须 `active=true` 才会真正建单。工单幂等由 Redis ledger 负责，不要让模型写本机台账。

全局必须关 `tools.media.image/audio/video.enabled`（三项都 `false`），并保持 catalog `input: ["text"]`。不要设 `agents.defaults.imageModel`：设了会给图片理解另一条自动探测路径。附件仍由企微通道落盘、`oa_workflow` 暂存。

### 5.3 常用 `deny` 组（group）

| 组 | 包含工具类型 |
| --- | --- |
| `group:runtime` | `exec`、`process`、代码执行 |
| `group:fs` | `read`、`write`、`edit`、`apply_patch` |
| `group:web` | `web_search`、`web_fetch` |
| `group:ui` | `browser`、`canvas`、`terminal` 等 |
| `group:automation` | `cron`、`gateway` |
| `group:messaging` | `message` |
| `group:plugins` | 所有已加载插件注册的工具 |

### 5.4 Agent 级 `tools` vs 全局 `tools`

| 层级 | 路径 | 作用 |
| --- | --- | --- |
| 全局 | `tools.*` | Gateway 默认工具策略 |
| Agent | `agents.entries.*.tools.*` | 单个 Agent 覆盖/细化 |

合并规则：**Agent 级覆盖全局**；`deny` 始终优先。  
xA 两处配置相同，表示该 Agent 与全局策略一致。

### 5.5 插件 vs 工具（两层开关）

**插件**是装进 Gateway 的包（`openclaw.plugin.json` 的 id）。加载后可以向 Gateway 登记通道、工具、hooks 等，也可以什么都不登记给模型。  
**工具**是模型本轮可以点名调用的函数名。`tools.profile: minimal` 下，插件即使已经 `registerTool`，模型也只能调用 `alsoAllow` 里的名字。

```text
plugins.allow / load.paths / entries.enabled
        ↓
   插件被加载，向 Gateway 登记能力
        ├── 通道（收发企微）     ← 不走 alsoAllow
        ├── 工具（模型可调）     ← 还要写进 alsoAllow 模型才能用
        ├── Skill 目录（进 system prompt）← 走 agents.*.skills 白名单，不是 alsoAllow
        └── 其它（hooks、logger）← 模型看不见
```

| 名单 | 管什么 | 不管什么 |
| --- | --- | --- |
| `plugins.allow` + `entries.<id>.enabled` | 这个 **插件 id** 能不能加载 | 模型会不会调用某个函数、skill 目录会不会进 prompt |
| `tools.alsoAllow` | 这个 **工具名** 模型能不能调 | 通道还在不在、skill 目录还在不在 |
| `agents.defaults.skills` / `entries.*.skills` | 哪些 **Skill 名** 进 `<available_skills>` | 通道、工具白名单 |

因此：插件已 `loaded`，工具却可能调不了（没进 `alsoAllow`）；白名单写了工具名，插件没加载则根本注册不上。

**插件 id ≠ 工具名。** 一个插件可以只做通道、只做工具、两者都做，或不注册模型 tool。

| 包（插件 id） | 加载后登记了什么 | 模型要不要点名 |
| --- | --- | --- |
| `wecom-openclaw-plugin` | **通道** `wecom` + **工具** `wecom_mcp` + **Skill** `wecomcli-*` / `wecom-send-*` | 通道：不用 `alsoAllow`。`wecom_mcp`：写入才会被模型调用。Skill 目录：要 `agents.*.skills` 白名单放行才会进 prompt |
| `oa-workflow-bridge-redis` | **只有工具** `oa_workflow`，没有通道 | 必须 `alsoAllow` 含 `oa_workflow`，否则 Agent 建不了单 |
| `wecom-oa-identity-adapter` | 不 `registerTool`；桥接 `import` 它 | **不要**写入 `alsoAllow`，默认也不必出现在 `plugins.allow` |

OA 桥接「最后也当工具用」：对模型暴露的入口就是 `oa_workflow`。它仍然先是插件——不进 `plugins.allow` / `load.paths`，Gateway 不会 `registerTool`，后面白名单写了也没用。HTTP、Redis、身份映射都在插件进程里跑，模型不能直调 Ecology。

企微插件是「一个包、多种能力」。去掉 `alsoAllow` 里的 `wecom_mcp` **不会**关掉企业微信，也 **不会**自动去掉 `wecomcli-smartsheet` 等 Skill 目录。xA 热路径**不要**把 `message` / `write` / `edit` / `memory_*` / `read` 放进 `alsoAllow`；同时必须 `agents.defaults.skills: []`，否则 `/context detail` 仍会列出约 30 个 skill（现网曾占约 1 万字符）。工单正文由模型直接输出，通道负责发出；幂等看 Redis，不写本机台账。inbound 附件由插件自动暂存，不要用 `read` 看图或文档。

```text
员工发消息
  → 通道 wecom（插件内部 WebSocket）     ← 只要插件 enabled + channels.wecom
  → Gateway 把可信 ctx 交给 Agent
  → Agent 只能调 alsoAllow 里的名字
        ├─ oa_workflow     ← 要（建单）
        └─ wecom_mcp / read / write / edit / memory_* / message ← xA 不要
  → 回复仍由通道 wecom 发出去            ← 还是插件，不是 wecom_mcp
```

xA 现网：两处 `alsoAllow`（全局 + `itservicedeskagent`）均只含 `oa_workflow`，**不含** `read` / `wecom_mcp` / `write` / `edit` / `memory_search` / `memory_get` / `message`，也不要把插件 id `wecom-openclaw-plugin` 写进 `alsoAllow`。两处必须一致。Agent 级 `deny` 含 `group:fs`（关掉 `read`/`write`/`edit`）。`tools.media.*.enabled` 为 `false`。`agents.defaults.skipBootstrap` 为 `true`。`agents.defaults.skills` 为 `[]`（Skill 一个都不进 prompt）。身份适配器开关在桥接 `bridge-config.json` 的 `identity.adapter`，见 `OA_tool/身份适配器说明.md` 第 10 节。日志若再出现 `smartsheet_get_records`，见 `WeCom 通道插件接入手册.md` 9.2。

---

## 6. `bindings`（消息路由）

将入站通道消息路由到指定 Agent。**与 `gateway.bind` 无关**——后者控制 Gateway 监听哪个网络接口（见第 8.1 节）。

```json
{
  "type": "route",
  "agentId": "itservicedeskagent",
  "match": {
    "channel": "wecom",
    "accountId": "default"
  }
}
```

### 6.1 字段说明

| 字段 | 作用 |
| --- | --- |
| `type` | `route`（默认）或 `acp`（持久 ACP 会话绑定） |
| `agentId` | 目标 Agent id，须与 `agents.entries` 键名一致 |
| `match.channel` | 通道 id（如 `wecom`、`telegram`）；通道须已由插件注册且 `channels.<id>` 已配置 |
| `match.accountId` | 通道账号 id（企微单账号常为 `default`） |
| `match.peer` | 可选：精确到 DM/群/线程（更细粒度路由） |
| `session` | 可选：覆盖 matched 会话的 `dmScope` / `groupScope` |

### 6.2 `type` 两种模式

| type | 作用 | 典型场景 |
| --- | --- | --- |
| `route` | 按 `match` 条件将消息交给指定 Agent | 企微 → IT 服务台 Agent（xA 默认） |
| `acp` | 持久 ACP（Agent Conversation Protocol）会话绑定 | 需要长期固定会话上下文的集成场景 |

### 6.3 匹配与优先级

- 数组中 **从上到下** 依次匹配，**第一条命中 wins**，后续规则不再评估。
- 无匹配时走 Gateway 默认 Agent（`agents.defaults` 或标记 `default: true` 的 entry）。
- 验证命令：`openclaw agents list --bindings`（Docker：`docker exec ... node dist/index.js agents list --bindings`）。

### 6.4 多 Agent 示例

同一 Gateway 内两个业务 Agent，按通道账号分流：

```json
"bindings": [
  {
    "type": "route",
    "agentId": "itservicedeskagent",
    "match": { "channel": "wecom", "accountId": "default" }
  },
  {
    "type": "route",
    "agentId": "hragent",
    "match": { "channel": "wecom", "accountId": "hr-bot" }
  }
]
```

**注意：** 通道不存在或未 enable 时，binding 不会生效（如暂时去掉 `channels.wecom`，`channel: wecom` 的 binding 可保留但不会路由）。企微插件当前为单账号模式，多账号路由须先验证插件能力。

详见 [Multi-Agent](https://docs.openclaw.ai/concepts/multi-agent)。

---

## 7. `channels`

各消息通道的连接、访问控制、账号配置。结构为 **`channels.<channelId>`**。

### 7.1 通用字段（多数通道共享）

| 字段 | 作用 |
| --- | --- |
| `enabled` | 是否启用该通道 |
| `dmPolicy` | 私聊策略：`pairing` \| `allowlist` \| `open` \| `disabled` |
| `allowFrom` | 允许的发送者列表；`open` 时需含 `"*"` |
| `groupPolicy` | 群聊策略：`allowlist` \| `open` \| `disabled` |
| `groupAllowFrom` | 群聊允许列表 |
| `sendThinkingMessage` | 是否发送「思考中」占位消息。xA 现网 `true`（OpenClaw 2026.9.2 + 企微插件须 ≥ 2026.7.2）。与百炼 `enable_thinking` 不是同一件事 |
| `healthMonitor.enabled` | 该通道健康监控与自动重启 |

### 7.2 xA 企微 `channels.wecom`

| 字段 | 作用 |
| --- | --- |
| `botId` | 企微机器人 ID；xA 用 `${XA_IT_WECOM_BOT_ID}` |
| `secret` | 机器人 Secret；xA 用 `${XA_IT_WECOM_BOT_SECRET}` |
| `dmPolicy` / `groupPolicy` | 当前测试常用 `open`；生产应收紧 `allowFrom` |
| `sendThinkingMessage` | 现网 `true`。插件须 **≥ 2026.7.2**。升级见 `WeCom 通道插件接入手册.md` **第 16 节**；行为见该手册 **7.4**。与百炼 `enable_thinking` 不是同一件事 |

**前提：** 必须先安装并 enable **`wecom-openclaw-plugin`**，否则 `wecom` 不是合法 channel id。

通道详细字段见各通道文档，例如 [WeCom](https://docs.openclaw.ai/channels/wecom)（若已发布）或插件 README。

---

## 8. `gateway`

Gateway HTTP/WebSocket 服务与鉴权。同一端口复用：WebSocket 控制/RPC、HTTP API（`/v1/models`、`/v1/chat/completions` 等）、Control UI、插件 HTTP 路由。

### 8.0 与 `bindings` 的区别

| 配置项 | 路径 | 控制什么 |
| --- | --- | --- |
| **`gateway.bind`** | `gateway.bind` | Gateway **监听哪个网络接口**（谁能连上端口） |
| **`bindings`** | 顶层 `bindings[]` | 入站消息 **交给哪个 Agent**（见第 6 节） |

二者独立配置，xA Docker 典型组合：`bind: "lan"` + `bindings` 把 `wecom/default` 路由到 `itservicedeskagent`。

### 8.1 常用字段

| 字段 | 作用 |
| --- | --- |
| `mode` | **`local`**：本机运行 Gateway；`remote`：CLI 连远程 Gateway。xA 必须为 `local` |
| `port` | 监听端口，默认 `18789`；Docker 映射 `"18789:18789"` |
| `bind` | 网络绑定模式，见 8.2 |
| `customBindHost` | `bind: "custom"` 时指定 IPv4 地址（如 `"0.0.0.0"` 或某网卡 IP） |
| `auth.mode` | `token` \| `password` \| `trusted-proxy` \| `none` |
| `auth.token` | 明文 token 或 `${OPENCLAW_GATEWAY_TOKEN}` 或 SecretRef |
| `auth.password` | 密码模式 |
| `auth.rateLimit` | 失败鉴权限流 |
| `tailscale.mode` | `off` \| `serve`（tailnet 内暴露，Gateway 仍 loopback）\| `funnel`（公网，须 auth） |
| `controlUi.enabled` | Control UI / Dashboard |
| `controlUi.allowedOrigins` | 浏览器跨域 WebSocket 来源白名单；公网或非 loopback 远程 UI 须显式配置 |
| `reload.mode` | 配置热重载：`hybrid`（默认，安全项热更、需重启项自动重启）\| `off` |
| `remote.url` | CLI 连远程 Gateway 的 WS 地址（`mode: remote` 时） |

### 8.2 `gateway.bind` 各模式详解

`bind` 决定 Gateway **在哪个 IP/网卡上监听** `port`。只允许以下**模式关键字**，**禁止**写 IP 或主机别名（`0.0.0.0`、`127.0.0.1`、`localhost`、`::`、`::1` 会校验失败）。

| 模式 | 实际监听 | 谁能连接 | 典型场景 |
| --- | --- | --- | --- |
| **`loopback`**（默认） | `127.0.0.1` | 仅本机进程 | 原生 Windows/Linux 开发；远程用 SSH 隧道或 Tailscale Serve |
| **`lan`** | `0.0.0.0`（所有 IPv4 网卡） | 局域网内其他设备 | **WSL2 + Docker `-p 18789:18789`**（xA 标准做法） |
| **`tailnet`** | Tailscale 网卡 IPv4；无 Tailscale 时回退 `loopback` | 同一 Tailscale 网络内设备 | 远程笔记本/手机经 tailnet 访问，不暴露整个 LAN |
| **`auto`** | 容器内 → 等同 `lan`（`0.0.0.0`）；非容器 → 等同 `loopback` | 随环境自动 | 官方 Docker 镜像默认倾向；Tailscale serve/funnel 激活时强制 `loopback` |
| **`custom`** | `gateway.customBindHost` 指定的单个 IPv4 | 该接口可达的客户端 | 只监听某块网卡，比 `lan` 更精细 |

**`tailnet` / `custom` 额外行为：** 当解析地址不是 `127.0.0.1` 或 `0.0.0.0` 时，Gateway 会**同时**在 `127.0.0.1:同端口` 再开一个 listener，供本机客户端使用；任一 listener 绑定失败则**启动失败**。

**xA Docker 推荐：** 显式 `"bind": "lan"`，并与 `entrypoint.sh` 中 `--bind lan`、`docker-compose.yml` 中 `OPENCLAW_GATEWAY_BIND: lan` 保持一致。

```json
"gateway": {
  "port": 18789,
  "mode": "local",
  "bind": "lan",
  "auth": {
    "mode": "token",
    "token": "${OPENCLAW_GATEWAY_TOKEN}"
  },
  "tailscale": { "mode": "off" },
  "controlUi": {
    "allowedOrigins": [
      "http://localhost:18789",
      "http://127.0.0.1:18789"
    ]
  }
}
```

**Docker 为何不能用 `loopback`：** 桥接网络下，`-p` 映射的流量从容器 `eth0` 进入，而 `loopback` 只监听 `127.0.0.1`，宿主 `curl localhost:18789` 会连不上。可选替代：`--network host`，或 `bind: "custom"` + `customBindHost: "0.0.0.0"`（等效 `lan`）。

### 8.3 配置优先级（port / bind）

| 项 | 解析顺序（前者覆盖后者） |
| --- | --- |
| **端口** | CLI `--port` → 环境变量 `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789` |
| **bind** | CLI `--bind` / 环境变量 `OPENCLAW_GATEWAY_BIND` → `gateway.bind` → 默认 `loopback`（容器环境有效默认 `auto`） |

修改 `gateway.port` 或 `gateway.bind` 后须 **重启 Gateway**（不支持热重载）。改端口后建议 `openclaw doctor --fix` 或重装 gateway 服务，使 systemd/launchd 同步新端口。

### 8.4 鉴权与安全

| bind 模式 | auth 要求 |
| --- | --- |
| `loopback` | 默认需要 auth；本机 loopback 直连有部分自动配对策略 |
| `lan` / `tailnet` / `custom`（非纯 loopback） | **必须**配置 `auth`（token、password 或正确配置的 `trusted-proxy`） |
| 非 loopback 且无有效 auth | 启动拒绝，日志类似 `refusing to bind gateway ... without auth` |

安全建议（官方 [Security](https://docs.openclaw.ai/gateway/security)）：

- 远程访问优先 **`loopback` + Tailscale Serve**，而非直接 `lan` 暴露。
- 若必须 `lan`，配合防火墙限制来源 IP，并始终使用强随机 token。
- `auth.mode: "none"` 仅用于受信的本机 loopback；onboarding 不会引导此模式。

### 8.5 相关官方文档

- [Gateway runbook](https://docs.openclaw.ai/gateway)
- [Configuration reference — gateway](https://docs.openclaw.ai/gateway/configuration-reference)
- [Remote access](https://docs.openclaw.ai/gateway/remote)
- [Security](https://docs.openclaw.ai/gateway/security)

---

## 9. `plugins`

控制扩展的 discovery、load、enable 与 per-plugin 配置。

| 字段 | 作用 |
| --- | --- |
| `enabled` | 全局插件总开关（`false` 禁用全部） |
| `allow` | **白名单**：仅列出的插件 id 可加载（restrictive） |
| `deny` | 黑名单（优先于 allow） |
| `load.paths` | 额外本地插件目录/文件；**Gateway 启动时读取，改后需 restart** |
| `entries.<pluginId>.enabled` | 单插件开关 |
| `entries.<pluginId>.config` | 插件自定义配置（由插件 schema 校验） |
| `entries.<pluginId>.env` | 注入插件进程的环境变量 |
| `entries.<pluginId>.hooks.*` | 钩子安全：如 `allowPromptInjection` |
| `slots.memory` | 独占类插件 slot 选择 |

**xA 示例：**

```json
"plugins": {
  "allow": ["oa-workflow-bridge-redis", "wecom-openclaw-plugin"],
  "deny": ["codex"],
  "load": {
    "paths": ["/home/node/.openclaw/extensions/oa-workflow-bridge-redis"]
  },
  "entries": {
    "oa-workflow-bridge-redis": { "enabled": true, "hooks": { "allowConversationAccess": true } },
    "wecom-openclaw-plugin": { "enabled": true, "hooks": { "allowConversationAccess": true } },
    "codex": { "enabled": false }
  }
}
```

| 插件 id | 注册能力 |
| --- | --- |
| `wecom-openclaw-plugin` | 通道 `wecom`、工具 `wecom_mcp` 等。须 `hooks.allowConversationAccess: true`，否则 `before_prompt_build` blocked，带图提单只靠 OA 桥接 hook 缓冲 |
| `oa-workflow-bridge-redis` | 工具 `oa_workflow`。须 `hooks.allowConversationAccess: true`，否则收不到 `message_received`，带图提单只能靠工具 ctx 媒体路径 |
| `codex` | 2026.9.2 现网 `deny` + `enabled: false`，不要打开 |
| `wecom-oa-identity-adapter` | **无 tool。** 默认不进 `allow` / `load.paths`；桥接按相对路径 `import`。开关不在本文件，见 `OA_tool/身份适配器说明.md` 第 10 节 |

npm/catalog 安装的企微插件 **不必** 出现在 `load.paths`。

详见 [Plugins](https://docs.openclaw.ai/plugins)。

---

## 10. `models`（模型 Provider）

定义 LLM 供应商、API 地址、模型 catalog。xA Docker 路径把 Key / baseUrl / 模型 id 放在 `${VAR}` 里，catalog 元数据（`name`、`reasoning`、`compat`）写在 json 固定值。

| 字段 | 作用 |
| --- | --- |
| `models.mode` | catalog 行为：`merge` \| `replace` |
| `models.providers.<id>` | 自定义 Provider 标识（如 `domestic`、`bailian`）。须与 Agent `model` 前缀、`model_ref.txt` 一致 |
| `baseUrl` / `apiKey` / `api` | 供应商地址、密钥、协议；Docker 下用 `${XA_DOMESTIC_*}` |
| `timeoutSeconds` | 该 Provider 一次模型 HTTP 的总超时（含连接、响应头、流式正文）。xA 用 **`20`**：正常首包 0.8～3s、出参最多约 8s；现网曾出现 `timeoutMs=undefined` 导致首包空等 27s。不要设成 120（那是云端默认空闲看门狗，封不住这次长尾） |
| `models[]` | 该 Provider 下的模型 catalog |

### 10.1 `models.providers.<id>.models[]` 条目

| 字段 | 作用 |
| --- | --- |
| `id` | 发给上游 API 的 `model` 参数（如 `qwen3.8-flash`、`qwen3.8-max`；现网以 `model_id.txt` 为准） |
| `name` | Control UI / `models list` 展示名；**必填**，省略会导致 Gateway exit 78 |
| `reasoning` | OpenClaw 是否按 reasoning 模型组请求（`developer` 角色）。百炼兼容端须 **`false`**，否则易 HTTP 400 |
| `compat.thinkingFormat` | 自定义 Provider 如何把会话 `thinking=off` 映射到上游。百炼 compatible-mode 用 **`"qwen"`**，才会发顶层 `enable_thinking: false` |
| `compat.supportsDeveloperRole` | 百炼不支持 `developer` 角色，设 **`false`** |
| `input` | 模态。xA **必须** `["text"]`。写成 `["text","image"]` 时，OpenClaw 会把该自定义 Provider 自动登记为图片理解后端，inbound 图会走 `apply_media_understanding`（现网实测约 7s，且不一定出现 `[model-fetch]`）。附件只走 `oa_workflow` `attach` |
| `contextWindow` / `maxTokens` | 上下文与输出上限（非第三方密钥，可写死） |

**`reasoning: false` 不能代替 `compat.thinkingFormat`。** `qwen3.8-max` / `qwen3.8-flash` 在百炼侧默认思考为 `xhigh`；自定义 `bailian`/`domestic` 若不声明 `"qwen"` 格式，Gateway 日志虽是 `thinking=off`，请求里仍没有 `enable_thinking: false`，企微会等 8～20 秒才收到 `kind=final`。详见 `DashScope 兼容 Provider 配置手册.md` §2.4。

xA 百炼条目最小完整形：

```json
{
  "id": "${XA_DOMESTIC_MODEL_ID}",
  "name": "qwen3.8 flash",
  "reasoning": false,
  "compat": {
    "thinkingFormat": "qwen",
    "supportsDeveloperRole": false
  },
  "input": ["text"],
  "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
  "contextWindow": 128000,
  "maxTokens": 8192
}
```

### 10.2 Agent 上的模型引用

| 字段 | 作用 |
| --- | --- |
| `model` | 字符串：`provider/model`，如 `bailian/qwen3.8-flash` 或 `${XA_DOMESTIC_MODEL_REF}`（前缀必须等于 `providers` 键名） |
| `model.primary` / `fallbacks` | 对象形式主模型与回退 |
| `thinkingDefault` | 会话思考级别；xA 用 `"off"`。须与 `compat.thinkingFormat` 一起才能真正关掉百炼思考链 |

国内模型适配见 `DashScope 兼容 Provider 配置手册.md` 与 [Custom providers](https://docs.openclaw.ai/gateway/config-tools#custom-providers-and-base-urls)。

---

## 11. `session` / `messages` / `skills` / `mcp`（常用摘要）

### 11.1 `session`

| 字段 | 作用 |
| --- | --- |
| `dmScope` | DM 会话隔离：`main` \| `per-peer` \| `per-channel-peer` 等。xA 用 `per-channel-peer` |
| `reset.mode` | 会话重置策略（daily / idle） |
| `resetByType.group` | 按会话类型覆盖重置。xA 群聊：`mode: idle`、`idleMinutes: 30` |
| `threadBindings` | 线程绑定会话路由 |

见 [Session Management](https://docs.openclaw.ai/concepts/session)。

### 11.2 `messages`

| 字段 | 作用 |
| --- | --- |
| `visibleReplies` | 群聊可见回复模式 |
| `groupChat.mentionPatterns` | 文本 @ 触发模式 |
| `groupChat.visibleReplies` | 群聊是否必须用 message 工具发送 |

### 11.3 `skills`

Skill 是 markdown 说明书，注入到 system prompt 的 `<available_skills>`，**不是** `alsoAllow` 里的工具。模型看到目录后，理论上还要用 `read` 去打开 `SKILL.md`；xA 已 `deny` `group:fs`，但目录本身仍占 token，且会把智能表格等用法写进提示词。

**两层不要混：**

| 层 | 字段 | 作用 | xA |
| --- | --- | --- | --- |
| 逐条开关 | `skills.entries.<id>.enabled: false` | 只关掉**点了名**的那一条。没写名字的仍可用 | xA 现网 **不写** `skills.entries`；挡插件 skill 靠下面的 `[]` |
| Agent 白名单 | `agents.defaults.skills` / `agents.entries.*.skills` | **省略 = 不限制**；非空列表 = 只放行这些名字；`[]` = **一个都不进 prompt** | **必须 `agents.defaults.skills: []`** |

企微插件加载后还会提供 `wecomcli-disk`、`wecomcli-doc`、`wecomcli-smartsheet`、`wecom-send-template-card` 等。它们不在上面那份 bundled `entries` 名单里，所以只关 `entries` 时 `/context detail` 仍会列出约 30 个 skill（现网曾约 10,156 字符）。`skills.allowBundled` 只管 bundled，**挡不住**插件 skill。

现网：

```json
"agents": {
  "defaults": {
    "skills": []
  }
}
```

xA 两处都写 `skills: []`（`agents.defaults` **和** `agents.entries.itservicedeskagent`）。显式写在 entry 上的列表不与 defaults 合并；只写 defaults 时，已绑定的 `itservicedeskagent` 会话仍可能注入 `wecomcli-*`。改完 `config validate` 后 **restart Gateway**，再 **`/new`**，然后跑 `/context detail`。旧会话会缓存 `skillsSnapshot`。目标：`Skills list` 为 0、不再出现 `wecomcli-*`。

其它字段：

| 字段 | 作用 |
| --- | --- |
| `load.extraDirs` | 额外 Skill 目录 |
| `entries.<skillId>.enabled` | 逐条启用/禁用（bundled / 已安装） |
| `entries.<skillId>.apiKey` | Skill 所需 API Key |
| `allowBundled` | 只限制 bundled；不管插件 / workspace / managed |

见 [Skills config](https://docs.openclaw.ai/tools/skills-config)。

### 11.4 `mcp`

| 字段 | 作用 |
| --- | --- |
| `mcp.servers.<name>` | stdio 或 HTTP MCP 服务器定义 |
| `command` / `args` | 本地 MCP 启动命令 |
| `url` + `transport` | 远程 MCP |

MCP 工具以 `bundle-mcp` 或具体工具名出现在工具策略中。

---

## 12. 其他顶层块（索引）

| 顶层键 | 作用 | 官方参考 |
| --- | --- | --- |
| `env.vars` | 配置内联环境变量 | [Environment](https://docs.openclaw.ai/help/environment) |
| `env.shellEnv` | 从 login shell 导入缺失 env | 同上 |
| `hooks` | HTTP Webhook 触发 Agent | [Configuration reference — Hooks](https://docs.openclaw.ai/gateway/configuration-reference#hooks) |
| `cron` | 定时 Agent 任务 | [Cron jobs](https://docs.openclaw.ai/automation/cron-jobs) |
| `browser` | 浏览器控制服务 | [Configuration reference — Browser](https://docs.openclaw.ai/gateway/configuration-reference#browser) |
| `logging` | 日志级别、文件 | [Logging](https://docs.openclaw.ai/gateway/configuration-reference#logging) |
| `diagnostics` / `telemetry` | 诊断与 OTEL 导出 | [OpenTelemetry](https://docs.openclaw.ai/gateway/opentelemetry) |
| `update` | 自更新策略 | [Updating](https://docs.openclaw.ai/install/updating) |
| `wizard` | 向导状态 | 一般无需手改 |
| `identity` | Gateway 级身份展示 | 与 agent.identity 不同 |
| `discovery` | mDNS / DNS-SD 发现 | [Bonjour](https://docs.openclaw.ai/gateway/bonjour) |
| `talk` | Talk 模式 / 语音 | [config-agents — talk](https://docs.openclaw.ai/gateway/config-agents) |
| `ui` | UI 相关 | Control UI 配置 |
| `$include` | 拆分多文件配置 | [Config includes](https://docs.openclaw.ai/gateway/configuration-reference#config-includes-include) |

---

## 13. 配置分层速查（xA）

```text
┌─────────────────────────────────────────────────────────┐
│ gateway          网络监听 bind:lan + auth.token          │
│   port / bind / auth（谁能连上 Gateway）                 │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│ plugins          加载扩展 → 注册 channels + tools        │
│   allow / load.paths / entries.enabled                  │
└───────────────────────────┬─────────────────────────────┘
                            │ 注册 wecom_mcp, oa_workflow
┌───────────────────────────▼─────────────────────────────┐
│ tools            全局 + Agent 工具白名单                  │
│   profile / alsoAllow / deny                            │
└───────────────────────────┬─────────────────────────────┘
                            │ Agent 可调用哪些 tool id
┌───────────────────────────▼─────────────────────────────┐
│ bindings         wecom/default → itservicedeskagent      │
│   （消息路由，与 gateway.bind 无关）                     │
└─────────────────────────────────────────────────────────┘
```

---

## 14. xA 推荐配置检查清单

| 检查项 | 期望 |
| --- | --- |
| 无 handoff `meta` | 不含 `handoffTemplate` |
| 路径 | Docker 内为 `/home/node/.openclaw/...` |
| `gateway.mode` | `local` |
| `gateway.bind` | Docker 用 `lan` |
| `plugins.allow` | 含 `oa-workflow-bridge-redis`、`wecom-openclaw-plugin` |
| `plugins.deny` | 含 `codex`；`entries.codex.enabled` 为 `false` |
| `agents.entries` | 用对象 map，不要再用 `agents.list[]` |
| `channels.wecom` | 凭据为 env 占位符，非明文 |
| `tools.deny` | Agent 级含 `group:fs` / runtime / ui / web / automation |
| `oa_workflow` | **已**加入全局与 Agent `alsoAllow`；**不要**加入 `read` / `wecom_mcp`。实时建单看 `bridge-config.json` 的 `active` |
| `tools.media` | image / audio / video 均为 `false`；发图日志不应再出现数秒级 `apply_media_understanding` |
| `models.providers.*.timeoutSeconds` | `20`；`[model-fetch]` 行应出现 `timeoutMs=` 约 20000，不再是 `undefined` |
| `model` | 非占位符，Provider 已配置 |
| 校验 | `openclaw config validate` 通过 |

---

## 15. 现网配置（xA Docker，OA 主路径）

整份 JSON **以仓库 `openclaw/openclaw.json` 为准**（部署后是 `~/xa/config/openclaw.json` → 容器 `/home/node/.openclaw/openclaw.json`）。本节只列核对项，不要在文档里再维护一份会漂的拷贝。字段含义见上文 §1–14。

OpenClaw **2026.9.2** 现网核对：

| 检查项 | 期望 |
| --- | --- |
| Agent 结构 | `agents.entries`（不要 `list`）；`skipBootstrap: true`、`bootstrapMaxChars: 40000`、`skills: []` 写在 **defaults 和 `itservicedeskagent` 两处** |
| 工具 | 两处 `alsoAllow` 仅 `oa_workflow`（不含 `read`）；Agent `deny` 含 `group:fs`；`tools.media` 全关 |
| 模型 | Provider 键名现网为 `bailian`；`timeoutSeconds: 20`；catalog `input` 仅 `text`；`thinkingDefault: "off"` |
| 插件 | `plugins.deny` 含 `codex`；**不要**写 bundled `skills.entries` 当全关；挡 skill 靠两处 `skills: []`。**不要**把 `wecom-oa-identity-adapter` 写入 `allow` / `alsoAllow` |
| 通道 | `sendThinkingMessage: true`（插件 ≥ 2026.7.2）；`controlUi.allowedOrigins` 已写 |
| 会话 | `session.resetByType.group.idleMinutes: 30` |
| 建单开关 | 不在本文件，在 `bridge-config.json` 的 `active`（规则包按 `true`） |
| 工作区 | 规则在 `AGENTS.md` 的 `## Tools`，不再依赖自动注入 `TOOLS.md`。不要设 `agents.defaults.imageModel` |

`wizard` 由 `doctor` 写入，不必手改。docker logs 若再出现 `smartsheet_get_records`，见 WeCom 手册 9.2。`prepare` 依赖两包 `node_modules/redis`（OA Redis 手册 4.2）。

---

## 16. 相关项目文档

| 文档 | 内容 |
| --- | --- |
| `OpenClaw Gateway WSL2-Docker 安装手册.md` | 工位 Docker 部署与 openclaw.json 修改步骤 |
| `OpenClaw Gateway Linux 服务器安装手册.md` | Linux 服务器安装（json 演进见第 9 / 12 节；OA / 企微字段对照 `openclaw/openclaw.json`） |
| `OpenClaw Gateway Docker 运维手册.md` | 配置变更如何重启、巡检与升级回滚 |
| `第三方凭据注入与配置中心演进.md` | Docker 注入 → Nacos 配置中心迁移思路 |
| `WeCom 通道插件接入手册.md` | plugins.allow、channels.wecom、**7.4 sendThinkingMessage** |
| `DashScope 兼容 Provider 配置手册.md` | `models.providers`、`compat.thinkingFormat`、`MEMORY.md` |
| `外部系统 Tool 插件设计规范.md` | OA 插件形式与 `oa_workflow` |
| `OA_tool/身份适配器说明.md` 第 10 节 | 适配器与 `openclaw.json` 的分工：默认不写 allow；开关在 `bridge-config.json` |
| `OpenClaw Gateway 部署拓扑与选型.md` | Docker vs CLI profile |

---

**声明：** OpenClaw 版本迭代较快，新增字段以 `openclaw config schema` 与 [Configuration reference](https://docs.openclaw.ai/gateway/configuration-reference) 为准；本文档不替代官方 schema。
