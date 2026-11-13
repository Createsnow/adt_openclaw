# WeCom 通道插件接入手册

> 本文档由仓库根目录原文档**重组**而来：只调整章节归属与交叉引用，**不改变**部署步骤、命令、YAML、错误码或禁止事项。阅读顺序见 [README.md](README.md)。

适用对象：已在 **WSL2 + Docker** 或 **Linux 服务器 Docker** 环境跑通 OpenClaw Gateway，需要安装并配置 **企业微信（WeCom）插件** 的工程师。

本文档基于两份安装手册（工位 WSL2 / Linux 服务器）与仓库现网样例。现网 Gateway 为 **OpenClaw 2026.9.2**（`docker/docker-compose.yml` 钉 `ghcr.io/openclaw/openclaw:2026.9.2`，`openclaw/openclaw.json` 的 `meta.lastTouchedVersion` 同号）。与原生 Windows + DPAPI 路径无关。

---

## 1. 先理解架构

```text
企业微信员工
    ↓ WebSocket / Webhook
wecom-openclaw-plugin（外部插件，非 OpenClaw 内置）
    ↓ 注册 wecom 通道（仍会注册 wecom_mcp，xA 不要加入 alsoAllow）
OpenClaw Gateway
    ↓ bindings: wecom/default → itservicedeskagent
xA Agent（workspace-rules + oa_workflow）
```

| 组件 | 说明 |
| --- | --- |
| `wecom-openclaw-plugin` | 企微官方维护的外部插件，包名 `@wecom/wecom-openclaw-plugin` |
| `channels.wecom` | 通道配置（BotId、Secret、访问策略等） |
| `plugins.allow` | 插件白名单；不在列表里的插件无法启用 |
| `bindings` | 把 `wecom/default` 路由到 `itservicedeskagent` |
| Docker secrets | BotId / BotSecret 真值，不写进 json 明文 |

**重要约束：**

- 企微**不是** Telegram 那种内置通道，不能在没有插件时单独写 `channels.wecom`。
- 同一套 BotId/BotSecret 只能被一个 Gateway 持有（单账号模式）。
- 本仓库**不含** `wecom-openclaw-plugin` 源码，需按第 5 节从 npm catalog 安装，或从已有环境拷贝。
- 入站发送人是 `body.from.userid` → `SenderId` / `requesterSenderId`。现网智能机器人为 **加密 userid**（`wo` 开头），不是工号。身份如何进 OA 见 `OA_tool/企微到OA身份与数据流.md`（`oa_identity` 缓存）。把加密串转明文 **不在本通道插件内**，见 OA 桥接内 `src/identity/` 与 `OA_tool/身份适配器说明.md`（已验证）。不要在本手册重复映射步骤。

---

## 2. 前置条件

开始之前确认：

| 项 | 检查命令 / 标准 |
| --- | --- |
| Gateway 已 Up | `docker compose ps` → `Up (healthy)` |
| 健康检查 | `curl http://127.0.0.1:18789/healthz` → `{"ok":true,...}` |
| 工作目录 | `~/xa`，config / workspace / extensions 已挂载 |
| 企微机器人 | 已在企微管理后台创建，拿到 **Bot ID** 和 **Secret** |
| secrets 文件 | `~/xa/secrets/wecom_bot_id.txt`、`wecom_bot_secret.txt` 各一行 |
| entrypoint | 已从 secrets 导出 `XA_IT_WECOM_BOT_ID` / `XA_IT_WECOM_BOT_SECRET` |

若 Gateway 尚未跑通：工位先完成 `OpenClaw Gateway WSL2-Docker 安装手册.md` 第 1–7 节；Linux 服务器先完成 `OpenClaw Gateway Linux 服务器安装手册.md` 直到本机 `/healthz` 通（第一次见第 11 节；装企微从第 20 节开始）。

---

## 3. 两阶段策略（推荐）

企微插件与通道配置分两段进行，避免网关陷入 `Restarting` 崩溃循环。

| 阶段 | 目标 | 配置状态 |
| --- | --- | --- |
| **阶段 A** | 先让 Gateway 稳定 Up | 无 `channels.wecom`；`plugins.allow` 可不含 wecom |
| **阶段 B** | Gateway Up 后装插件、配通道 | 安装插件 → 改 allowlist → 加 `channels.wecom` → 重启验证 |

阶段 A：**工位**对应 [OpenClaw Gateway WSL2-Docker 安装手册.md](OpenClaw%20Gateway%20WSL2-Docker%20安装手册.md) **5.5 节**（临时去掉 wecom）；**Linux 服务器**没有同名节——第一次 `/healthz` 通见该手册第 11 节，装企微从第 20 节开始。若你当前 Gateway 已是 `Up`，可直接进入阶段 B。

---

## 4. 容器内 openclaw 命令用法

容器内通常没有全局 `openclaw` 命令，统一使用：

