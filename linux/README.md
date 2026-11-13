# xA OpenClaw（Linux / Docker）

本仓库是 xA IT 服务台在 **Linux 容器**上的完整工程包：Gateway 部署文档、现网配置样例、工作区规则、OA 桥接与身份适配器源码。安装、运维、契约都以本仓库为准，**不依赖** Windows 原生交接包或其它外部文档目录。

本仓库文档只描述 **Linux / Docker** 现网路径。每个主题只在一份正文里写全，其它文档用指针。

## 按角色读

| 你是谁 | 先打开 |
| --- | --- |
| 员工 / 业务 | [xA IT服务台使用说明书.html](xA%20IT服务台使用说明书.html)（浏览器打开：企微怎么报修、确认、取消） |
| 看架构与全链路 | [xA 现网加固与演进全景.md](xA%20现网加固与演进全景.md) |
| 工位第一次安装 | [OpenClaw Gateway WSL2-Docker 安装手册.md](OpenClaw%20Gateway%20WSL2-Docker%20安装手册.md) |
| 服务器第一次安装 | [OpenClaw Gateway Linux 服务器安装手册.md](OpenClaw%20Gateway%20Linux%20服务器安装手册.md) |
| 装完之后的启停 / 备份 / 升级 | [OpenClaw Gateway Docker 运维手册.md](OpenClaw%20Gateway%20Docker%20运维手册.md) |

## 阅读顺序

```text
现网加固与演进全景 ──► 选型 ──► 安装手册（工位 WSL2 / Linux 服务器） ──► 运维手册
              │
              ├── xA IT服务台使用说明书.html（员工 / 业务：企微怎么报修）
              ├── WeCom 通道插件接入手册
              ├── DashScope 兼容 Provider 配置手册
              ├── openclaw.json 配置参考（查字段，不跟步骤）
              ├── 第三方凭据注入与配置中心演进（以后才读）
              │
              └── MySQL 数据库准备 ──► OA Workflow Bridge 接入手册
                                        ├── 企微到OA身份与数据流
                                        ├── 身份适配器说明
                                        ├── Ecology 流程创建 API 说明
                                        ├── 外部系统 Tool 插件设计规范
                                        ├── xA 提示词规则优化说明
                                        ├── xA企微回复模板
                                        └── 工单会话隔离与资料回收场景
```

## 仓库目录

安装时把本仓库拷到目标机，下面的相对路径就是拷贝源。文中 `REPO` 一律指本仓库根目录。

```text
.
├── docker/                          # compose、entrypoint、inbound 清理脚本
│                                    # 现网钉 ghcr.io/openclaw/openclaw:2026.9.2
├── workspace-rules/
│   ├── openclaw.json                # 现网结构样例（路径已是容器内；凭据为 ${VAR}；展示名 qwen3.8 flash）
│   └── workspace/                   # 运行时注入的 AGENTS.md 等（唯一规则源）
└── OA_tool/
    ├── oa-workflow-bridge/          # OA 桥接插件（含身份转换 src/identity/；状态存 MySQL）
    └── *.md                         # OA / 身份专题文档
```

企微通道插件 `wecom-openclaw-plugin` 来自 npm catalog，本仓库不内置源码。安装步骤见 [WeCom 通道插件接入手册.md](WeCom%20通道插件接入手册.md)。

## 文档清单（唯一正文）

每个主题只在「Canonical」列写全，其它文档用指针。变量名与 secret 文件名：工位手册 6.0 与 Linux 服务器手册 6.1 **两边相同**；Provider 键名不可互抄（工位 6.0 用 `domestic/`，Linux 6.1 与现网样例用 `bailian/`）。

