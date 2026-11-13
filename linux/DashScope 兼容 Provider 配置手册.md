# DashScope 兼容 Provider 配置手册

> 本文档由仓库根目录原文档**重组**而来：只调整章节归属与交叉引用，**不改变**部署步骤、命令、YAML、错误码或禁止事项。阅读顺序见 [README.md](README.md)。

适用对象：按 **[OpenClaw Gateway Linux 服务器安装手册.md](OpenClaw%20Gateway%20Linux%20服务器安装手册.md)** 部署 xA OpenClaw Gateway，需要接入**阿里云百炼（DashScope）**大模型的工程师。Linux 服务器：第 6.1 节变量契约、第 12–13 节写入模型并第二次 `up`。

本文档汇总百炼模型在 Docker 全注入路径下的配置思路、字段含义、验证步骤、工具调用回归与常见报错处理。与工位安装手册 **6.4 节**、Linux 服务器安装手册 **第 12–13 节** 配套使用。

---

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| Gateway | `/healthz` 返回 200，容器 `Up` |
| 企微 | 插件与通道已按 `WeCom 通道插件接入手册.md` 配完（可选，但建议先通网关再配模型） |
| 百炼账号 | 已开通百炼，取得 **API Key** 与可用**模型名称** |
| 注入方式 | secret → `entrypoint.sh` → 环境变量 → `openclaw.json` 中 `${VAR}`；**禁止**在 json 中写 Key 明文 |

**官方参考：**