```bash
docker exec -it xa-gateway node dist/index.js <子命令>
```

下文简写为 **`oc`**，即上述完整命令。

### 4.1 关于 `docker exec` 的环境变量警告

`docker exec` **不会**执行 `entrypoint.sh`，因此 CLI 可能报：

```text
missing env var "OPENCLAW_GATEWAY_TOKEN" ...
missing env var "XA_IT_WECOM_BOT_ID" ...
```

**这不影响正在运行的 Gateway 主进程**（主进程通过 entrypoint 已注入 secrets）。可忽略，或带环境变量执行：

```bash
docker exec -it \
  -e OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < ~/xa/secrets/gateway_token.txt)" \
  -e XA_IT_WECOM_BOT_ID="$(tr -d '\n' < ~/xa/secrets/wecom_bot_id.txt)" \
  -e XA_IT_WECOM_BOT_SECRET="$(tr -d '\n' < ~/xa/secrets/wecom_bot_secret.txt)" \
  xa-gateway node dist/index.js channels status --channel wecom
```

---

## 5. 阶段 B：安装企微插件

任选一种方式。**安装前**若 `plugins.allow` 不含 `wecom-openclaw-plugin`，需先加入（见第 6 节），否则安装时会报 `blocked by allowlist`。

### 方式 1 — OpenClaw 官方 catalog（推荐）

```bash
cd ~/xa

# 若 allowlist 尚未包含 wecom，先执行第 6 节
oc channels add --channel wecom
docker compose restart
```

会从官方 catalog 安装**钉死版本**的 `@wecom/wecom-openclaw-plugin` 到 OpenClaw 托管目录（如 `~/.openclaw/npm/projects/...`）。这不是 npm 最新。catalog 目标随 Gateway 版本变：历史上 OpenClaw **2026.7.1** 会钉在插件 **2026.5.7**；**现网仓库样例是 2026.9.2**，以容器内 `plugins list` 的 `version` 为准。`plugins update wecom-openclaw-plugin` 也只会确认「已是 catalog 目标」。要 npm 最新或指定版，见**第 16 节**。

### 方式 2 — npm 包安装

裸包名若与官方 catalog 插件 id 相同，OpenClaw **仍走 catalog 钉死版**，不会自动变成 npm 最新。要 npm 源必须写 `npm:` 前缀，见第 16 节。

```bash
oc plugins install @wecom/wecom-openclaw-plugin
docker compose restart
```

### 方式 3 — 企微官方 CLI 一键安装

不带 `--version` 时以 CLI 默认为准，**不一定**等于 catalog 钉死版。要钉死某一 npm 版见第 16 节。

```bash
docker exec -it xa-gateway npx -y @wecom/wecom-openclaw-cli install
docker compose restart
```

### 方式 4 — 手动拷贝到 extensions 挂载目录

若本机已有插件目录（例如原 Windows 环境）：

```bash
cp -r /path/to/wecom-openclaw-plugin ~/xa/extensions/wecom-openclaw-plugin
sudo chown -R 1000:1000 ~/xa/extensions
ls ~/xa/extensions/wecom-openclaw-plugin   # 应有 openclaw.plugin.json 或 package.json
```

并在 `openclaw.json` 的 `plugins.load.paths` 中增加：

```json
"/home/node/.openclaw/extensions/wecom-openclaw-plugin"
```

然后 **必须** `docker compose down && docker compose up -d`（load.paths 仅在启动时读取）。

> **说明：** 若插件已通过 npm/catalog 安装到 OpenClaw 托管目录，**不必**再写 `plugins.load.paths`；OA 桥接仍保留手动 path 即可。

### 安装后验证

```bash
oc plugins list
```

期望输出类似：

```text
@wecom/wecom-openclaw-plugin (wecom-openclaw-plugin) enabled
  format: openclaw
  source: ~/.openclaw/npm/projects/.../dist/index.js
  version: 2026.x.x
```

---

## 6. 配置插件白名单（plugins.allow）

OpenClaw 使用 restrictive allowlist。`plugins.allow` 不含 `wecom-openclaw-plugin` 时，安装或启用会失败：

```text
Cannot enable WeCom: blocked by allowlist.
Plugin install failed: wecom-openclaw-plugin is disabled (blocked by allowlist).
```

### 6.1 用 openclaw 命令修改

```bash
oc config set plugins.allow '["oa-workflow-bridge","wecom-openclaw-plugin"]'
oc config validate
```

### 6.2 启用插件条目

```bash
oc plugins enable wecom-openclaw-plugin
oc plugins list
```

### 6.3 json 中 plugins 段参考

