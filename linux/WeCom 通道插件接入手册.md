# WeCom 通道插件接入手册

企业微信不是 OpenClaw 内置通道，靠外部插件 `@wecom/wecom-openclaw-plugin`（id `wecom-openclaw-plugin`）收发。本仓库不含插件源码，从 npm 安装。安装命令见安装手册第 8 节，本文讲配置含义、「思考中」、版本和排障。

## 1. 要点

```text
员工企微 ─WebSocket─► wecom-openclaw-plugin ─► Gateway ─bindings─► itservicedeskagent
```

- 同一套 BotId / BotSecret 只能被一个 Gateway 持有，复制容器会抢连接、重复回复。
- 插件没装、没 enabled 时不能写 `channels.wecom`，否则 `unknown channel id: wecom`，容器反复重启。
- 入站发送人 `body.from.userid` 是**加密 userid**（`wo…`），不是工号。转成 OA 申请人由 OA 桥接完成，见 [企微到OA身份.md](OA_tool/企微到OA身份.md)。
- 插件会注册 `wecom_mcp` 工具和 `wecomcli-*` Skill，xA 都不用：`alsoAllow` 只放 `oa_workflow`，`agents.defaults` 与 Agent 两处都写 `skills: []`。去掉 `wecom_mcp` 不会关掉企微收发。不要照插件 README 把插件 id 写进 `alsoAllow`。

三层开关不要混：

| 层 | 配置 | 作用 |
| --- | --- | --- |
| 插件能否加载 | `plugins.allow` + `plugins.entries.wecom-openclaw-plugin.enabled` | 不在 allow 里会 `blocked by allowlist` |
| 通道收发 | `channels.wecom` | 机器人凭据、私聊 / 群聊策略 |
| 路由 | `bindings`：`wecom/default` → `itservicedeskagent` | 消息交给哪个 Agent |

## 2. 配置项

现网值见 `workspace-rules/openclaw.json`。

| 字段 | 现网 | 说明 |
| --- | --- | --- |
| `channels.wecom.botId` / `secret` | `${XA_IT_WECOM_BOT_ID}` / `${XA_IT_WECOM_BOT_SECRET}` | 真值只在 secret 文件 |
| `dmPolicy` / `groupPolicy` | `open` | 生产要收紧时改 `dmPolicy: allowlist` + `allowFrom: [userid…]` |
| `allowFrom` | `["*"]` | `dmPolicy: open` 时必须含 `"*"`，否则所有私聊被丢弃（日志 `all DMs will be dropped`） |
| `sendThinkingMessage` | `true` | 见第 3 节，插件 ≥ 2026.7.2 才能开 |
| `plugins.entries.wecom-openclaw-plugin.hooks.allowConversationAccess` | `true` | 不开会 `before_prompt_build blocked`；OA 桥接那条单独配 |
| `plugins.load.paths` | 只有 OA 桥接 | npm 托管安装不需要写企微路径 |

## 3. 「思考中」占位

`sendThinkingMessage` 是企微客户端的占位动画：消息一到就显示「思考中」，正文生成完后替换。它**不缩短**模型耗时；模型慢要关百炼隐藏思考，见 [DashScope 手册](DashScope%20兼容%20Provider%20配置手册.md) 第 3、4 节。

- 插件 2026.5.7 上不能开：回复流卡在 `finish=false`，占位不消失；连发两条后会话卡住。2026.7.2 修复。
- 开之前 `oc plugins list` 确认 version ≥ 2026.7.2，且关着时收发已正常。
- 验证：私聊「你是谁」，1～2 秒内出现占位；日志 `kind=final` → `Reply message sent` → `Reply ack received` → `finish=true`。
- 占位不消失或回复丢失：立刻 `oc config set channels.wecom.sendThinkingMessage false`，`docker compose restart`，再查版本。

## 4. 验证

```bash
oc plugins list                              # wecom-openclaw-plugin enabled，version ≥ 2026.7.2
oc channels list                             # WeCom default: installed, configured, enabled
oc channels status --channel wecom --probe   # enabled, configured, running, works
oc agents list --bindings                    # wecom accountId=default → itservicedeskagent
docker logs --tail 50 xa-gateway | grep -i wecom   # Authentication successful
```

用测试机器人发消息，日志应有 inbound、`Reply message sent`、`Reply ack received`。首次联调不要用生产 Bot。

## 5. 版本与升级

OpenClaw 官方 catalog 给每个 Gateway 版本钉一个**固定**插件版本，不跟 npm latest。所以：

- `oc plugins update wecom-openclaw-plugin` 只会报 `up to date (<catalog 版本>)`（历史上 OpenClaw 2026.7.1 钉在 2026.5.7）。
- 不带 `npm:` 前缀的 `oc plugins install @wecom/wecom-openclaw-plugin`、`oc channels add --channel wecom` 也走 catalog。

装指定 npm 版（插件须已在 `plugins.allow`）：

```bash
oc plugins install npm:@wecom/wecom-openclaw-plugin@<版本> --force --accept-capabilities
cd ~/xa && docker compose restart xa-gateway
oc plugins list      # version 必须变成目标号
```

`<版本>` 取 [npm 包页](https://www.npmjs.com/package/@wecom/wecom-openclaw-plugin) 当时的 Version（≥ 2026.7.2；插件 peer 要求 `openclaw >= 2026.3.28`）。`--force` 覆盖已有安装，`--accept-capabilities` 非交互确认能力清单。

升完先把 `sendThinkingMessage` 设 `false` 测收发，正常后再打开。不要用 `doctor --fix` 装或升插件。

插件若是拷进 `~/xa/extensions/` 并写在 `load.paths` 的旧装法，`plugins install/update` 不会改那份目录：删掉那条 path，改走 npm 托管，`down && up`。

参考：[OpenClaw WeCom](https://docs.openclaw.ai/channels/wecom)、[Manage plugins](https://docs.openclaw.ai/plugins/manage-plugins)。

## 6. 常见问题

| 现象 | 处理 |
| --- | --- |
| `blocked by allowlist` | `plugins.allow` 加 `wecom-openclaw-plugin`，entries enabled |
| `unknown channel id: wecom` / `plugin path not found` | 插件没装就写了通道：去掉 `channels` 与 `bindings`，`down && up`，先装插件 |
| `before_prompt_build blocked`（plugin=wecom-openclaw-plugin） | 企微那条 entries 补 `hooks.allowConversationAccess: true`，`restart` |
| `channels list` 为空 | 缺 `channels.wecom`，或插件没 enabled |
| 私聊没回复，日志 `DM dropped` | `allowFrom` 缺 `"*"` |
| 「思考中」一直转 / 连发后卡住 | 插件 < 2026.7.2：先关占位，再按第 5 节升级 |
| `[wecom] channel autostart suppressed` | 崩溃熔断，见运维手册第 8 节；不要 `channels start --channel` |
| 能连上但回复不对 / 不回复 | 查模型，见 DashScope 手册 |
| 日志出现 `smartsheet_get_records`、`errcode=851014` | 模型调了企微文档 MCP：两处 `alsoAllow` 只留 `oa_workflow`，两处 `skills: []`，`restart` 后 `/new`，`/context detail` 中 `Skills list` 为 0。不要为此去授权企微文档 |
| `docker exec` 报 `missing env var` | exec 不跑 entrypoint，可忽略；以主进程日志为准 |
| 两个 Gateway 用同一 Bot | 只留一个 |
