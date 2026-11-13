# DashScope 兼容 Provider 配置手册

阿里云百炼（DashScope）在 OpenClaw 里按 **OpenAI 兼容自定义 Provider** 接入。完整配置以仓库 `workspace-rules/openclaw.json` 的 `models` 段为准；凭据经 secret 注入，见安装手册第 4 节。

官方参考：[OpenClaw Custom providers](https://docs.openclaw.ai/gateway/config-tools#custom-providers-and-base-urls)、[OpenClaw Qwen thinking controls](https://docs.openclaw.ai/providers/qwen)、[百炼 OpenAI 兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)。

## 1. 命名规则

| 名字 | 位置 | 现网 |
| --- | --- | --- |
| Provider 键 | `models.providers.<键>` | `bailian` |
| 模型 ID（发给百炼的 `model`） | `models[].id` = `${XA_DOMESTIC_MODEL_ID}` | 以百炼控制台为准 |
| 展示名（必填，缺了 exit 78） | `models[].name` | `qwen3.8 flash`，可与 id 不同 |
| 完整引用 | Agent `model` = `${XA_DOMESTIC_MODEL_REF}` | `bailian/<模型 ID>` |

**Provider 键、`model_ref.txt` 前缀、启动日志里的 `agent model: bailian/…` 必须一致。** 环境变量前缀 `XA_DOMESTIC_*` 是历史命名，与 Provider 键无关。

## 2. 地域与 Base URL

API Key、Base URL、模型必须同一地域：

| 地域 | Base URL |
| --- | --- |
| 北京（现网） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 新加坡 | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| 美国 | `https://dashscope-us.aliyuncs.com/compatible-mode/v1` |

不要用 `coding.dashscope.aliyuncs.com`（Coding Plan 专用）或 `/api/v1`（原生接口，非兼容路径）。协议在 json 里写死 `"api": "openai-completions"`。

## 3. 必须有的字段

| 字段 | 值 | 不写的后果 |
| --- | --- | --- |
| `models[].reasoning` | `false` | 百炼不支持 `developer` 角色，400 或空回复 |
| `models[].compat` | `{"thinkingFormat": "qwen", "supportsDeveloperRole": false}` | 自定义 Provider 不会发 `enable_thinking: false`，Qwen3 按默认 xhigh 先思考，每轮多等 8～20 秒 |
| `models[].input` | `["text"]` | 含 `image` 会把百炼登记成图片理解后端 |
| Provider `timeoutSeconds` | `20`（与 `api` 同级，不小于约 15） | 首包卡住时空等约 27 秒（`timeoutMs=undefined`） |
| Agent `thinkingDefault` | `"off"` | 日志出现 `thinking=on` |
| `tools.media.image/audio/video.enabled` | 全 `false`；不设 `imageModel` | 每张图多约 7 秒 `apply_media_understanding` |
| `~/xa/workspace/MEMORY.md` | 存在即可（仓库已带占位） | 群聊 `read failed: ENOENT … MEMORY.md` 后再跑一轮模型 |

日志里的 `thinking=off` 只是 OpenClaw 会话开关，**不能代替** `compat.thinkingFormat`；后者才决定请求体里有没有 `enable_thinking`。`config validate` 报 `thinkingFormat` / `timeoutSeconds` 非法，说明镜像太旧，先升级，不要删字段。

禁止：json 写 Key / Base URL 明文；`config set models.providers…` 写真值；`onboard` / `models auth paste-api-key`；在 `auth.profiles` 放 `apiKey`。

## 4. 慢回复排查

私聊发一次「你是谁」，同时 `docker logs -f --timestamps xa-gateway`：

| 检查 | 正常 | 不正常 → 处理 |
| --- | --- | --- |
| `model-fetch` 200 → `kind=final` 间隔 | 2～5 秒 | 8～20 秒 → 补 `compat.thinkingFormat: "qwen"` |
| `[model-fetch] start … timeoutMs=` | `20000` | `undefined` → 补 `timeoutSeconds: 20` |
| 发图后 `apply_media_understanding` | 无或几十毫秒 | 数秒 → 关 `tools.media`，`input` 收成 `["text"]` |
| 群聊寒暄 | 一次 `model-fetch` | 先 `ENOENT … MEMORY.md` 再第二次 → 补 `MEMORY.md` |
| 启动日志 | `agent model: bailian/… (thinking=off …)` | `thinking=on` → `thinkingDefault: "off"` |

`elapsedMs` 只是首包时间，体感看首包到 `kind=final`。改完 `config validate`，`docker compose restart`。

模型快了但员工仍觉得「发出去没反应」：打开企微「思考中」占位（`channels.wecom.sendThinkingMessage: true`，插件 ≥ 2026.7.2）。占位不缩短模型耗时，和百炼思考链是两件事。

## 5. 常见报错

| 日志 | 原因 | 处理 |
| --- | --- | --- |
| exit 78，`models.providers.bailian.models.0.name: Invalid input` | 缺 `name` 或 JSON 语法错 | 补字段，`down && up` |
| `Unknown model: bailian/…`、`model_not_found` | `model_ref.txt` 前缀与 Provider 键不一致 | 统一成 `bailian/<模型 ID>`，`down && up` |
| 日志模型正确但调用失败 | Key 没开通该模型，或地域不一致 | 百炼控制台确认；先换 `qwen-plus` 测连通 |
| `restart-loop breaker tripped` | 之前多次启动失败 | 运维手册第 8 节 |
| 有 `agent/models.json`（可能含明文 Key） | Control UI / CLI 写过 Provider | 删除 `~/xa/config/agents/itservicedeskagent/agent/models.json`，`restart` |
| `LiteLLM pricing fetch failed` | 拉定价超时 | 可忽略 |

## 6. 换模型与回归

只换模型：改 `model_id.txt` 和 `model_ref.txt`（`bailian/<新 ID>`），`down && up`，看 `agent model` 日志。json 不用改。换 Base URL / Key 同理只改 secret。

换模型时不要同时改 OA `active`、规则或插件，否则分不清是谁的问题。回归要点：

- `prepare` →（`attach`）→ `submit_confirmed` 参数符合 Schema，不加未定义字段。
- 调工具前不播报内部步骤；员工回复原样转发 `replyZh`。
- 不把 SenderId、mappingCode、OA 人员 id、内部工单号写进回复；不编造系统、处理人、OA 字段。
- 工具失败后不说「已登记」；同一确认号不重复提交。
- 多系统 / 缺地点时追问，不 `prepare`。
- 发图不触发媒体理解，回复不描述图片内容。