```json
"plugins": {
  "allow": [
    "oa-workflow-bridge",
    "wecom-openclaw-plugin"
  ],
  "load": {
    "paths": [
      "/home/node/.openclaw/extensions/oa-workflow-bridge"
    ]
  },
  "entries": {
    "oa-workflow-bridge": {
      "enabled": true,
      "hooks": { "allowConversationAccess": true }
    },
    "wecom-openclaw-plugin": {
      "enabled": true,
      "hooks": { "allowConversationAccess": true }
    }
  }
}
```

npm 托管安装的 wecom 插件无需出现在 `load.paths` 中。`wecom-openclaw-plugin` 也须 `hooks.allowConversationAccess: true`，否则启动日志会 `before_prompt_build` blocked，带图提单只靠 OA 桥接的 hook 缓冲（见 OA 桥接接入手册 3.6）。

---

## 7. 配置企微通道（channels.wecom）

插件 enabled 后，还需配置 `channels.wecom`，否则 `channels list` 为空。

### 7.1 用 openclaw 命令（推荐）

```bash
oc config set channels.wecom.enabled true
oc config set channels.wecom.botId '${XA_IT_WECOM_BOT_ID}'
oc config set channels.wecom.secret '${XA_IT_WECOM_BOT_SECRET}'
oc config set channels.wecom.dmPolicy open
oc config set channels.wecom.groupPolicy open
oc config set channels.wecom.sendThinkingMessage false
oc config validate

cd ~/xa && docker compose restart
```

**不要**用 `config set` 写入 BotSecret 明文；继续用 `${XA_IT_WECOM_BOT_ID}` / `${XA_IT_WECOM_BOT_SECRET}` 占位符，真值由 entrypoint 从 Docker secrets 注入。

`sendThinkingMessage`：**初装**（尚未确认插件 ≥ 2026.7.2）保持 `false`，与历史上 catalog 钉死的 2026.5.7 兼容。**现网终态**与 Linux 服务器安装手册第 21 节、仓库 `openclaw/openclaw.json` 一致：插件 **≥ 2026.7.2** 时为 `true`。未升级插件不要抄现网 json 把这项改成 `true`。打开步骤见 **7.4**。

### 7.2 或直接编辑 openclaw.json

在 `bindings` 与 `gateway` 之间加入：

```json
"channels": {
  "wecom": {
    "enabled": true,
    "dmPolicy": "open",
    "allowFrom": ["*"],
    "groupPolicy": "open",
    "sendThinkingMessage": false,
    "botId": "${XA_IT_WECOM_BOT_ID}",
    "secret": "${XA_IT_WECOM_BOT_SECRET}"
  }
}
```

初装保持 `"sendThinkingMessage": false`。现网仓库样例与 Linux 服务器手册 §21.1 终态已是 `true`（须插件 ≥ 2026.7.2）。打开步骤见 **7.4**。

### 7.3 allowFrom 必配

当 `dmPolicy: "open"` 时，若 `allowFrom` 不含 `"*"`，网关会警告且**丢弃所有私聊**：

```text
channels.wecom.dmPolicy="open" but channels.wecom.allowFrom does not include "*";
all DMs will be dropped.
```

| 场景 | 推荐配置 |
| --- | --- |
| 测试环境 | `"allowFrom": ["*"]` |
| 生产受限 | `"dmPolicy": "allowlist"` + `"allowFrom": ["userid1", "userid2"]` |

```bash
oc config set channels.wecom.allowFrom '["*"]'
docker compose restart
```

### 7.4 打开「思考中」（sendThinkingMessage）

这是企微客户端的**占位动画**，不是百炼模型内部的思考链。两者容易混为一谈：

| 概念 | 配置 | 用户看到什么 | 会不会缩短模型耗时 |
| --- | --- | --- | --- |
| 企微「思考中 / 输入中」 | `channels.wecom.sendThinkingMessage` | 消息一进 Gateway，客户端立刻出现占位；最终回复用同一条流 `finish=true` 替换 | **不会**。只是先有反馈，避免以为卡住 |
| 百炼隐藏思考（`qwen3.8-max` / `qwen3.8-flash` 默认 `xhigh`） | 模型 catalog 的 `compat.thinkingFormat: "qwen"` + `enable_thinking: false` | 用户看不见；插件要等 `kind=final` 才把正文发出去 | **会**。关思考链才能把「首包 → 发出回复」从十几秒降到数秒。见 `DashScope 兼容 Provider 配置手册.md` §2.4 |

实测日志（`sendThinkingMessage: false`）只有全文生成完才出现：

```text
[wecom] [openclaw -> plugin] kind=final, payload={"text":"..."}
[wecom] [default] Reply message sent via WebSocket
[plugin -> server] streamId=..., finish=true
```

打开之后，inbound 后应立刻多出「思考中」相关日志（`onReplyStart` / `isShowThink=true`），最终仍以 `finish=true` 关掉占位。

#### 为什么初装默认 false