| 文档 | 何时读 | Canonical |
| --- | --- | --- |
| [xA IT服务台使用说明书.html](xA%20IT服务台使用说明书.html) | 员工 / 业务：浏览器打开 | 企微怎么报修、确认、取消、补附件 |
| [xA 现网加固与演进全景.md](xA%20现网加固与演进全景.md) | 先看架构 | 架构、部署宿主（§4）、全链路、性能、痛点、演进；**§7 两条人事 HTTP 不要混** |
| [OpenClaw Gateway 部署拓扑与选型.md](OpenClaw%20Gateway%20部署拓扑与选型.md) | 决定要不要第二套 Gateway | Docker vs CLI profile、多套 `~/xa-*`、不要复制同一 Bot（附录 A） |
| `workspace-rules/workspace/AGENTS.md` | 改类型 / 系统关键词 / 回复模板 | 运行时唯一规则源（匹配、未命中兜底、系统表、模板）；系统名 / 处理人 id 另在插件 `systems.json`，`npm test` 校验两边一致 |
| [workspace-rules/xA 提示词规则优化说明.md](workspace-rules/xA%20提示词规则优化说明.md) | 改规则包或 `skipBootstrap` | 为何禁止热路径 `read`、类型白名单、`skipBootstrap` |
| [workspace-rules/xA企微回复模板.md](workspace-rules/xA企微回复模板.md) | 改员工可见一句 | 企微正文全文；改一句必须同步 `AGENTS.md` |
| [OA_tool/工单会话隔离与资料回收场景.md](OA_tool/工单会话隔离与资料回收场景.md) | 验收跨会话 | 同一人全局一张待确认；B 只能确认或取消；附件不串、24h 清资料 |
| [OpenClaw Gateway WSL2-Docker 安装手册.md](OpenClaw%20Gateway%20WSL2-Docker%20安装手册.md) | 工位第一次安装 | WSL2 / dockerd / 第一次 `compose up` |
| [OpenClaw Gateway Linux 服务器安装手册.md](OpenClaw%20Gateway%20Linux%20服务器安装手册.md) | 服务器第一次安装 | SmartX 虚机 / 分次 `compose up` |
| [OpenClaw Gateway Docker 运维手册.md](OpenClaw%20Gateway%20Docker%20运维手册.md) | 装完之后 | 启停、巡检、备份、升级；inbound cron **10.4**；crash-loop **11.4**；OA `unknown` 对账 **12.5** |
| [WeCom 通道插件接入手册.md](WeCom%20通道插件接入手册.md) | 接企业微信 | `channels.wecom` / `sendThinkingMessage`；catalog 钉死见 **第 16 节** |
| [知识库企微机器人部署说明.md](知识库企微机器人部署说明.md) | 第二套 Gateway：知识问答 | 宿主 `18790`、先起服务再装企微 `2026.7.2`、`read` 知识文件、开启「思考中」 |
| [DashScope 兼容 Provider 配置手册.md](DashScope%20兼容%20Provider%20配置手册.md) | 接百炼 | `compat.thinkingFormat` / `MEMORY.md` / 工具调用回归 |
| [MySQL 数据库准备.md](MySQL%20数据库准备.md) | 准备独立 MySQL | 建库、账号授权、网络、备份 |
| [OA_tool/OA Workflow Bridge 接入手册.md](OA_tool/OA%20Workflow%20Bridge%20接入手册.md) | 接 OA 桥接 | 三张表与状态机（**2**）、`systems.json` 与未命中兜底（**3**）、依赖（**4.2**）、compose / entrypoint（**5.3**）、`oa_workflow` 契约与错误码（**7**）、预检与对账（**8**）、从 Redis 切换（**9**） |
| [OA_tool/企微到OA身份与数据流.md](OA_tool/企微到OA身份与数据流.md) | 搞清三种身份 | appid / 调用者 / 申请人、通道加密 userid、`oa_identity` 缓存 |
| [OA_tool/身份适配器说明.md](OA_tool/身份适配器说明.md) | 配身份转换 | `user/get` → 工号 → 人员 id、`oa_identity` 缓存；回执不在 `docker logs` 见 **9** |
| [openclaw.json 配置参考.md](openclaw.json%20配置参考.md) | 查字段 | 字段含义；插件 vs 工具 vs Skill、`alsoAllow`（**5.5 / 11.3**）。现网整份 JSON 以 `workspace-rules/openclaw.json` 为准 |
| [第三方凭据注入与配置中心演进.md](第三方凭据注入与配置中心演进.md) | 以后迁 Nacos | 凭据边界、禁止明文进仓库（**第 0 节**） |
| [外部系统 Tool 插件设计规范.md](外部系统%20Tool%20插件设计规范.md) | 再接其它外部系统 | 通用插件形态；五 action 详表在 OA 手册 §7 |
| [OA_tool/Ecology 流程创建 API 说明.md](OA_tool/Ecology%20流程创建%20API%20说明.md) | 对 Ecology HTTP | 上游接口；两条人事 HTTP 细节在第四步 |
