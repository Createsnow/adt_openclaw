# openclaw.json 配置参考

逐块解释现网 `workspace-rules/openclaw.json`（部署后为 `~/xa/config/openclaw.json`）里每个字段为什么这样写。整份文件以仓库样例为准，本文不再维护拷贝。完整字段以 `openclaw config schema` 和 [官方 Configuration reference](https://docs.openclaw.ai/gateway/configuration-reference) 为准。

基础：

- 格式是 JSON5，按 schema 严格校验。改完先 `config validate`。
- `${VAR}` 引用环境变量（仅大写名），真值来自 secret，见安装手册第 4 节。
- 多数字段热重载；`plugins.load.paths`、`gateway.port` / `bind` 要重启，env 变了要 `down && up`。
- 运行时会自动写 `meta`、`wizard`，不用手改。旧模板里的 `meta.handoffTemplate` 等不是合法字段，会 `meta: Invalid input`。

## 1. 三层门控：插件、工具、Skill

```text
plugins.allow / entries.enabled / load.paths   → 插件能否加载
    ├── 通道（wecom 收发）                       不走工具白名单
    ├── 工具（oa_workflow、wecom_mcp）           还要写进 tools.alsoAllow 模型才能调
    └── Skill 目录（wecomcli-* 等）              走 agents.*.skills 白名单，进 system prompt
```

| 名单 | 管什么 | 不管什么 |
| --- | --- | --- |
| `plugins.allow` + `entries.<id>.enabled` | 插件 id 能否加载 | 模型调不调某个函数 |
| `tools.alsoAllow` | 模型能调的工具名 | 通道在不在、Skill 进不进 prompt |
| `agents.*.skills` | 哪些 Skill 进 `<available_skills>` | 通道、工具 |

| 插件 id | 登记了什么 | xA 怎么用 |
| --- | --- | --- |
| `oa-workflow-bridge` | 只有工具 `oa_workflow`（身份转换是插件内部模块，不注册工具） | `alsoAllow` 必须含 `oa_workflow` |
| `wecom-openclaw-plugin` | 通道 `wecom` + 工具 `wecom_mcp` + Skill `wecomcli-*` | 只用通道；`wecom_mcp` 和插件 id 都不进 `alsoAllow`；Skill 靠 `skills: []` 挡掉 |
| `codex` | — | `plugins.deny` + `entries.codex.enabled: false` |

## 2. `agents`

```text
agents.defaults                 skipBootstrap: true, bootstrapMaxChars: 40000, skills: []
agents.entries.itservicedeskagent
```

| 字段 | 值 | 原因 |
| --- | --- | --- |
| `entries` 的键 | `itservicedeskagent` | Agent id，与 `bindings[].agentId` 一致。2026.9.2 用 `entries`，不要再用旧的 `list[]` |
| `workspace` / `agentDir` | `/home/node/.openclaw/workspace`、`…/agents/itservicedeskagent/agent` | 容器内路径 |
| `model` | `${XA_DOMESTIC_MODEL_REF}` | `bailian/<模型 ID>` |
| `thinkingDefault` | `off` | 还要配合模型 `compat.thinkingFormat`，见 DashScope 手册 |
| `skipBootstrap` | `true` | 不让运行时重新生成官方空规则；不影响已有 `AGENTS.md` 的注入。不要设 `contextInjection: never`，否则规则整包不进模型 |
| `bootstrapMaxChars` | `40000` | 默认 20000 会截断 `AGENTS.md` 后半段的禁令 |
| `skills` | `[]` | 省略 = 不限制；`[]` = 一个都不进 prompt。只靠 `skills.entries.*.enabled: false` 挡不住插件的 `wecomcli-*`（现网曾占约 1 万字符） |
| `identity` | 小A / 🛠️ | 对外展示名，`theme` 会进 system prompt |
| `subagents.allowAgents` | `[]` | 禁止派生子 Agent |

**`skipBootstrap`、`bootstrapMaxChars`、`skills` 必须在 defaults 和 `itservicedeskagent` 两处都写**：entry 上显式写的值不与 defaults 合并，只写 defaults 时已绑定的 Agent 仍会用默认值。改完重启，企微里 `/new`，`/context detail` 中 `AGENTS.md` 不被截断、`Skills list` 为 0。

## 3. `tools`

全局 `tools` 与 Agent 级 `agents.entries.*.tools` 两处，Agent 级覆盖全局，`deny` 永远优先。

| 字段 | 值 | 原因 |
| --- | --- | --- |
| `profile` | `minimal` | 只剩 `session_status`；不要用 `coding` / `full` |
| `alsoAllow` | `["oa_workflow"]`（两处一致） | 唯一业务工具。不要加 `read` / `write` / `edit` / `memory_*` / `message` / `wecom_mcp` |
| Agent `deny` | `group:fs`、`group:runtime`、`group:ui`、`group:web`、`group:automation` | 关掉读写文件、执行、浏览器、网络、定时任务 |
| `elevated.enabled` | `false` | 不允许提权 |
| `agentToAgent.enabled` | `false` | 不允许 Agent 互调 |
| `fs.workspaceOnly` | `true` | 纵深防御 |
| `media.image/audio/video.enabled` | 全 `false` | 否则发图先跑约 7 秒媒体理解。不要设 `agents.defaults.imageModel` |

附件由通道落盘、`oa_workflow` 插件暂存，模型不读。

## 4. `models`

见 [DashScope 兼容 Provider 配置手册.md](DashScope%20兼容%20Provider%20配置手册.md) 第 1、3 节：Provider 键 `bailian`；`timeoutSeconds: 20`；条目 `reasoning: false`、`compat.thinkingFormat: "qwen"`、`input: ["text"]`、`name` 必填。

## 5. `session`

| 字段 | 值 | 原因 |
| --- | --- | --- |
| `dmScope` | `per-channel-peer` | 每个员工私聊独立会话 |
| `resetByType.group` | `mode: idle`、`idleMinutes: 30` | 群聊 30 分钟无人说话开新会话，触发 `session_end`，插件顺带清掉未进单的附件 |

## 6. `bindings` 与 `channels`

`bindings` 把 `wecom/default` 路由到 `itservicedeskagent`，从上到下第一条命中生效。它和 `gateway.bind`（监听网卡）无关。

`channels.wecom` 字段见 [WeCom 通道插件接入手册.md](WeCom%20通道插件接入手册.md) 第 2 节。插件没装时不能写 `channels.wecom`。

## 7. `gateway`

| 字段 | 值 | 原因 |
| --- | --- | --- |
| `mode` | `local` | 本机跑 Gateway |
| `port` | `18789` | 优先级：CLI `--port` > `OPENCLAW_GATEWAY_PORT` > 本字段 |
| `bind` | `lan` | Docker 桥接网络下端口映射从容器网卡进来，`loopback` 收不到。只能写关键字 `lan` / `loopback` / `auto` / `tailnet` / `custom`，写 IP 会校验失败。与 entrypoint `--bind lan`、compose `OPENCLAW_GATEWAY_BIND` 保持一致 |
| `auth` | `mode: token`，`token: ${OPENCLAW_GATEWAY_TOKEN}` | 非 loopback 必须有鉴权，否则拒绝启动 |
| `tailscale.mode` | `off` | 不用 |
| `controlUi.allowedOrigins` | `http://localhost:18789`、`http://127.0.0.1:18789` | 经 SSH 隧道打开 Dashboard |

对外暴露面由 compose 的 `127.0.0.1:18789:18789` 收口。

## 8. `plugins`

| 字段 | 值 | 原因 |
| --- | --- | --- |
| `allow` | `oa-workflow-bridge`、`wecom-openclaw-plugin` | 白名单，不在里面的不加载 |
| `deny` | `codex` | 显式禁用 |
| `load.paths` | `/opt/xa/oa-workflow-bridge` | OA 插件在镜像里；企微插件 npm 托管，不写路径。启动时读取，改了要 `down && up` |
| `entries.*.hooks.allowConversationAccess` | 两个插件都 `true` | OA 桥接要收 `message_received` 等事件落附件；企微不开会 `before_prompt_build blocked` |

OA 建单开关、身份转换开关都不在本文件，在 `oa-bridge-config.json`（`active`、`identity.adapter`）。

## 9. 改配置前

| 想做 | 正确做法 | 错误做法 |
| --- | --- | --- |
| 关 Codex | `plugins.deny` + `entries.codex.enabled: false` | 只从 allow 删掉 |
| 关 Skill | 两处 `skills: []`，重启 + `/new` | 只在 `skills.entries` 点名关 |
| 关企微收发 | 关 `channels.wecom.enabled` 或插件 entries | 去掉 `wecom_mcp` |
| 暂停建单 | `oa-bridge-config.json` 的 `active: false` | 把 `oa_workflow` 移出白名单 |
| 让模型看图 | 不做 | 打开 `read` / `tools.media` / `imageModel` |
| 换模型 | 只改 `model_id.txt` / `model_ref.txt` | `config set` 写明文 |
| 迁旧 `agents.list` | 备份后 `doctor --fix`，再 `config validate` | `list` 和 `entries` 混写 |