历史上 xA 曾用 OpenClaw **2026.7.1** + catalog 钉死的插件 **2026.5.7**。该插件版本有 thinking 流缺陷（**现网已是 2026.9.2**，不要把下面当成当前终态）：

- 同一会话连发两条时，回复流卡在 `finish=false`，客户端「思考中」一直转圈，正文发不出去（需重启 Gateway）。上游在 **2026.7.2** 恢复了按 `accountId:chatId` 串行排队。
- `finishThinkingStream` 时 `accumulatedText` 为空，占位关不掉，表现为「思考中」不消失。

因此 **阶段 B 初装必须写 `false`**，先保证能收到最终回复。不要在 2026.5.7 上直接改 `true`。

#### 何时改为 true

| 条件 | 建议 |
| --- | --- |
| 插件 **≥ 2026.7.2**，私聊/群聊收发已稳定 | **打开** `true`，发出去立刻有「思考中」 |
| 插件 **2026.5.7** / 2026.5.x | **保持 `false`**；先按第 16 节升级插件 |
| 打开后「思考中」不消失、或回复丢失 | 立刻改回 `false` 并 restart，再查插件版本与日志 |

先确认版本：

```bash
oc plugins list
# 期望类似：@wecom/wecom-openclaw-plugin ... version: 2026.7.2（或更高）
```

低于 2026.7.2 时**不要**只跑 `oc plugins update wecom-openclaw-plugin`：若 Gateway 仍吃 catalog 钉死的 **2026.5.7**（历史上 2026.7.1 常见），这条会报 `up to date (2026.5.7)`，版本不变。脱离钉死、装 npm 指定版的命令只在**第 16 节**写全。须已在 `plugins.allow` 中。

再打开占位：

```bash
oc config set channels.wecom.sendThinkingMessage true
oc config validate
cd ~/xa && docker compose restart
```

或直接改 `openclaw.json`：

```json
"channels": {
  "wecom": {
    "sendThinkingMessage": true
  }
}
```

改 json 后同样需要 `docker compose restart`。

#### 验证

1. 企微私聊发「你是谁」（不要连发）。
2. 客户端应在 **1～2 秒内**出现「思考中 / 输入中」，正文仍要等模型跑完。
3. 跟踪日志：

```bash
docker logs -f --timestamps xa-gateway
```

| 期望 | 日志 |
| --- | --- |
| 占位已发出 | `onReplyStart` 且 `isShowThink=true`，或 thinking 流 `finish=false` |
| 正文发出并关掉占位 | `kind=final` → `Reply message sent` → `Reply ack received` → `finish=true` |
| 异常：占位关不掉 | 只有 `finish=false`，没有对应的 `finish=true`；或 `kind=final` 有了但客户端一直转圈 |

异常时立即关回：

```bash
oc config set channels.wecom.sendThinkingMessage false
cd ~/xa && docker compose restart
```

群聊连发、或「思考中」卡住后后续消息全部无回复：先改回 `false`，再确认插件 ≥ 2026.7.2。不要靠反复发消息「撞」会话锁。

#### 和模型耗时的配合

打开「思考中」只改善体感。若 `model-fetch` 的 200 到 `kind=final` 仍要十几秒，按 `DashScope 兼容 Provider 配置手册.md` §2.4 / §6.7 关掉 `qwen3.8-max` 的默认 xhigh，并补上 `MEMORY.md`。两件事都做完，用户才会既马上看到占位、又较快看到正文。

---

## 8. 确认 secrets 与 entrypoint

### 8.1 secrets 文件

```bash
# 各一行，无多余空格换行
printf '%s' '你的BotId'     > ~/xa/secrets/wecom_bot_id.txt
printf '%s' '你的BotSecret' > ~/xa/secrets/wecom_bot_secret.txt
chmod 600 ~/xa/secrets/*
```

### 8.2 entrypoint.sh 必须 export

```sh
#!/bin/sh
set -eu
export OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < /run/secrets/gateway_token)"
export XA_IT_WECOM_BOT_ID="$(tr -d '\n' < /run/secrets/wecom_bot_id)"
export XA_IT_WECOM_BOT_SECRET="$(tr -d '\n' < /run/secrets/wecom_bot_secret)"
exec node dist/index.js gateway --bind lan --port 18789
```

### 8.3 验证注入（在运行中的容器内）

```bash
docker exec xa-gateway sh -c 'test -n "$XA_IT_WECOM_BOT_ID" && test -n "$XA_IT_WECOM_BOT_SECRET" && echo OK || echo MISSING'
```

---

## 9. Agent 路由与工具

xA 模板已包含以下配置，一般无需改动；新环境部署时请核对。

### 9.1 bindings（企微 → xA Agent）

```json
"bindings": [
  {
    "type": "route",
    "agentId": "itservicedeskagent",
    "match": {
      "channel": "wecom",
      "accountId": "default"
    }
  }
]
```

### 9.2 工具 allowlist

