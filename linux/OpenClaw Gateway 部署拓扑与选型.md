# OpenClaw Gateway 部署拓扑与选型

> 本文档由仓库根目录原文档**重组**而来：只调整章节归属与交叉引用，**不改变**部署步骤、命令、YAML、错误码或禁止事项。阅读顺序见 [README.md](README.md)。

适用对象：在 xA 项目中需要理解 **Docker Compose 部署**、**OpenClaw 官方 Docker 流程** 与 **`openclaw --profile` 多实例隔离** 之间区别，并做出选型决策的运维与开发人员。

本文档是对两份安装手册（工位 WSL2 / Linux 服务器）的补充说明，不替代其操作步骤。

---

## 1. 先澄清三个容易混淆的概念

| 概念 | 是什么 | 典型用法 |
| --- | --- | --- |
| **Docker Compose 部署** | 用容器跑 Gateway，配置/数据通过 volume 挂载 | `docker compose up -d` |
| **`openclaw --profile <name>`** | OpenClaw CLI 的多实例隔离机制，每套实例有独立 config/state/workspace | `openclaw --profile ops gateway --port 19789` |
| **`tools.profile`** | Agent 工具权限模板（如 `minimal`） | `openclaw.json` 里的 `tools.profile` |

后两者名字都带 “profile”，但**完全无关**。本文讨论的「profile 环境」指第二种（CLI 多实例隔离），不是工具权限模板。

---

## 2. 当前 xA 项目用的是什么？

**结论：Docker Compose + 独立宿主机目录（`~/xa`），容器内不使用 `openclaw --profile`。**

### 2.1 实际架构

```text
WSL2 Ubuntu 宿主机
└── ~/xa/                          ← 一套业务的全部持久化数据
    ├── docker-compose.yml
    ├── config/                      → 容器 /home/node/.openclaw
    ├── workspace/                   → 容器 /home/node/.openclaw/workspace
    ├── extensions/                  → 容器 /home/node/.openclaw/extensions
    ├── secrets/                     → 容器 /run/secrets/
    └── entrypoint.sh                → 读 secrets，启动 gateway
```

容器入口直接启动 Gateway，**不带 `--profile` 参数**：

```sh
exec node dist/index.js gateway --bind lan --port 18789
```

### 2.2 与原生 Windows profile 的对应关系

| 原生 Windows（DPAPI 路径） | 当前 Docker 路径 |
| --- | --- |
| `C:\OpenClaw\profiles\xa-it-service\...` | `~/xa/config`、`~/xa/extensions` 等 |
| 一个 profile = 一套 Gateway | 一个 compose 栈 = 一套 Gateway |
| 密钥经 PowerShell + DPAPI | 密钥经 Compose secrets + entrypoint |

在**业务语义**上，当前 `~/xa` 部署等价于原生 Windows 上的 **`xa-it-service` 那一套 profile 环境**；实现机制不同，隔离目标相同。

---

## 3. OpenClaw 官方文档里的两条路径

官方文档中，Docker 与 `--profile` 是**两个不同维度**的能力，并非「必须先 Docker 再 `--profile`」的固定顺序。

### 3.1 官方 Docker 路径（默认单 Gateway）

