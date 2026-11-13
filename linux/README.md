# xA OpenClaw（Linux / Docker）

xA IT 服务台「小A」的完整工程包：员工在企业微信报修，模型整理成工单，员工确认后由 OA 桥接插件提交到泛微 Ecology 流程 602。包含部署文档、现网配置样例、工作区规则和插件源码。每个主题只在一份文档里写全，其它地方用链接。

## 按角色读

| 你是谁 | 先看 |
| --- | --- |
| 员工 / 业务 | [xA IT服务台使用说明书.html](xA%20IT服务台使用说明书.html)（同内容 Word 版 `小A使用说明书.docx`） |
| 想了解整体 | [xA 现网加固与演进全景.md](xA%20现网加固与演进全景.md) |
| 第一次装服务器 | [OpenClaw Gateway Linux 服务器安装手册.md](OpenClaw%20Gateway%20Linux%20服务器安装手册.md) |
| 日常运维 / 排障 | [OpenClaw Gateway Docker 运维手册.md](OpenClaw%20Gateway%20Docker%20运维手册.md) |
| 改业务规则 | [workspace-rules/xA 提示词规则优化说明.md](workspace-rules/xA%20提示词规则优化说明.md) |

## 文档清单

| 文档 | 写全了什么 |
| --- | --- |
| [xA 现网加固与演进全景.md](xA%20现网加固与演进全景.md) | 架构、关键决策、全链路时序、性能、痛点、扩容与多业务、配置中心演进、接新外部系统的原则、凭据边界 |
| [OpenClaw Gateway Linux 服务器安装手册.md](OpenClaw%20Gateway%20Linux%20服务器安装手册.md) | Docker、MySQL 建库、12 个 secrets、构建镜像、配置、启动、接企微、验收、常见问题 |
| [OpenClaw Gateway Docker 运维手册.md](OpenClaw%20Gateway%20Docker%20运维手册.md) | 启停与生效方式、健康检查、日志、巡检、备份恢复、密钥轮换与升级、inbound cron、崩溃熔断、排障速查、OA `unknown` 对账 |
| [openclaw.json 配置参考.md](openclaw.json%20配置参考.md) | 现网每个字段为什么这样写；插件 / 工具 / Skill 三层门控 |
| [DashScope 兼容 Provider 配置手册.md](DashScope%20兼容%20Provider%20配置手册.md) | 百炼命名规则、必填字段、慢回复排查、换模型 |
| [WeCom 通道插件接入手册.md](WeCom%20通道插件接入手册.md) | 通道配置、「思考中」、catalog 钉版与升级、排障 |
| [知识库企微机器人部署说明.md](知识库企微机器人部署说明.md) | 第二套 Gateway：知识问答机器人（端口 18790） |
| [OA_tool/OA Workflow Bridge 接入手册.md](OA_tool/OA%20Workflow%20Bridge%20接入手册.md) | 插件代码结构、三张表与状态机、`systems.json`、`oa_workflow` 契约与错误码、预检 / 统计 / 对账脚本 |
| [OA_tool/企微到OA身份.md](OA_tool/企微到OA身份.md) | 四种身份、加密 userid → 工号 → 人员 id、`oa_identity` 缓存、身份排障 |
| [OA_tool/Ecology 流程创建 API 说明.md](OA_tool/Ecology%20流程创建%20API%20说明.md) | Ecology 接口、建单字段、两条人事接口 |
| `workspace-rules/workspace/AGENTS.md` | 运行时唯一规则源：决策树、口令、匹配、系统表、追问短句 |

## 仓库目录

```text
.
├── docker/                    Dockerfile（自建镜像 xa-gateway-oa）、compose、entrypoint、inbound 清理脚本
├── workspace-rules/
│   ├── openclaw.json          现网配置样例（容器路径，凭据全是 ${VAR}）
│   └── workspace/             注入给 Agent 的规则文件
└── OA_tool/
    ├── oa-workflow-bridge/    OA 桥接插件（含身份转换 src/identity/、systems.json、scripts/、tests/）
    └── *.md                   OA 与身份文档
```

企微通道插件 `@wecom/wecom-openclaw-plugin` 从 npm 安装，本仓库不含源码。

改系统名或处理人时，`systems.json` 与 `AGENTS.md` 的系统表要一起改，`cd OA_tool/oa-workflow-bridge && npm test` 会校验两边一致。员工看到的卡片文字在插件 `src/reply.mjs`。