- [OpenClaw — Custom providers](https://docs.openclaw.ai/gateway/config-tools#custom-providers-and-base-urls)
- [百炼 — OpenAI 兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)

---

## 1. 核心概念（必读）

百炼**不是** OpenClaw 内置带 API Key 的 Provider，必须按 **OpenAI 兼容自定义 Provider** 配置。

### 1.1 三层命名关系

OpenClaw 里与「模型」相关的名字有 **三层**，容易混用：

```text
┌─────────────────────────────────────────────────────────────┐
│ providers.<名字>          ← Provider 标识（自定义，如 domestic）│
│   models[].id             ← 发给百炼 API 的 model 参数         │
│   models[].name           ← OpenClaw 内部展示名（必填）        │
├─────────────────────────────────────────────────────────────┤
│ agents.entries.*.model    ← 完整 ref：<Provider名>/<模型id>    │
│ secret model_ref.txt      ← 同上，通过 ${XA_DOMESTIC_MODEL_REF} 注入 │
└─────────────────────────────────────────────────────────────┘
```

**铁律：`providers` 的键名、`model_ref`、`Agent.model` 的前缀必须一致。**

| 写法 | 含义 | 示例 |
| --- | --- | --- |
| `providers.domestic` | OpenClaw 内部的 Provider 标识 | 可改为 `bailian`、`dashscope`，仅为标签 |
| `models[].id` | 百炼 API 请求体里的 `model` 字段 | `qwen-plus`、`qwen3.8-flash`、`qwen3.8-max` |
| `models[].name` | Control UI / `models list` 展示用 | 现网仓库样例 `qwen3.8 flash`；与 `id` 不必相同 |
| `model_ref` | Agent 选用的完整模型引用 | 现网 `bailian/<model_id>` |

### 1.2 `domestic` 还是 `bailian`？

**都可以**，OpenClaw 不强制 Provider 名。Linux 服务器手册与现网样例用 **`bailian`**。环境变量前缀都是 `XA_DOMESTIC_*`，与 Provider 键名无关。

| 方案 | `openclaw.json` | `model_ref.txt` |
| --- | --- | --- |
| A（自定义键名，例如 `domestic`） | `providers.domestic` | `domestic/<model_id>` |
| B（**Linux 服务器手册 §6.1 / §12 与现网仓库样例**） | `providers.bailian` | `bailian/<model_id>` |

**不要混用**：json 里写 `domestic`，secret 里写 `bailian/qwen3.8-max` → 报错 `Unknown model: bailian/qwen3.8-max`。

### 1.3 `id` 与 `name` 的区别

| 字段 | 谁用 | 能否省略 |
| --- | --- | --- |
| `id` | 百炼 API | 否（通过 `${XA_DOMESTIC_MODEL_ID}` 注入） |
| `name` | OpenClaw  catalog / UI | **否**；省略会导致 `InvalidConfigError`，Gateway exit 78 反复重启 |

`name` 可与 `id` 相同，或写成更易读的展示名；**不影响**实际调用的百炼模型。

---

## 2. 百炼参数对照

### 2.1 地域与 Base URL

API Key、Base URL、模型必须属于**同一地域**。

| 地域 | Base URL（OpenAI 兼容模式） |
| --- | --- |
| 华北2（北京，常用） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 新加坡 | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| 美国（弗吉尼亚） | `https://dashscope-us.aliyuncs.com/compatible-mode/v1` |

**常见误用：**

| URL | 说明 |
| --- | --- |
| `https://coding.dashscope.aliyuncs.com/v1` | Coding Plan 专用，与百炼通用 Key 不通用 |
| `https://dashscope.aliyuncs.com/api/v1` | DashScope 原生接口，非 OpenAI 兼容路径 |

### 2.2 API 协议

百炼兼容模式使用：

```text
api: openai-completions
```

可写在 `openclaw.json` 固定值，也可通过 secret `model_api.txt` → `${XA_DOMESTIC_API}` 注入（**Linux 服务器**手册第 12 节把 `api` 写死为 `"openai-completions"`）。

### 2.3 常用模型 ID（以控制台为准）

| 模型 ID | 说明 |
| --- | --- |
| `qwen-plus` | 通用，易开通，建议先用来连通性测试 |
| `qwen-max` | 旗舰文本 |
| `qwen3.8-max` | 新一代旗舰（需账号有权限） |
| `qwen3.8-flash` | 现网仓库 `openclaw.json` 展示名对应的这一档；`id` 仍以 secret `model_id.txt` / 百炼控制台为准 |
| `qwen-turbo` | 轻量快速 |

模型 ID 必须以百炼控制台「模型列表」为准；账号未开通的模型会报「模型不可用」。

### 2.4 必填：`reasoning: false`，以及关掉 Qwen3 的隐藏思考

百炼 OpenAI 兼容端点不支持 OpenClaw 在 `reasoning: true` 时使用的 `developer` 角色。catalog 中务必设置：

```json
"reasoning": false
```

否则可能出现 HTTP 400 或回复为空。

**只设 `reasoning: false` 不够。** `qwen3.8-max` / `qwen3.8-flash` 在百炼侧默认思考级别是 **`xhigh`**。你用的是自定义 Provider（`bailian` / `domestic`），不是官方 `@openclaw/qwen-provider`，Gateway 日志里的 `thinking=off` **不会**自动变成请求体里的 `enable_thinking: false`。模型会先生成一长段不可见的 `reasoning_content`，企微插件又要等 `kind=final` 才把回复发出去，用户就会觉得「问了很久才回」。

实测特征：`[model-fetch] response ... elapsedMs=1500~2500`（首包很快），然后还要再等 8～20 秒才出现 `kind=final`，可见回复只有一两百字。

自定义 Provider 必须在模型条目上声明 Qwen 的思考开关格式：

```json
"compat": {
  "thinkingFormat": "qwen",
  "supportsDeveloperRole": false
}
```

这样 OpenClaw 才会在 `thinking=off` 时向百炼发送顶层 `"enable_thinking": false`。改完后 `config validate`，再 `docker compose restart`。

`thinkingFormat` 取值：

| 值 | 发给百炼的字段 | 何时用 |
| --- | --- | --- |
| `"qwen"` | 请求体顶层 `"enable_thinking": true/false` | **自定义 Provider + 百炼 compatible-mode，推荐** |
| `"qwen-chat-template"` | `chat_template_kwargs.enable_thinking` | 本地 llama.cpp / 部分自建兼容端 |
| 省略 | 不发 `enable_thinking` | `qwen3.8-max` 会按默认 **xhigh** 思考（就是企微「问了很久才回」） |

Agent 上保持思考关闭（启动日志应出现 `thinking=off`）：

```json
"agents": {
  "entries": {
    "itservicedeskagent": {
      "model": "${XA_DOMESTIC_MODEL_REF}",
      "thinkingDefault": "off"
    }
  }
}
```

Gateway 日志里的 `thinking=off` **不能代替** `compat.thinkingFormat`。前者是 OpenClaw 会话开关，后者才决定百炼请求体里有没有 `enable_thinking`。

对照：[OpenClaw Qwen provider — Thinking controls](https://docs.openclaw.ai/providers/qwen)

### 2.5 必补：workspace 根目录的 `MEMORY.md`

xA Agent 的 `tools.profile` 为 `minimal` + `alsoAllow` 仅含 `oa_workflow`（`group:fs` 已 deny，不要再开 `read`）。根目录仍须有 `MEMORY.md`，否则官方会注入 missing-file 标记。热路径**不要**再 `read` 它，也不要调用 `memory_search`。文件不存在且模型仍去读时，旧日志长这样：

```text
[tools] read failed: ENOENT: no such file or directory, access '/home/node/.openclaw/workspace/MEMORY.md'
[model-fetch] start ...   ← 立刻开始第二轮 qwen3.8-max
```

每一轮都会再走一遍隐藏思考，群聊「你好」可以从约 12 秒变成约 37 秒。

部署或排障时在 **Gateway 宿主机家目录**（`~/xa` 所在机器）执行：

```bash
# 本仓库 workspace-rules 已含占位 MEMORY.md；没有则建一个
test -f ~/xa/workspace/MEMORY.md || printf '%s\n' '# MEMORY' > ~/xa/workspace/MEMORY.md
sudo chown 1000:1000 ~/xa/workspace/MEMORY.md
```

需要长期记忆时，把细则写进 `~/xa/workspace/memory/` 子目录。xA 工单热路径**不要** `memory_search`；根目录 `MEMORY.md` 只留索引，避免每次把大文件灌进系统提示。

---

## 3. Docker 全注入（阶段 B）

变量契约如下。现网样例 Provider 名用 `bailian`；改用别的键名时，`model_ref.txt` 前缀必须跟着改。

| 参数 | 环境变量 | secret 文件 | 示例值 |
| --- | --- | --- | --- |
| API Key | `XA_DOMESTIC_API_KEY` | `model_api_key.txt` | `sk-...`（一行，无换行） |
| Base URL | `XA_DOMESTIC_BASE_URL` | `model_base_url.txt` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 模型 ID | `XA_DOMESTIC_MODEL_ID` | `model_id.txt` | 以百炼控制台为准（安装手册示例 `qwen3.8-max`；现网展示名 flash） |
| 完整 model ref | `XA_DOMESTIC_MODEL_REF` | `model_ref.txt` | 工位 `domestic/<id>`；现网 / Linux `bailian/<id>` |
| API 协议（可选） | `XA_DOMESTIC_API` | `model_api.txt` | `openai-completions` |

**`model_ref` 规则：**

```text
model_ref = <providers 键名> + "/" + <model_id 的值>
```

示例：`providers.domestic` + `model_id=qwen3.8-max` → `model_ref=domestic/qwen3.8-max`。

### 3.1–3.3 secret / entrypoint / compose（命令以安装手册为准）

创建 `model_*.txt`、升级 `entrypoint.sh`、在 compose 挂载 5 个 model secret，以及 `compose down && up`，完整命令见：

**[OpenClaw Gateway Linux 服务器安装手册.md](OpenClaw%20Gateway%20Linux%20服务器安装手册.md) 第 12–13 节**

改 secret 挂载后须重建容器（与安装手册相同，步骤未改）：

```bash
cd ~/xa
docker compose down
docker compose up -d
```

## 4. openclaw.json 配置模板

在顶层增加或合并 `models` 段；Agent 使用 `${XA_DOMESTIC_MODEL_REF}`：

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "domestic": {
        "baseUrl": "${XA_DOMESTIC_BASE_URL}",
        "apiKey": "${XA_DOMESTIC_API_KEY}",
        "api": "openai-completions",
        "timeoutSeconds": 20,
        "models": [
          {
            "id": "${XA_DOMESTIC_MODEL_ID}",
            "name": "qwen3.8-max",
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
        ]
      }
    }
  },
  "agents": {
    "entries": {
      "itservicedeskagent": {
        "model": "${XA_DOMESTIC_MODEL_REF}",
        "thinkingDefault": "off",
        "workspace": "/home/node/.openclaw/workspace",
        "agentDir": "/home/node/.openclaw/agents/itservicedeskagent/agent"
      }
    }
  }
}
```

上面把 `api` 写死为 `"openai-completions"`，与 Linux 服务器手册第 12 节及现网样例一致。另有一个变体：把 `api` 也写成占位符 `"${XA_DOMESTIC_API}"`，真值来自 `model_api.txt`。两种写法都可用，但**同一环境只能选一种**：写死就不必挂 `model_api` secret，用占位符就必须保证 entrypoint 有 export，否则 `${XA_DOMESTIC_API}` 会替换成空串导致 Provider 加载失败。

**禁止：**

- 在 json 中写 API Key、Base URL 明文（Docker 路径）
- 用 `oc config set models.providers...` 写入真值
- 用 `onboard` / `models auth paste-api-key` 覆盖 secrets 体系
- 在 `auth.profiles` 里放 `apiKey`（百炼应走 `models.providers`）

### 4.1 Provider 名是 `bailian` 时（与启动日志一致）

启动日志若是 `agent model: bailian/...`，则 `providers` 键名必须是 **`bailian`**，`model_ref.txt` 必须是 `bailian/` + `model_id`。现网仓库样例走这条。把第 4 节模板里的 `"domestic"` 整段改名为 `"bailian"` 即可，**不要**再留一份 `providers.domestic`。展示名 `name` 现网为 `"qwen3.8 flash"`，与 `id`（secret）可以不同。

```json
"models": {
  "mode": "merge",
  "providers": {
    "bailian": {
      "baseUrl": "${XA_DOMESTIC_BASE_URL}",
      "apiKey": "${XA_DOMESTIC_API_KEY}",
      "api": "openai-completions",
      "timeoutSeconds": 20,
      "models": [
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
      ]
    }
  }
}
```

变量名仍用 `XA_DOMESTIC_*`（与两本安装手册变量契约一致：工位 6.0 / Linux 6.1），只改 json 里的 Provider 键和 `model_ref.txt` 前缀。

### 4.2 已上线环境：补 `compat`、超时、关掉图片理解、补 `MEMORY.md`

Gateway 已经在跑、只是企微回复慢或发图多等 7 秒时，**不必**重建 secrets，只改 `~/xa/config/openclaw.json` 并补文件：

```bash
# 1. 编辑 ~/xa/config/openclaw.json
#    a) models.providers.<domestic|bailian> 上加：
#         "timeoutSeconds": 20
#       （与 api 同级，不是写在 models[] 条目里）
#    b) 该 Provider 的 models[] 里 "input" 必须是 ["text"]，不要含 "image"
#    c) tools.media.image / audio / video 三项都是 { "enabled": false }
#       不要设 agents.defaults.imageModel
#    d) 若还没有 compat，在 "reasoning": false 后面插入：
#         "compat": { "thinkingFormat": "qwen", "supportsDeveloperRole": false }
#
# 2. 补 MEMORY.md
test -f ~/xa/workspace/MEMORY.md || printf '%s\n' '# MEMORY' > ~/xa/workspace/MEMORY.md
sudo chown 1000:1000 ~/xa/workspace/MEMORY.md