xA **OA 主路径不再调用** `wecom_mcp`（不读不写智能表格）。`tools.profile` 为 `minimal` 时，`alsoAllow` 含：

```json
"alsoAllow": [
  "oa_workflow"
]
```

不要加入 `read` / `write` / `edit` / `memory_search` / `memory_get` / `message` / `wecom_mcp`。工单正文由模型直接输出，通道负责发出；幂等看插件数据库。inbound 由插件自动暂存，不要用 `read` 看附件。`oa_workflow` 由 OA 桥接插件注册，不是企微插件工具。完整 json 见 `openclaw.json 配置参考.md` 第 15 节。企微通道插件仍可注册 `wecom_mcp`，但不要加入 xA 的 `alsoAllow`。

**去掉 `wecom_mcp` 不会让企业微信插件失效。** 通道（收发、WebSocket）靠 `plugins.allow` + `entries` enabled + `channels.wecom`；`alsoAllow` 只决定模型能不能点名调用工具。插件加载后仍会提供 `wecomcli-*` 等 **Skill 目录**（进 system prompt，不是工具）。xA 还要 `agents.defaults.skills: []`，否则 `/context detail` 仍会列出智能表格、文档等 skill。插件 vs 工具 vs Skill 见 `openclaw.json 配置参考.md` 第 5.5 / 11.3 节。

**已修复（2026-09-02 曾现网发生）：** 员工只发「你好」，docker logs 曾出现 `mcp execute ... smartsheet_get_records`，随后 `errcode=851014`（文档授权过期）。那表示模型仍调了企微文档 MCP，与当时 OA `prepare` 失败（缺 `redis` npm 包）不是同一件事。现网规则包与 `alsoAllow` 已落地，OA 主路径**不**依赖智能表格，**不要**为建单去重新授权「文档」权限。若日志再出现该调用，按下列核对。

核对（改的是 `~/xa/`，改完须重启 Gateway）：

1. `~/xa/config/openclaw.json`：全局与 `itservicedeskagent` 的 `tools.alsoAllow` 仅含 `oa_workflow`，**不含** `read` / `wecom_mcp` / `write` / `edit` / `memory_*` / `message`，也不含 `"wecom-openclaw-plugin"`。Agent 级 `deny` 含 `group:fs`。`agents.defaults.skipBootstrap` 为 `true`。`agents.defaults.skills` 为 `[]`（不要只靠 `skills.entries.*.enabled: false`）。
2. `~/xa/workspace/`：已换成现规则包（注入 `AGENTS.md`，含 `## Tools`）。规则只有这一份 `AGENTS.md`（人编副本已删除）。OpenClaw 2026.9.2 不再注入 `TOOLS.md`。
3. 新开会话跑 `/context detail`：`Skills list` 应为 0，不应再出现 `wecomcli-smartsheet`。旧会话可能缓存 skill 快照。

装插件依赖见 `OA_tool/OA Workflow Bridge 接入手册.md` 4.2 / 10。切入范围见 `xA 现网加固与演进全景.md` 1.1。

若需启用插件注册的全部企微业务工具，可额外加入 `"wecom-openclaw-plugin"`（见插件 README）。这与当前 OA 切流规则冲突，不要为 xA IT 服务台打开。

---

## 10. 完整验证清单

按顺序执行：

```bash
cd ~/xa

# 1. 容器与健康
docker compose ps -a
curl http://127.0.0.1:18789/healthz

# 2. 配置合法
oc config validate

# 3. 插件
oc plugins list

# 4. 通道
oc channels list
oc channels status --channel wecom --probe

# 5. Agent 路由
oc agents list --bindings

# 6. 日志（企微鉴权）
docker logs xa-gateway --tail 50 | grep -i wecom
```

### 成功标准

| 检查项 | 期望 |
| --- | --- |
| `docker compose ps` | `Up (healthy)` |
| `channels list` | `WeCom default: installed, configured, enabled` |
| `channels status --probe` | `enabled, configured, running, works` |
| `agents list --bindings` | `wecom accountId=default` → `itservicedeskagent` |
| 日志 | `Authentication successful` / `Authenticated` |
| 发测试消息 | 日志出现 inbound；`Reply message sent` + `Reply ack received` |

### 收发成功的日志示例

```text
[wecom] [default] Authentication successful
[wecom] [default] Reply message sent via WebSocket, reqId: ...
[wecom] [default] Reply ack received for reqId: ...
[plugin -> server] streamId=..., finish=true
```

---

## 11. 消息测试

1. 使用**测试企微机器人**（不要先用生产账号）。
2. 发送私聊或群聊 @ 消息。
3. 另开终端跟踪日志：

```bash
docker logs -f xa-gateway
```