参考：[OpenClaw Docker 安装文档](https://docs.openclaw.ai/install/docker)

典型流程：

```bash
# 官方通用示例；xA 现网以仓库 docker/docker-compose.yml 为准（ghcr.io/openclaw/openclaw:2026.9.2）
export OPENCLAW_IMAGE="openclaw/openclaw:latest"
./scripts/docker/setup.sh
# 或：docker compose up -d openclaw-gateway
```

特点：

- **一个 compose 栈 = 一个 Gateway**，默认不需要 `--profile`
- 状态通过挂载目录持久化（`OPENCLAW_CONFIG_DIR`、`OPENCLAW_WORKSPACE_DIR` 等）
- 密钥可通过 `.env`、SecretRef 或环境变量注入
- 提供 `openclaw-cli` 侧车容器执行 CLI 命令

### 3.2 官方 `--profile` 路径（同机多 Gateway）

参考：[Multiple gateways](https://docs.openclaw.ai/gateway/multiple-gateways)

典型流程（原生安装，非 Docker）：

```bash
# 主实例（默认 profile）
openclaw setup
openclaw gateway --port 18789

# 第二个实例
openclaw --profile ops onboard
openclaw --profile ops gateway install --port 19789
```

`--profile ops` 会自动隔离：

| 隔离项 | 默认 profile | `--profile ops` |
| --- | --- | --- |
| 状态目录 | `~/.openclaw` | `~/.openclaw-ops` |
| 配置文件 | `~/.openclaw/openclaw.json` | 独立 config 路径 |
| Workspace | 默认 workspace | 如 `~/.openclaw/workspace-ops` |
| Gateway 端口 | 18789 | 需另选（建议相差 ≥20） |
| 系统服务名 | `openclaw-gateway` | `openclaw-gateway-ops` |

每套实例必须保持 **config、state、workspace、port** 全部唯一，否则会产生冲突。

### 3.3 官方是否要求「先 Docker 再 profile」？

**否。** 常见组合如下：

| 场景 | 推荐做法 |
| --- | --- |
| 只要一个 Gateway | Docker **或** 原生安装均可，通常不用 `--profile` |
| 同机多个 Gateway（原生） | `openclaw --profile <name>` + 不同端口 |
| 同机多个 Gateway（Docker） | **多套 compose 栈** 或 **多容器 + 不同 volume** |
| Docker 容器内切多个 profile | 理论可行，**一般不推荐**（见下文） |

---

## 4. 三种方式对比

```text
┌─────────────────────────────────────────────────────────┐
│  运行时隔离层                                            │
│  ┌──────────────┐    ┌──────────────────────────────┐   │
│  │ Docker 容器   │    │ 原生进程 / systemd / 计划任务  │   │
│  └──────┬───────┘    └──────────────┬───────────────┘   │
│         │                           │                    │
│  ┌──────▼───────────────────────────▼───────────────┐   │
│  │  OpenClaw 逻辑隔离层                              │   │
│  │  默认 ~/.openclaw  或  --profile → ~/.openclaw-X │   │
│  └──────┬───────────────────────────────────────────┘   │
│         │                                                │
│  ┌──────▼───────────────────────────────────────────┐   │
│  │  业务实例：xA IT 服务台 / HR 机器人 / 测试环境   │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

| 维度 | A. 当前项目（Compose + `~/xa`） | B. 官方 Docker（setup.sh） | C. 原生 `openclaw --profile` |
| --- | --- | --- | --- |
| **隔离方式** | 容器边界 + 宿主机目录 | 容器边界 + 挂载目录 | 进程级 + `~/.openclaw-<name>/` |
| **是否用 `--profile`** | 否 | 默认否 | 是（多实例时） |
| **密钥管理** | Compose secrets → entrypoint | `.env` / SecretRef | Windows DPAPI 或 env |
| **配置路径** | `~/xa/config` → `/home/node/.openclaw` | `OPENCLAW_CONFIG_DIR` 挂载 | profile 自动分配路径 |
| **CLI 管理** | `docker compose exec` / `compose run` | `docker compose run openclaw-cli ...` | 直接 `openclaw --profile ...` |
| **扩第二套业务** | 复制 compose 到新目录 | 同上 | `openclaw --profile hr gateway --port 18790` |
| **与 xA 指南关系** | **主路径** | 官方通用流程 | 已归档的 Windows 原生路径 |
| **第三方参数** | Docker secrets + `${VAR}`，见安装手册第 6 节；未来 Nacos 见 `第三方凭据注入与配置中心演进.md` | 依官方 onboard | DPAPI |

---

## 5. 按场景怎么选？

### 5.1 只跑一套 xA（当前状态）

**推荐：A（Compose + `~/xa`）**

- 与 `OpenClaw Gateway WSL2-Docker 安装手册.md` 完全一致
- secrets、entrypoint、企微插件流程已验证
- 一个容器、一个目录、一个端口，运维最简单

### 5.2 再加一套业务（HR、行政、测试环境）

**推荐：继续 A——复制 compose + 新目录**

```text
~/xa/          生产或试点 IT 服务台，宿主端口 18789
~/xa-hr/       另一业务，宿主端口 18790
~/xa-staging/  测试环境，宿主端口 18791
```

每套必须全部换新：

1. 新目录（不共用 `config`、`workspace`、`secrets`）
2. 新 `container_name`、新宿主端口映射
3. 新企微机器人、新 Gateway token
4. 新 `openclaw.json`（agent id、bindings 等按业务改）

这与原生 `--profile` 的隔离目标相同，只是用 **Docker 目录** 代替 **`~/.openclaw-<name>`**。

> **企微约束：** 同一 BotId/BotSecret 只能由一个 Gateway 持有。复制相同 xA 再起第二个容器不会变成负载均衡，而会抢连接、重复回复。

复制 compose 的完整 YAML、目录与端口示例见本文 **附录 A**（由原安装手册 §14 迁入，步骤未改）。

### 5.3 同一 Gateway 内多个 Agent（不同路由）

**推荐：一个 Gateway + 多个 agent + bindings，不复制容器，也不用 `--profile`**

官方推荐在同一 Gateway 内通过 `agents add` 和 `bindings` 路由。当前 WeCom 插件为单账号模式，多账号能力验证通过前，不要把多个业务硬塞进一个容器。

### 5.4 开发 / 调试 OpenClaw 本身

**推荐：B 或 C（原生 `--profile` / `--dev`）**

本机快速起 rescue bot、第二网关时，CLI 体验更好：

```bash
openclaw --profile rescue onboard
openclaw --profile rescue gateway --port 19789
```

可与生产 Docker 部署并存，不必二选一。

### 5.5 上公司级生产

**推荐：A 的升级版**

- SmartX 超融合上的 Linux 虚机跑 Docker，不依赖员工 PC。操作步骤见 **[OpenClaw Gateway Linux 服务器安装手册.md](OpenClaw Gateway Linux 服务器安装手册.md)**；宿主边界见 [xA 现网加固与演进全景.md](xA%20现网加固与演进全景.md) 第 4 节
- 密钥进企业 Vault，不散落在各人 `~/xa/secrets`
- OA 桥接插件依赖与 WSL 相同：用官方镜像装一次（见 `OA_tool/OA Workflow Bridge 接入手册.md` 第 4.2 节）；不要在服务器装 Node，也不要写进 compose / entrypoint
- 高可用用**主备**（同一 Bot 同一时刻只连一个 Gateway），不要多活抢同一机器人

### 5.6 Docker 容器内使用 `--profile`（不推荐）

在一个容器里用 `--profile` 跑多个 Gateway 进程：

- 违背「一个容器一个主进程」的运维惯例
- entrypoint、健康检查、日志都变复杂
- 与官方 Docker 默认模型不一致
- 对 xA 场景没有明显收益

**若确需多 Gateway，应复制 compose 栈，而不是在一个容器内切 profile。**

---

## 6. 一句话选型表

| 你的需求 | 推荐方式 |
| --- | --- |
| 继续维护现有 xA Docker 部署 | **A：Compose + `~/xa`** |
| 再加一个机器人 / 业务线 | **A：复制 compose 目录 + 新端口 + 新密钥** |
| 同一企微通道内多 Agent 路由 | **单 Gateway + bindings**（验证插件多账号后） |
| 本机玩 OpenClaw、rescue bot | **C：原生 `--profile`** |
| 一个容器里切多个 Gateway | **不推荐** |

**对 xA 当前项目：A 最好。** `--profile` 更适合「同一台机器、原生安装、CLI 管多网关」；你们已用 Docker 做了更强的隔离，用目录复制扩展即可。

---

## 7. 常见问题

### Q1：能不能在现有容器里改成 `openclaw --profile xa-it-service`？

可以技术上设置 `OPENCLAW_STATE_DIR` 等环境变量，但**没有必要**。当前 `~/xa/config` 挂载到 `/home/node/.openclaw` 已经实现了等效隔离；再加 profile 只会增加路径复杂度，与现有 entrypoint、文档不一致。

### Q2：官方 Docker 的 setup.sh 和当前项目的 compose 有什么区别？

| 项 | 官方 setup.sh | 当前 xA compose |
| --- | --- | --- |
| 初始化 | 自动 onboard + 生成 token | 手动准备 secrets + 改 openclaw.json |
| 密钥 | `.env` 为主 | Compose secrets 文件 |
| CLI | 提供 `openclaw-cli` 侧车 | `docker compose exec` 或 `compose run` |
| 定制 | 通用 OpenClaw | 针对 xA、企微、国内模型预置 |

两者都是「Docker + 单 Gateway」，核心模型一致；xA 指南在密钥与业务配置上做了企业化定制。

### Q3：`tools.profile: minimal` 和 `--profile` 有关系吗？

**没有。** `tools.profile` 控制 Agent 可用工具集（如是否允许 `wecom_mcp`），是 `openclaw.json` 里的配置项；`--profile` 是 CLI 全局 flag，用于多 Gateway 实例隔离。详见 `WeCom 通道插件接入手册.md` 中 tools 相关章节。

### Q4：扩容量时复制 compose 还是加 profile？

| 目标 | 做法 |
| --- | --- |
| 同一 IT 服务台，用户量变多 | **不要**复制；加 CPU/内存、提高模型 API 配额 |
| 另一个机器人 / 另一套业务 | **复制 compose**（新目录 + 新端口 + 新 Bot） |
| 生产与测试隔离 | **复制 compose**（测试用独立 Bot 和 secrets） |
| 同机 rescue / ops 网关（原生） | **`--profile rescue`** |

---

## 附录 A：多套 Compose 操作细则

先分清要扩的是**另一套业务**，还是**同一个 xA 的用户量**。不要默认「复制一份 compose 再起一个容器」。

OpenClaw 里 **一个 Gateway 进程 = 一套独立环境**（对应原生 Windows 上的一个 profile）。企业微信插件当前是**单账号模式**：同一套 BotId/BotSecret 只能由**一个** Gateway 持有。复制完全相同的 xA 再起第二个容器，不会变成负载均衡，而会抢连接、重复回复、打乱会话和工单幂等。

### A.1 怎么选

| 目标 | 要不要再起一个容器 | 做法 |
| --- | --- | --- |
| 同一个 IT 服务台，人变多、消息变多 | **不要**再起一个相同 Bot 的容器 | 加大这一套的 CPU/内存；提高模型 API 并发与配额 |
| 再做一个业务（HR、行政、另一事业部机器人） | **要**再起一套独立 Gateway | 新目录 + 新 compose + 新端口 + 新密钥 + 新 workspace |
| 同一套企微里，不同账号走不同 Agent | **通常不起**第二个容器 | **一个** Gateway 里增加 agent 和 `bindings`（须先验证企微插件支持多账号） |
| 生产和测试隔离 | **要**两套 | 另一套目录/端口/测试机器人；禁止共用生产密钥和智能表格 |
| 机器故障要有备份 | **不是**同时跑两个主实例 | 主备（同一时刻只有一个连该企微 Bot），或整机备份后切换 |

### A.2 同一业务变忙：只扩这一套，不要复制

一条企微消息只会进入**连着这个 Bot 的那一个** Gateway。正确方向：

- 给运行 WSL/Docker 的机器加 CPU、内存、磁盘；
- 在模型侧提高配额、超时和并发，而不是再拉起一个 `xa-gateway`；
- 日志与 `~/xa` 磁盘留够空间，避免把工作区放在 `/mnt/c`。

不要：同一套 `~/xa`、同一套企微 Bot、只改 `container_name` 再 `up` 一次。

### A.3 多业务 / 多机器人：复制 compose，但必须当成新环境

这才是「复制 docker-compose、改参数、再起一个容器」的合法场景。每套对应一个独立 Gateway，和原生部署里「一个 profile 一个端口」相同。

每套必须全部换新，不能只改容器名：

1. **新目录**，例如 `~/xa-hr/`，不要与 `~/xa` 共用 `config`、`workspace`、`secrets`。
2. **新 compose**：`container_name`（如 `xa-hr-gateway`）、宿主端口（如 `"18790:18789"`）、volume 用该目录下的相对路径。
3. **新密钥**：另一套 `secrets/`（含阶段 B 的 5 个模型 secret）、另一个企微机器人、另一个 Gateway token。
4. **新 `openclaw.json`**：Agent id、workspace、bindings、插件路径按新业务改；容器内路径仍写 `/home/node/.openclaw/...`。
5. 在**各自目录**执行 `docker compose up -d`。端口和数据目录都不同时，两个容器可以同时跑。

示例（第二套，在 `~/xa-hr` 下；容器内端口仍是 18789，只改宿主映射和容器名）。生产完整 secrets / TZ / logging / 镜像钉见仓库 `docker/docker-compose.yml`（`ghcr.io/openclaw/openclaw:2026.9.2`）；下面只示范「换目录、换端口、换容器名」：

```yaml
services:
  xa-gateway:
    image: openclaw/openclaw:latest
    container_name: xa-hr-gateway
    user: "1000:1000"
    restart: unless-stopped
    environment:
      HOME: /home/node
      OPENCLAW_GATEWAY_BIND: lan
    secrets:
      - gateway_token
      - wecom_bot_id
      - wecom_bot_secret
    volumes:
      - ./config:/home/node/.openclaw
      - ./workspace:/home/node/.openclaw/workspace
      - ./extensions:/home/node/.openclaw/extensions
      - ./entrypoint.sh:/entrypoint.sh:ro
    ports:
      - "18790:18789"
    init: true
    entrypoint: ["/bin/sh", "/entrypoint.sh"]

secrets:
  gateway_token:
    file: ./secrets/gateway_token.txt
  wecom_bot_id:
    file: ./secrets/wecom_bot_id.txt
  wecom_bot_secret:
    file: ./secrets/wecom_bot_secret.txt
```

Dashboard：`http://localhost:18790/`，token 用 `cat ~/xa-hr/secrets/gateway_token.txt`。

目录建议：

```text
~/xa/          生产或试点：IT 服务台，宿主 18789
~/xa-hr/       另一业务，宿主 18790
~/xa-staging/  测试，另一套测试机器人，宿主 18791
```

### A.4 一个 Gateway 里多个 Agent（不是横向复制容器）

若只是「同一通道、不同账号或不同路由规则走不同 Agent」，官方推荐：**一个 Gateway + 多个 agent + bindings**，不必再起容器。

当前 WeCom 插件表现为单账号。未完成多账号、绑定和消息路由验证之前，**不要把多个业务塞进一个容器**。验证通过后再在**同一份** `openclaw.json` 里 `agents add` / `bind`，而不是复制 compose。

### A.5 再往上（公司生产）

一台员工电脑上的 WSL 跑多个 compose，只适合试点或小团队。上公司级时优先：

- 用 SmartX 超融合上的 Linux 虚机跑 Docker，不要依赖某台办公 PC 的 WSL；不要在 SmartX 控制台或宿主机节点上装 Gateway；
- 密钥用企业 Vault 或编排器 secret，不要把生产密钥散落在各人 `~/xa/secrets`；
- OA 插件 `node_modules` 用官方镜像在部署时装一次（与 WSL 相同，见 OA 桥接接入手册 4.2），不要在服务器装 Node；
- 企微按插件要求单独做回调或出网，不要和「再复制一个容器」绑在一起；
- 高可用用**主备**（同一 Bot 同一时刻只连一个 Gateway），不要多活抢同一个机器人。

### A.6 一句话

扩「另一个机器人 / 另一套业务」→ 复制 compose，**并**换目录、端口、密钥、配置，再起新容器。  
扩「同一个 xA 的用户量」→ **不要**复制，只扩这一套的机器和模型。  
扩「同一网关里多个 Agent」→ 先确认企微插件多账号可用，再在**同一个**容器的 json 里加 agent 和 binding。

> 本附录由原安装手册 §14 全文迁入。原文小节误标为 13.1–13.6，此处改为 A.1–A.6；表格、YAML 与禁止「复制同一 Bot」的结论均未改。

## 8. 相关文档

| 文档 | 内容 |
| --- | --- |
| `xA 现网加固与演进全景.md` | OA 主路径、切入范围、各层 I/O |
| `OpenClaw Gateway WSL2-Docker 安装手册.md` | 工位 WSL2 + Docker 全链路部署 |
| `OpenClaw Gateway Linux 服务器安装手册.md` | 内网 Linux 服务器 / VM 安装（独立完整路径） |
| `OpenClaw Gateway Docker 运维手册.md` | 启停、巡检、备份、升级回滚、三层排障 |
| `WeCom 通道插件接入手册.md` | 企微插件配置与排错 |
| [OpenClaw Docker 安装](https://docs.openclaw.ai/install/docker) | 官方 Docker 流程 |
| [Multiple gateways](https://docs.openclaw.ai/gateway/multiple-gateways) | 官方 `--profile` 多实例说明 |
| [OpenClaw CLI](https://docs.openclaw.ai/cli/) | `--profile`、`--dev` 等全局 flag |