# 3. 校验并重启（catalog / timeoutSeconds / tools.media 需重启才稳定生效）
docker exec -it xa-gateway node dist/index.js config validate
cd ~/xa && docker compose restart
docker compose logs xa-gateway | grep -E "agent model|Authentication successful"
```

`config validate` 若报 `thinkingFormat` 或 `timeoutSeconds` 非法，说明当前 OpenClaw 镜像过旧，需要先升 `openclaw/openclaw` 镜像再改字段；不要删掉这些字段凑合运行。

---

## 5. 验证步骤

### 5.1 环境变量是否注入

```bash
docker exec xa-gateway sh -c '
  for v in XA_DOMESTIC_API_KEY XA_DOMESTIC_BASE_URL XA_DOMESTIC_MODEL_ID XA_DOMESTIC_MODEL_REF; do
    eval "test -n \"\$$v\"" || { echo "MISSING:$v"; exit 1; }
  done
  echo MODEL_INJECT_OK
'
```

### 5.2 配置与模型 catalog

```bash
docker exec -it xa-gateway node dist/index.js config validate
docker exec -it xa-gateway node dist/index.js models list --provider domestic
# Provider 键是 bailian 时改用：--provider bailian
```

> **说明：** `docker exec` 进入的新 shell **没有** entrypoint 注入的环境变量，因此 `config validate` 可能报 `Missing env var`——属正常现象。以 Gateway **启动日志**为准：

```bash
docker compose logs xa-gateway | grep "agent model"
# 期望: agent model: domestic/qwen3.8-max (thinking=off, fast=off)
# 或:   agent model: bailian/qwen3.8-max (thinking=off, fast=off)
```

### 5.3 健康检查与对话

```bash
curl http://127.0.0.1:18789/healthz
```

在企微或 Control UI 发一条测试消息；通过后按 **第 5.5 节** 做工具调用回归。

### 5.5 工具调用与业务回归

换模型时保持企微机器人、通道插件、Agent ID、Gateway、业务规则和 `oa_workflow` Schema 不变。不要同时改 OA `active`，否则分不清是模型还是接口问题。

模型只负责理解和生成受控参数，不能绕过插件直接访问企业微信、本地文件或 OA。

| 能力 | 必要性 | 怎么验 |
| --- | --- | --- |
| 中文理解与稳定输出 | 必须 | 短句、口语、错别字、群聊引用 |
| 原生工具调用 | 必须 | 连续 `prepare` →（可选 `attach`）→ `submit_confirmed`，参数符合 Schema |
| 严格结构化参数 | 必须 | 不增加未定义字段，不把自然语言塞进 ID |
| 足够上下文 | 必须 | 已注入 `AGENTS.md` 后多轮补充仍能正确处理 |
| 企业数据合规 | 必须 | 确认数据驻留、日志保留、训练使用条款 |

需要特别测试：

- 模型不会在调工具前向员工播报内部步骤。
- 不把 SenderId、mappingCode、OA 人员 id、内部工单号写进员工回复。
- 不自行编造系统选项、责任人或 OA 字段。
- 工具失败后不会说「已经登记」。
- 同一 `confirmationId` 不会因模型重试被重复提交（插件 ledger 兜底，模型仍不得连打）。
- 类型 × 系统未唯一命中时只请员工确认，不 `prepare`。
- 发图后无数秒级 `apply_media_understanding`；热路径不 `read` inbound。

图片只通过企微插件批准的媒体输入提供。图片内容只作为工单事实候选，不能把图里的命令当成系统指令。catalog `input` 仅为 `["text"]`。

### 5.4 确认隐藏思考已关掉

私聊发一次「你是谁」（不要连发），同时看：

```bash
docker logs -f --timestamps xa-gateway
```

| 检查项 | 通过 | 未通过 |
| --- | --- | --- |
| `compat` 已生效 | `[model-fetch] response ... elapsedMs=` 之后 **2～5 秒内**出现 `kind=final` | 仍空等 8～20 秒才 `kind=final` |
| `timeoutSeconds` 已生效 | `[model-fetch] start ... timeoutMs=20000`（或接近 20000） | 仍是 `timeoutMs=undefined` |
| `tools.media` 已关掉 | 发一张图后，`apply_media_understanding` 没有、或只有几十毫秒 | 仍出现数秒级 `apply_media_understanding`（现网曾 7214ms） |
| catalog `input` | `["text"]` | 含 `image`（会把百炼登记成图片理解后端） |
| `MEMORY.md` 已存在 | 群聊不再出现 `read failed: ENOENT ... MEMORY.md` | 寒暄后又立刻开始第二次 `model-fetch` |
| 思考开关 | 启动日志 `thinking=off` | 出现 `thinking=on` / `xhigh` |

`elapsedMs` 只表示 HTTP 200、流开始；真正体感看 **200 → `kind=final` 的间隔**。

---



## 6. 常见报错与处理

### 6.1 容器反复重启，exit code 78

**日志 / stability 包：**

```text
Invalid config: models.providers.domestic.models.0.name: Invalid input
```

**原因：** `models[]` 条目缺少必填字段 `name`，或 JSON 语法错误（如 `id` 后多余逗号）。

**处理：** 补全 `name`、`reasoning`、`input` 等字段（见第 4 节模板），保存后 `docker compose down && docker compose up -d`。

---

### 6.2 「The configured model is unavailable from the provider」

**日志典型内容：**

```text
Unknown model: bailian/qwen3.8-max
reason=model_not_found
```

**原因：** `model_ref.txt` 前缀（如 `bailian`）与 `openclaw.json` 里 `providers` 键名（如 `domestic`）不一致。

**处理（二选一）：**

1. 改 secret：`model_ref.txt` → `domestic/qwen3.8-max`（与 `providers.domestic` 一致）
2. 或改 json：把 `providers.domestic` 改名为 `providers.bailian`，并保证 `model_ref=bailian/...`

改后重启 Gateway。

---

### 6.3 crash-loop breaker，企微不自动启动

**日志：**

```text
restart-loop breaker tripped: N unclean boot(s)
[wecom] channel autostart suppressed
```

**原因：** 之前多次配置错误导致启动失败，OpenClaw 暂停通道自启。Gateway 已 `Up` 时按 **[OpenClaw Gateway Docker 运维手册.md](OpenClaw Gateway Docker 运维手册.md) 第 11.4 节** 做：官方覆盖是 `gateway call channels.start`，不要 `channels start --channel`，也不必先 `compose restart`。也可等约 5 分钟让同一进程自行拉通道。

只在修好 json 后容器仍 `Restarting` 时才 `compose down && up`。

---

### 6.4 agent 目录下的 models.json 冲突

路径：`~/xa/config/agents/itservicedeskagent/agent/models.json`

若曾通过 Control UI / CLI 写入过 Provider，可能生成**含明文 Key** 的 `models.json`，与 Docker secrets 主配置冲突。

**处理：**

```bash
rm ~/xa/config/agents/itservicedeskagent/agent/models.json
cd ~/xa && docker compose restart
```

之后仅依赖 `openclaw.json` + secrets 注入。

---

### 6.5 账号无模型权限

Gateway 已显示正确 `agent model: domestic/qwen3.8-max`，但调用仍失败。

**处理：**

1. 登录百炼控制台确认该 API Key 已开通目标模型
2. 先用 `qwen-plus` 做连通性测试：

```bash
printf '%s' 'qwen-plus' > ~/xa/secrets/model_id.txt
printf '%s' 'domestic/qwen-plus' > ~/xa/secrets/model_ref.txt
docker compose down && docker compose up -d
```

3. 确认 Key 地域与 Base URL 地域一致

---

### 6.6 其他可忽略日志

| 日志 | 说明 |
| --- | --- |
| `LiteLLM pricing fetch failed (timeout)` | 拉取定价超时，不影响推理 |
| `docker exec ... Missing env var` | exec 子 shell 无 entrypoint 环境变量，看 Gateway 启动日志即可 |

---

### 6.7 企微「你好」也要等十几秒才回

**日志典型形态：**

```text
[model-fetch] start ... model=qwen3.8-max
[model-fetch] response ... status=200 elapsedMs=2151
# 中间空等 8～20 秒，无其他错误
[wecom] [openclaw -> plugin] kind=final
Reply message sent via WebSocket
```

**原因：** 见 **2.4**。自定义 `bailian`/`domestic` Provider 没有把 `thinking=off` 映射成百炼的 `enable_thinking: false`，`qwen3.8-max` 按默认 `xhigh` 先思考再回答。企微通道本身（WebSocket 鉴权、inbound）是正常的。

群聊若再出现 `read failed: ENOENT ... MEMORY.md`，会多一轮模型调用，总耗时再翻倍。

**处理：**

1. 在对应 `models[]` 条目加上 `"compat": { "thinkingFormat": "qwen", "supportsDeveloperRole": false }`，`config validate` 后 restart。
2. 补一个空的或极短的 `~/xa/workspace/MEMORY.md`，避免 Agent 读文件失败后再跑第二轮。
3. 按 **4.2** 重启后再发「你是谁」：`model-fetch` 的 200 到 `kind=final` 应降到大约 2～5 秒，而不是十几秒。
4. 模型变快之后，若仍觉得「发出去没反应」，按 `WeCom 通道插件接入手册.md` **7.4** 打开企微「思考中」占位（须插件 ≥ 2026.7.2）。占位**不会**缩短模型耗时，只是让客户端立刻出现动画。

---

### 6.8 发一张图要多等约 7 秒，日志有 `apply_media_understanding`

**日志典型形态：**

```text
[auto-reply/reply-resolver-timing] ... reply.apply_media_understanding:7214ms ...
# 这段时间内没有 [model-fetch]
```

**原因：** reply 流水线在调用 Agent 之前对 inbound 图做了媒体理解。`tools.media.image.enabled` 未设 `false`，或 catalog `input` 含 `image`（自定义 Provider 会被自动登记为图片理解后端）。xA 规则禁止按图意猜故障，这段产出没有下游消费者。

**处理：** 按 **4.2** 把 `tools.media` 三项都关掉、`input` 收成 `["text"]`、不要设 `imageModel`，然后 restart。再发一张图：`apply_media_understanding` 应消失或只剩几十毫秒。

若 `[model-fetch] start` 仍是 `timeoutMs=undefined`，同节给 Provider 加上 `"timeoutSeconds": 20`。这会封住首包空等 27 秒那种长尾；它覆盖整次 HTTP（含流式正文），所以不要小于约 15 秒，以免裁掉正常的工具调用出参。

---

## 7. 变更模型时的操作清单

只换模型、不换 Provider 名时：

```bash
# 1. 改 secret（示例换成 qwen-plus）
printf '%s' 'qwen-plus' > ~/xa/secrets/model_id.txt
printf '%s' 'domestic/qwen-plus' > ~/xa/secrets/model_ref.txt