4. 若网关已回复但内容异常，检查模型是否已按安装手册注入：工位 [WSL2 手册](OpenClaw%20Gateway%20WSL2-Docker%20安装手册.md) **6.4**；Linux 服务器手册 **第 12–13 节**。占位符未替换时按 `DashScope 兼容 Provider 配置手册.md` 配置。

---

## 12. 推荐操作顺序（速查）

```text
1. 确认 Gateway Up（/healthz 通）
2. plugins.allow 加入 wecom-openclaw-plugin
3. 安装插件（channels add --channel wecom 或 plugins install）
4. plugins enable wecom-openclaw-plugin
5. 配置 channels.wecom（botId/secret 用环境变量占位符）
6. 配置 allowFrom: ["*"]（测试）或 allowlist（生产）
7. docker compose restart
8. channels list / status / agents list --bindings
9. 企微发测试消息 + 看日志（初装 sendThinkingMessage=false；现网终态 true）
10. 配置国内模型（若 Agent 需正常对话）
11. 按第 16 节确认插件 ≥ 2026.7.2 后，按 7.4 打开 sendThinkingMessage（仓库样例与 Linux 手册 §21 已是 true）
```

---

## 13. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `blocked by allowlist` | `plugins.allow` 无 wecom | `config set plugins.allow` 加入插件 id，再 enable |
| `typed hook "before_prompt_build" blocked`（plugin=wecom-openclaw-plugin） | 未开 conversation hook | `entries.wecom-openclaw-plugin.hooks.allowConversationAccess: true`，再 restart。OA 桥接那一条不够 |
| `channels list` 为空 | 缺 `channels.wecom` 或插件未 enabled | 补 channels 配置并 restart |
| `plugin path not found` + `unknown channel id: wecom` | json 引用了不存在的插件目录 | 安装插件，或按 5.5 临时去掉 wecom 让网关先 Up |
| `channels add wecom` 无 wecom 选项 | 插件未安装 | 先装插件并重启 |
| 私聊收不到 / 无回复 | `allowFrom` 缺 `"*"` | `config set channels.wecom.allowFrom '["*"]'` |
| 发出去很久才回、客户端一直空白 | `sendThinkingMessage: false`，且要等 `kind=final` | 插件 ≥ 2026.7.2（须按 **第 16 节** 脱离 catalog 钉死）后按 **7.4** 打开占位；模型本身变快见百炼指南 §2.4 |
| 「思考中」一直转圈、正文不来 | 插件 2026.5.7 thinking 流卡在 `finish=false` | 改回 `sendThinkingMessage false` 并 restart；按 **第 16 节** 升到 ≥ 2026.7.2 再开。只跑 `plugins update` 会停在 2026.5.7 |
| 连发两条后会话卡住 | 2026.5.7 去掉了按会话串行排队 | 按 **第 16 节** 升到 ≥ 2026.7.2；卡住时只能 restart Gateway |
| `plugins update` 报 `up to date (2026.5.7)` | catalog 钉死，不是 npm 最新 | 第 16 节：`npm:@wecom/wecom-openclaw-plugin@版本 --force` |
| `docker exec` 报 missing env var | exec 不走 entrypoint | 可忽略；或 `-e` 传入 secrets。通道 `works` 时以主进程日志为准 |
| Gateway Up 但 `[wecom] channel autostart suppressed` | crash-loop breaker | **运维手册 11.4**：`gateway call channels.start`；不要 `channels start --channel` |
| `channels start` 报不认 `--channel` | 熔断覆盖是 RPC，不是这条 CLI | 运维手册 11.4 |
| `Restarting` 崩溃循环 | 非法 config / 未知通道 / 无效 meta | `compose down`，`config validate` 或 `doctor --fix` |
| 能连上但不智能回复 | 模型未配置 | 按 `DashScope 兼容 Provider 配置手册.md` 配置 |
| 同一 Bot 多 Gateway | 单账号限制 | 只保留一个 Gateway，不要复制 compose |

---

## 14. 不要做的事

| 禁止 | 原因 |
| --- | --- |
| 跑 `onboard` / `setup` | 会覆盖 xA 的 agent、workspace、插件路径 |
| 把 BotSecret 写入 json 明文 | 安全风险；用 Docker secrets + 占位符 |
| 无插件时保留 `channels.wecom` | 网关拒绝启动 |
| 复制相同 Bot 起第二个容器 | 抢连接、重复回复、会话混乱 |
| 在生产账号上做首次联调 | 用测试机器人 |

---

## 15. 完整 openclaw.json 片段参考（企微相关）

Gateway Up、插件 npm 安装成功后的典型片段。**现网仓库样例**（`openclaw/openclaw.json`）与 Linux 服务器手册 §21.1 终态：`sendThinkingMessage: true`（插件须 ≥ 2026.7.2）。**初装**尚未确认插件版本时先写 `false`，见 **7.4**。

```json
{
  "bindings": [
    {
      "type": "route",
      "agentId": "itservicedeskagent",
      "match": {
        "channel": "wecom",
        "accountId": "default"
      }
    }
  ],
  "channels": {
    "wecom": {
      "enabled": true,
      "dmPolicy": "open",
      "allowFrom": ["*"],
      "groupPolicy": "open",
      "sendThinkingMessage": true,
      "botId": "${XA_IT_WECOM_BOT_ID}",
      "secret": "${XA_IT_WECOM_BOT_SECRET}"
    }
  },
  "plugins": {
    "allow": [
      "oa-workflow-bridge",
      "wecom-openclaw-plugin"
    ],
    "load": {
      "paths": [
        "/home/node/.openclaw/extensions/oa-workflow-bridge"
      ]
    },
    "entries": {
      "oa-workflow-bridge": { "enabled": true, "hooks": { "allowConversationAccess": true } },
      "wecom-openclaw-plugin": { "enabled": true, "hooks": { "allowConversationAccess": true } }
    }
  }
}
```

---

## 16. 版本兼容与升级

**本文只在这里写全：** catalog 钉死版 vs npm 最新、`plugins update` 为何升不上去、怎样装指定 npm 版。`sendThinkingMessage` 何时打开仍见 **7.4**。`docker exec` 缺环境变量见 **4.1**，不要当成升级失败。

### 16.1 配对

| OpenClaw 版本 | 企微插件版本建议 | `sendThinkingMessage` |
| --- | --- | --- |
| ≥ 2026.9.2（**现网仓库样例**） | 插件 **≥ 2026.7.2** | **`true`**（与 `openclaw/openclaw.json`、Linux 安装手册 §21 终态一致） |
| ≥ 2026.7.x | 插件 **≥ 2026.7.2**（推荐；须脱离 catalog 钉死，见 16.3） | 收发稳定后改为 `true`（见 7.4） |
| ≥ 2026.3.22 | 插件 ≥ 2026.3.24 | 初装 `false` |
| < 2026.3.22 | 插件保持 2026.3.20 | 保持 `false` |
| 历史：2026.7.1 + catalog **2026.5.7** | 可收发 | **不要**打开思考中 |

历史上 xA 用过 OpenClaw **2026.7.1** + catalog 钉死的 **2026.5.7**：WebSocket 可以收发，但 **不要**在该插件版本打开 `sendThinkingMessage`（thinking 流会卡在 `finish=false`）。要占位动画，必须先按 16.3 装到 **≥ 2026.7.2**。现网 Gateway 已是 **2026.9.2**，json 里该项为 `true`。