# 2. 重启（不必改 openclaw.json，id 仍走 ${XA_DOMESTIC_MODEL_ID}）
cd ~/xa
docker compose down
docker compose up -d

# 3. 验证
docker compose logs xa-gateway | grep "agent model"
```

换 Base URL 或轮换 API Key：只改对应 secret 文件 + `compose down/up`，**不要**改 json 明文。

---

## 8. 配置关系速查图

```text
~/xa/secrets/model_*.txt
        │
        ▼  entrypoint.sh export
环境变量 XA_DOMESTIC_*
        │
        ▼  openclaw.json ${VAR}
models.providers.domestic  +  agents.entries.*.model
        │
        ▼  HTTPS POST
https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
  body: {
    "model": "<model_id.txt 的值>",
    "enable_thinking": false,   ← 必须有；靠 compat.thinkingFormat: "qwen"
    ...
  }
```

`enable_thinking` 缺省时，`qwen3.8-max` 按 **xhigh** 思考。官方 `@openclaw/qwen-provider` 会自动映射；本指南的自定义 `domestic` / `bailian` **不会**，必须写 `compat`。

---

## 9. 相关文档

| 文档 | 用途 |
| --- | --- |
| [OpenClaw Gateway Linux 服务器安装手册.md](OpenClaw Gateway Linux 服务器安装手册.md) 第 12–13 节 | 服务器写入模型并第二次 `up` |
| [OpenClaw Gateway Docker 运维手册.md](OpenClaw Gateway Docker 运维手册.md) | 慢回复日志时间线、crash-loop、升级后回归 |
| [openclaw.json 配置参考.md](openclaw.json 配置参考.md) §10 | `models` 块字段说明 |
| [第三方凭据注入与配置中心演进.md](第三方凭据注入与配置中心演进.md) | 未来 Nacos 迁移变量契约 |
| [WeCom 通道插件接入手册.md](WeCom 通道插件接入手册.md) §7.4 | 企微「思考中」占位（与本节隐藏思考不是同一件事） |
| [OpenClaw Custom providers](https://docs.openclaw.ai/gateway/config-tools#custom-providers-and-base-urls) | 官方 Provider 规范 |
| [OpenClaw Qwen — Thinking controls](https://docs.openclaw.ai/providers/qwen) | `qwen3.8-max` 默认 xhigh；`enable_thinking` 映射 |

---

## 10. 检查清单

| # | 检查项 | 期望 |
| --- | --- | --- |
| 1 | secret 文件 | `model_api_key`、`model_base_url`、`model_id`、`model_ref` 已创建，`chmod 600` |
| 2 | `model_ref` | = `<providers 键名>/` + `model_id`（`domestic/...` 或 `bailian/...`，与启动日志一致） |
| 3 | `openclaw.json` | 对应 Provider 的 `models[]` 含 `name`、`reasoning: false`、`compat.thinkingFormat: "qwen"` |
| 4 | Agent `model` | `"${XA_DOMESTIC_MODEL_REF}"`；建议 `thinkingDefault: "off"` |
| 5 | entrypoint | 已 export 四个 `XA_DOMESTIC_*` 变量 |
| 6 | compose | 已挂载模型相关 secrets |
| 7 | 启动日志 | `agent model: <providers>/<模型id> (thinking=off, ...)`，无 `Unknown model` |
| 8 | 无冲突 | 已删除 agent 下多余的 `models.json`（若存在明文 Key） |
| 9 | `MEMORY.md` | `~/xa/workspace/MEMORY.md` 存在；群聊日志无该路径 `ENOENT` |
| 10 | 首包到终包 | 私聊「你是谁」：`model-fetch` 200 → `kind=final` 约 2～5 秒，而不是 8～20 秒 |
| 11 | 模型超时 | `[model-fetch] start` 含 `timeoutMs=20000`，不再是 `undefined` |
| 12 | 发图不走理解 | 发一张图后无数秒级 `apply_media_understanding`；`input` 仅为 `["text"]` |
| 13 | 回归 | 按本文 **5.5** 验证 `oa_workflow` 工具调用 |