npm 包 `@wecom/wecom-openclaw-plugin` 的 peer 为 `openclaw >= 2026.3.28`。2026.9.2 满足；以 [npm 包页](https://www.npmjs.com/package/@wecom/wecom-openclaw-plugin) 当时显示的 Version 为准。2026-09-04 查到最新为 **2026.8.17**。

对照：[OpenClaw WeCom 通道](https://docs.openclaw.ai/channels/wecom)（catalog 装 exact version）、[Manage plugins](https://docs.openclaw.ai/plugins/manage-plugins)（`npm:` 前缀与 `--force`）。

### 16.2 为何 `plugins update` 停在 2026.5.7

OpenClaw 官方 catalog 给当前 Gateway 配的是 **exact version**，不是「永远跟 npm latest」。`plugins update <id>` 复用已跟踪的安装源。历史上 2026.7.1 把企微插件钉在 **2026.5.7**，因此旧环境会出现：

```text
wecom-openclaw-plugin is up to date (2026.5.7).
```

表示「已是 catalog 目标」，**不是**「已经等于 npm 最新」。

裸写 `oc plugins install @wecom/wecom-openclaw-plugin`（无 `npm:` 前缀）同样走 catalog。官方文档：包名若匹配 bundled / official 插件 id，用 catalog 副本，不用 npm latest。

`docker exec` 同时打出 `Missing env var "XA_DOMESTIC_*"` / `OPENCLAW_GATEWAY_TOKEN` / `XA_IT_WECOM_*` 是 **4.1** 的正常现象，与插件版本无关，**不必**为升插件去重建 secrets。正在跑的 Gateway 主进程不受影响。

### 16.3 脱离钉死，装 npm 指定版

须已在 `plugins.allow` 中（见第 6 节）。**不要** `openclaw doctor --fix`。**不要**把 `wecom-openclaw-plugin` 写入 `tools.alsoAllow`（官方 README 会让你加；xA 热路径只保留 `oa_workflow`，见配置参考 5.5）。

先看现网版本：

```bash
oc plugins list
# 看 @wecom/wecom-openclaw-plugin 的 version
```

再查 npm 最新（或直接指定已知版本，下例为 2026-09-04 的 2026.8.17）：

```bash
# 推荐：显式 npm 源 + 版本，覆盖已有 catalog 安装
oc plugins install npm:@wecom/wecom-openclaw-plugin@2026.8.17 --force --accept-capabilities
```

`--force`：确认非 ClawHub 源并覆盖已有安装目录。`--accept-capabilities`：非交互确认能力清单（新版本可能比 2026.5.7 多声明能力）。把 `2026.8.17` 换成 npm 包页当时的 Version。

等价：企微官方 CLI（在容器内跑）：

```bash
docker exec -it xa-gateway npx -y @wecom/wecom-openclaw-cli install --version 2026.8.17 --force
```

然后必须重启（改插件代码不会热替换）：

```bash
cd ~/xa
docker compose restart xa-gateway
sleep 5
curl -sS http://127.0.0.1:18789/healthz; echo
oc plugins list
oc channels status --channel wecom
```

`plugins list` 的 `version` 必须变成目标号。若仍是 `2026.5.7`：

- 命令写成了无 `npm:` 的 `plugins update wecom-openclaw-plugin` 或 `plugins install @wecom/wecom-openclaw-plugin`，仍在走 catalog。
- 插件是拷进 `~/xa/extensions/wecom-openclaw-plugin` 且出现在 `plugins.load.paths` 的：`plugins update` / `plugins install` **不会**改这份目录。要么替换该目录，要么改走 npm 托管并从 `load.paths` **去掉** wecom 那条，然后 `docker compose down && docker compose up -d`（`load.paths` 只在启动时读）。OA 桥接的 path 不要删。

### 16.4 升完

1. 先保持 `sendThinkingMessage: false`，私聊测收发。
2. `version` ≥ 2026.7.2 且收发稳定后，再按 **7.4** 打开占位。打开后「思考中」不消失：立刻改回 `false` 并 `docker compose restart`。
3. 不要把官方 README 里的 `tools.alsoAllow '["wecom-openclaw-plugin"]'` 应用到 xA。

---

## 17. 相关文档

| 文档 | 内容 |
| --- | --- |
| `OpenClaw Gateway WSL2-Docker 安装手册.md` | 工位 WSL2 + Docker 全链路部署 |
| `OpenClaw Gateway Linux 服务器安装手册.md` | Linux 服务器安装（独立完整路径） |
| `OpenClaw Gateway Docker 运维手册.md` | 日常巡检、日志 grep、睡眠后重连、升级回滚 |
| `第三方凭据注入与配置中心演进.md` | 第三方参数 Docker 注入 → Nacos 迁移 |
| `DashScope 兼容 Provider 配置手册.md` | 关掉 qwen3.8-max 隐藏思考（与 7.4 占位配合）；企微通后模型回归 |
| `外部系统 Tool 插件设计规范.md` | OA 插件形式（`oa_workflow`） |
| `xA 现网加固与演进全景.md` | OA 主路径、切入范围、各层 I/O |
| `OA_tool/企微到OA身份与数据流.md` | `from.userid`、`oa_identity` 缓存、通道回传字段 |
| `OA_tool/身份适配器说明.md` | 转换层（独立适配器已验证；不在本通道插件内） |
| `第三方凭据注入与配置中心演进.md` | 凭据与安全边界 |
| [OpenClaw WeCom 官方文档](https://docs.openclaw.ai/channels/wecom) | catalog 安装的是 exact version |
| [OpenClaw Manage plugins](https://docs.openclaw.ai/plugins/manage-plugins) | `npm:` 前缀、`--force`、`--accept-capabilities` |
| [@wecom/wecom-openclaw-plugin README](https://www.npmjs.com/package/@wecom/wecom-openclaw-plugin) | npm 当前 Version；配置项。**不要**按该 README 把插件 id 写入 xA 的 `alsoAllow` |

---

## 18. 检查清单（打印用）

| 步 | 操作 | 通过标准 |
| --- | --- | --- |
| 1 | Gateway Up | `/healthz` 返回 ok |
| 2 | secrets + entrypoint | 容器内 BotId/Secret 非空 |
| 3 | `plugins.allow` 含 wecom | `config validate` 无 allowlist 错误 |
| 4 | 插件 installed + enabled | `plugins list` 显示 enabled |
| 5 | `channels.wecom` 已配置 | `channels list` 有 WeCom default |
| 6 | `allowFrom` 含 `"*"`（测试） | 日志无 DM dropped 警告 |
| 7 | 路由正确 | `agents list --bindings` 指向 itservicedeskagent |
| 8 | 日志鉴权成功 | `Authentication successful` |
| 9 | 测试消息 | `Reply sent` + `Reply ack received` |
| 10 | 国内模型 | Agent 能按业务规则回复（可选，后续） |
| 11 | 「思考中」占位（可选） | 按第 16 节确认 `plugins list` ≥ 2026.7.2（catalog 的 2026.5.7 不够）后 `sendThinkingMessage: true`；发出去 1～2 秒内有占位，结束有 `finish=true` |
