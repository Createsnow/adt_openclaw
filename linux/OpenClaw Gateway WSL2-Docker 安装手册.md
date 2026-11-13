# OpenClaw Gateway WSL2-Docker 安装手册

> 本文档由仓库根目录原文档**重组**而来：只调整章节归属与交叉引用，**不改变**部署步骤、命令、YAML、错误码或禁止事项。阅读顺序见 [README.md](README.md)。

适用对象：在 Windows 上用 **WSL2 Ubuntu** 安装 **Docker Engine**（不用 Docker Desktop），把 xA OpenClaw Gateway 跑在 Linux 容器里。

本指南与原生 Windows + DPAPI 部署是**另一条路径**。容器里没有 DPAPI；**所有第三方凭据与请求参数**（Gateway Token、企微 Bot、模型 API Key、`baseUrl` 等）均通过 **Docker Compose secrets**（文件挂到 `/run/secrets/`），由入口脚本 `export` 为环境变量，`openclaw.json` 中只写 `${VAR}` 占位符，**不写明文**。

未来若接入 Nacos 等配置中心，见 **[第三方凭据注入与配置中心演进.md](第三方凭据注入与配置中心演进.md)**（变量名契约保持不变，只换「谁赋值」）。

默认约定：

| 项 | 值 |
| --- | --- |
| 发行版 | Ubuntu-24.04（WSL2） |
| 安装位置示例 | `E:\WSL\Ubuntu-24.04` |
| 宿主机工作目录 | `~/xa`（必须在 Linux 家目录，不要放 `/mnt/c` 等） |
| 容器内用户 | `node`，uid `1000`，家目录 `/home/node` |
| 镜像 | 默认 compose 为 `openclaw/openclaw:latest`（Docker Hub，可走国内加速）。方案 A 实际拉取的是 `ghcr.io/openclaw/openclaw:latest`，**须 `docker tag` 对齐**；若 yml 改成 ghcr 名或不 tag，本机不会有 `openclaw/openclaw`，装依赖用 OA Redis 接入手册 4.2 的「GHCR 名」整段，不要补拉 Docker Hub |
| 网关端口 | 宿主 `18789` → 容器 `18789` |
| OA | 保持停用，不要改 `active=true` |

文中 `YOUR_LINUX_USER` 换成你的 Ubuntu 用户名（例如 `lijinjin`）。`REPO` 换成本仓库在 WSL 里的路径，例如 `/mnt/f/workspace/ADK-OFFICE/openclaw/linux`。

---

## 路径对照（先看懂再改配置）

这是两套路径，不要混用。

| 谁看到 | 路径 | 写在哪里 |
| --- | --- | --- |
| WSL 宿主机 | `/home/YOUR_LINUX_USER/xa/config` 等 | **只写在** `docker-compose.yml` 的 `volumes:` **左边** |
| 容器里的 OpenClaw | `/home/node/.openclaw/...` | **写在** `openclaw.json` 里 |

挂载关系：

```text
宿主机 ~/xa/config        →  容器 /home/node/.openclaw
宿主机 ~/xa/workspace     →  容器 /home/node/.openclaw/workspace
宿主机 ~/xa/extensions    →  容器 /home/node/.openclaw/extensions
宿主机 ~/xa/entrypoint.sh →  容器 /entrypoint.sh（只读）
宿主机 ~/xa/secrets/*.txt →  容器 /run/secrets/<名字>
```

因此：

- `openclaw.json` **必须**写 `/home/node/.openclaw/...`，不要写 `/home/YOUR_LINUX_USER/...`。
- 宿主机 **不必**创建名为 `node` 的 Linux 用户；`sudo chown -R 1000:1000 ~/xa` 只是让 uid 1000 能读写挂载目录。

---

## 1. Windows：安装 WSL2 与 Ubuntu

用**管理员 PowerShell**。

### 1.1 更新 WSL

```powershell
wsl --update
wsl --version
```

### 1.2 启用 Windows 功能

```powershell
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

**必须重启 Windows**，然后再继续。

### 1.3 安装发行版（目录与 `--location` 必须一致）

```powershell
mkdir E:\WSL\Ubuntu-24.04
wsl --install Ubuntu-24.04 --location E:\WSL\Ubuntu-24.04 --web-download
```

按提示设置 Ubuntu 用户名和密码。确认是 WSL2：

```powershell
wsl -l -v
```

应看到 `Ubuntu-24.04`，VERSION 为 `2`。

---

## 2. Ubuntu：安装 Docker Engine 与 Compose（不用 Desktop）

打开 Ubuntu 终端，执行：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```

**关掉 Ubuntu 窗口再开一次**（docker 组才生效）。然后：

```bash
docker version
docker compose version
```

两条都有版本号即可。若 `docker` 仍要 `sudo`，在 Windows PowerShell 执行 `wsl --shutdown` 后重进 Ubuntu。

---

## 3. systemd、Docker 开机自启、国内镜像加速

### 3.1 开启 systemd

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

在 **Windows PowerShell**：

```powershell
wsl --shutdown
```

再打开 Ubuntu，确认 PID 1 是 systemd：

```bash
ps -p 1 -o comm=
```

应输出 `systemd`。然后：

```bash
sudo systemctl enable --now docker
```

### 3.2 国内镜像加速

`registry-mirrors` **只加速 Docker Hub（docker.io）**，不加速 `ghcr.io`。本指南因此使用 `openclaw/openclaw:latest`。

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "registry-mirrors": ["https://docker.xuanyuan.me"]
}
EOF
sudo systemctl restart docker
```

免费加速源可能失效，以当时能用的源为准；有代理也可给 dockerd 配 `HTTP_PROXY`/`HTTPS_PROXY`。

### 3.3 验证 Docker

```bash
docker info | grep -A2 "Registry Mirrors"
docker run --rm hello-world
```

看到 `Hello from Docker!` 再往下做。不要再单独起一套「空白 OpenClaw」；后面只部署 xA。

---

## 4. 准备 `~/xa` 目录并拷本仓库

必须把运行目录放在 Linux 家目录，不要放 `/mnt/c`、`/mnt/e`、`/mnt/f`（权限差、文件监听慢）。本仓库可以放在 `/mnt/f/...`，只作拷贝源。

```bash
mkdir -p ~/xa/{config,workspace,extensions,secrets}

REPO=/mnt/f/workspace/ADK-OFFICE/openclaw/linux

cp -r "$REPO/workspace-rules/workspace/." ~/xa/workspace/
# OA 桥接（身份转换已在插件内；状态存独立 MySQL）
cp -r "$REPO/OA_tool/oa-workflow-bridge" ~/xa/extensions/
rm -rf ~/xa/extensions/oa-workflow-bridge/node_modules
# Docker 路径：用官方镜像装依赖，宿主不必有 npm。约定见 OA 桥接接入手册 4.2。
# 下面镜像名须与本机 docker images、以及随后 compose 的 image: 一致。
# 若 docker images 没有 openclaw/openclaw、只有 ghcr.io/openclaw/openclaw：把最后一行镜像换成那一串，或按第 7 节方案 A 先 tag。
sudo chown -R 1000:1000 ~/xa/extensions
docker run --rm --user 1000:1000 \
  -e HOME=/tmp \
  -e NPM_CONFIG_CACHE=/tmp/npm-cache \
  -v "$HOME/xa/extensions/oa-workflow-bridge:/app" \
  -w /app \
  openclaw/openclaw:latest \
  npm install --omit=dev
cp "$REPO/workspace-rules/openclaw.json" ~/xa/config/openclaw.json
```

OA 插件的状态存在独立 MySQL，按 **`MySQL 数据库准备.md`** 准备库和账号，并在 `~/xa/extensions/oa-workflow-bridge/bridge-config.json` 的 `mysql` 段填主机 / 账号 / 库名（密码走 secret `oa_mysql_password.txt`）。第 4 节 `docker run` 的镜像名必须与本机已有镜像一致。

若 `docker images` **没有** `openclaw/openclaw`（`compose ps` 的 IMAGE 已是 `ghcr.io/openclaw/openclaw:latest`），不要跑上面默认的 Hub 名，也不要为此再拉 Docker Hub。把上面命令最后一行镜像换成 `ghcr.io/openclaw/openclaw:latest` 即可（见 **`OA_tool/OA Workflow Bridge 接入手册.md` 第 4.2 节**）；或按第 7 节方案 A 先 `docker tag` 再跑上面默认块。

企微插件 `wecom-openclaw-plugin` **不在本仓库**（来自 npm catalog）。本机若已有，拷到：

```bash
cp -r /path/to/wecom-openclaw-plugin ~/xa/extensions/wecom-openclaw-plugin
```

**没有该插件时，json 里不能再引用它。** 若 `plugins.load.paths` 仍指向 `wecom-openclaw-plugin`，或仍有 `channels.wecom`，网关会拒绝启动（`plugin path not found` / `unknown channel id: wecom`）。先按 5.5 临时去掉企微，网关才能起来；拿到插件后再拷进去并恢复配置。

对齐容器用户 uid：

```bash
sudo chown -R 1000:1000 ~/xa
```

核对：

```bash
ls -la ~/xa/config ~/xa/workspace ~/xa/extensions
test -f ~/xa/workspace/MEMORY.md || printf '%s\n' '# MEMORY' > ~/xa/workspace/MEMORY.md
sudo chown 1000:1000 ~/xa/workspace/MEMORY.md
```

根目录必须有 `MEMORY.md`，否则群聊寒暄时 Agent 会 `read` 失败再跑第二轮模型。详见 `DashScope 兼容 Provider 配置手册.md` §2.5。

---

## 5. 改 `openclaw.json`（启动前必改；其余用 OpenClaw 命令）

本仓库 `openclaw/openclaw.json` 已是容器路径 + `${VAR}` 占位符。**第 5 步只改「不改就起不来」的项**（没有企微插件时去掉 wecom）。企微插件与通道等网关 `Up` 之后按 **`WeCom 通道插件接入手册.md`** 配置；国内模型见 `DashScope 兼容 Provider 配置手册.md`。不要在崩溃循环里跑向导。

编辑 `~/xa/config/openclaw.json`。

### 5.0 合法 `meta` vs 旧 Windows 模板

本仓库样例里的 `meta.lastTouchedVersion` / `migrations` 是 OpenClaw 运行时字段，**保留**。

若误把旧 Windows 模板拷进来，顶层若还有 `handoffTemplate`、`sourceSnapshotDate`、`notes`，会报 `meta: Invalid input`，容器进入 Restarting。**只删这些非法键**，不要把整段合法 `meta` 清掉。

### 5.1 路径改成容器内路径

本仓库 `openclaw/openclaw.json` 已经是容器路径。仅当 json 里仍出现 `C:\` 时才改：

| 模板中的 Windows 路径 | 改为 |
| --- | --- |
| `C:\\OpenClaw\\workspace-ITServiceDeskAgent` | `/home/node/.openclaw/workspace` |
| `C:\\OpenClaw\\profiles\\xa-it-service\\agents\\itservicedeskagent\\agent` | `/home/node/.openclaw/agents/itservicedeskagent/agent` |
| `C:\\OpenClaw\\profiles\\xa-it-service\\extensions\\wecom-openclaw-plugin` | `/home/node/.openclaw/extensions/wecom-openclaw-plugin` |
| `C:\\OpenClaw\\profiles\\xa-it-service\\extensions\\oa-workflow-bridge` | `/home/node/.openclaw/extensions/oa-workflow-bridge` |

### 5.2 删除 DPAPI / PowerShell 密钥提供方

删除整个 `secrets.providers.enterprise-secrets` 段（`command` 指向 `powershell.exe` 和 `Resolve-OpenClawSecrets.ps1`）。容器里没有 DPAPI。

### 5.3 企微凭据保持环境变量占位符

不要改成明文。保持：

```json
"botId": "${XA_IT_WECOM_BOT_ID}",
"secret": "${XA_IT_WECOM_BOT_SECRET}"
```

### 5.4 网关鉴权改用环境变量；bind 用关键字

容器要被宿主访问，`bind` 用 `lan`（不要写 `0.0.0.0` 或 `127.0.0.1`）。端口与 compose 一致用 `18789`。token 不要再用 `source: exec`。

```json
"gateway": {
  "port": 18789,
  "mode": "local",
  "bind": "lan",
  "auth": {
    "mode": "token",
    "token": "${OPENCLAW_GATEWAY_TOKEN}"
  },
  "tailscale": {
    "mode": "off"
  }
}
```

`gateway.mode` 必须是 `local`，否则网关可能拒绝启动。

国内模型在启动前**不要**写真实 `baseUrl`、API Key 或模型名。Agent 的 `model` 可先留占位 `"domestic-provider/model-name"`，或预先写好 `${XA_DOMESTIC_MODEL_REF}` 等占位符（见 **6.4 节**，须在阶段 B 补全 secrets 后再生效）。网关 `/healthz` 通过并完成企微配置后，按 **6.4** + `DashScope 兼容 Provider 配置手册.md` 完成模型注入与回归。企微 `allowFrom` 见 `WeCom 通道插件接入手册.md`，不要用生产全员名单做试验。

### 5.5 没有企微插件时：先去掉 wecom，否则网关起不来

`wecom` 通道由 `wecom-openclaw-plugin` 注册。目录不存在时 OpenClaw 会报：

```text
plugins.load.paths: plugin path not found: /home/node/.openclaw/extensions/wecom-openclaw-plugin
channels.wecom: unknown channel id: wecom
```

**有插件：** 确认宿主机存在 `~/xa/extensions/wecom-openclaw-plugin`（里面应有插件清单，如 `openclaw.plugin.json` 或 `package.json`），然后：

```bash
ls ~/xa/extensions/wecom-openclaw-plugin
sudo chown -R 1000:1000 ~/xa/extensions
```

**暂时没有插件（先把网关跑通）：** 在 `openclaw.json` 里做四件事：

1. `plugins.load.paths` 只保留 OA 桥接，去掉 wecom 那一条。
2. `plugins.allow` 去掉 `"wecom-openclaw-plugin"`。
3. `plugins.entries` 里删除 `wecom-openclaw-plugin` 整段。
4. **删除整个 `channels.wecom` 对象**（未知通道 id 会被拒绝）。`bindings` 里 `channel: wecom` 可先留着或一并删掉；没有通道时绑定不会生效。

示例（无企微时的 `plugins`）：

```json
"plugins": {
  "allow": [
    "oa-workflow-bridge"
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
    }
  }
}
```

改完后必须先停掉崩溃循环再启动：

```bash
cd ~/xa
docker compose down
docker compose up -d
```

网关起来后仍**不能收企微消息**。拿到 `wecom-openclaw-plugin` 后拷到 `~/xa/extensions/`，把 allow / load.paths / entries / `channels.wecom` 加回去，再 `docker compose down && docker compose up -d`。

---

## 6. Docker secrets（不用 `.env`）

OpenClaw **不会**读取 `OPENCLAW_GATEWAY_TOKEN_FILE` 这类变量（那是部分官方镜像的约定）。secret 文件挂在 `/run/secrets/<名字>`，需要入口脚本读文件再 `export` 成 OpenClaw 认识的环境变量。

本节分**两阶段**，顺序不可颠倒：

| 阶段 | 何时 | 做什么 |
| --- | --- | --- |
| **A：初装** | 第 5 步改完 json 后、第一次 `compose up` 前 | 3 个 secret（Gateway + 企微）；entrypoint + compose **阶段 A 版本** |
| **B：模型与第三方参数** | 第 7 步 `/healthz` 通、企微插件配完后（检查清单第 9 步） | 再增 5 个模型相关 secret；升级 entrypoint + compose；json 中 `models` 段用 `${VAR}` |

### 6.0 变量契约（阶段 B 完整清单）

OpenClaw 通过 `${VAR_NAME}` 引用环境变量（仅大写 `[A-Z_][A-Z0-9_]*`）。**禁止**在 `openclaw.json`、`environment:`、`.env` 中写第三方真值。

| 参数 | 环境变量 | secret 文件 | openclaw.json 占位 |
| --- | --- | --- | --- |
| Gateway Token | `OPENCLAW_GATEWAY_TOKEN` | `gateway_token.txt` | `${OPENCLAW_GATEWAY_TOKEN}` |
| 企微 BotId | `XA_IT_WECOM_BOT_ID` | `wecom_bot_id.txt` | `${XA_IT_WECOM_BOT_ID}` |
| 企微 BotSecret | `XA_IT_WECOM_BOT_SECRET` | `wecom_bot_secret.txt` | `${XA_IT_WECOM_BOT_SECRET}` |
| 模型 API Key | `XA_DOMESTIC_API_KEY` | `model_api_key.txt` | `${XA_DOMESTIC_API_KEY}` |
| 模型 Base URL | `XA_DOMESTIC_BASE_URL` | `model_base_url.txt` | `${XA_DOMESTIC_BASE_URL}` |
| 模型 ID（API 请求体） | `XA_DOMESTIC_MODEL_ID` | `model_id.txt` | `models.providers.domestic.models[].id` → `${XA_DOMESTIC_MODEL_ID}` |
| 完整模型 ref | `XA_DOMESTIC_MODEL_REF` | `model_ref.txt` | `agents.entries.*.model` → `${XA_DOMESTIC_MODEL_REF}`（内容如 `domestic/deepseek-chat`） |
| API 协议 | `XA_DOMESTIC_API` | `model_api.txt` | `models.providers.domestic.api` → `${XA_DOMESTIC_API}`（如 `openai-completions`） |

`model_ref.txt` 须与 `model_id.txt` 一致：`model_ref` = `domestic/` + `model_id` 的值。

> **与 Linux 服务器手册的差异（不要互抄）：** 上表的**变量名与 secret 文件名**两本手册相同，改契约要两边同步。但本手册的 Provider 键名是 `domestic`，而 [OpenClaw Gateway Linux 服务器安装手册.md](OpenClaw%20Gateway%20Linux%20服务器安装手册.md) 第 6.1 节与现网样例用的是 `bailian`，并且那边把 API 协议写死在 json、不引用 `${XA_DOMESTIC_API}`。把本节片段照抄到服务器上会出现 Unknown model。现网口径以 [openclaw.json 配置参考.md](openclaw.json%20配置参考.md) 第 15 节为准。

### 6.1 阶段 A：写密钥文件（各一行，不要多余空格换行）

```bash
mkdir -p ~/xa/secrets
openssl rand -base64 32 | tr -d '\n' > ~/xa/secrets/gateway_token.txt
printf '%s' '你的企微BotId'     > ~/xa/secrets/wecom_bot_id.txt
printf '%s' '你的企微BotSecret' > ~/xa/secrets/wecom_bot_secret.txt
chmod 600 ~/xa/secrets/*
```

阶段 A **只建以上 3 个文件**。模型相关 5 个 secret 在 **6.4 阶段 B** 再建。

### 6.2 阶段 A：写入口脚本 `~/xa/entrypoint.sh`

完整内容如下。卷使用相对路径，不必改 Linux 用户名。

```sh
#!/bin/sh
set -eu
export OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < /run/secrets/gateway_token)"
export XA_IT_WECOM_BOT_ID="$(tr -d '\n' < /run/secrets/wecom_bot_id)"
export XA_IT_WECOM_BOT_SECRET="$(tr -d '\n' < /run/secrets/wecom_bot_secret)"
exec node dist/index.js gateway --bind lan --port 18789
```

写入并授权：

```bash
cat > ~/xa/entrypoint.sh <<'EOF'
#!/bin/sh
set -eu
export OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < /run/secrets/gateway_token)"
export XA_IT_WECOM_BOT_ID="$(tr -d '\n' < /run/secrets/wecom_bot_id)"
export XA_IT_WECOM_BOT_SECRET="$(tr -d '\n' < /run/secrets/wecom_bot_secret)"
exec node dist/index.js gateway --bind lan --port 18789
EOF
chmod 755 ~/xa/entrypoint.sh
sudo chown 1000:1000 ~/xa/entrypoint.sh ~/xa/secrets/*
```

### 6.3 阶段 A：写 `~/xa/docker-compose.yml`

完整内容如下。

**项目目录是 `/home/lijinjin/xa` 时：yml 默认不用改。**  
`./config`、`./workspace`、`./secrets/...` 是相对路径，相对的是 **yml 所在目录**。只要文件放在 `/home/lijinjin/xa/docker-compose.yml`，并且在该目录执行 `docker compose`：

| yml 里写的 | 实际用的宿主机路径 |
| --- | --- |
| `./config` | `/home/lijinjin/xa/config` |
| `./workspace` | `/home/lijinjin/xa/workspace` |
| `./extensions` | `/home/lijinjin/xa/extensions` |
| `./entrypoint.sh` | `/home/lijinjin/xa/entrypoint.sh` |
| `./secrets/gateway_token.txt` | `/home/lijinjin/xa/secrets/gateway_token.txt` |

冒号**右边**的 `/home/node/.openclaw` **不要改成** `/home/lijinjin/xa`。那是容器里 `node` 用户的家目录，不是 WSL 用户。

只有在这两种情况才需要改 yml：compose 文件不在 `/home/lijinjin/xa/`，或你希望写死绝对路径。可选写法（效果与相对路径相同）：

```yaml
    volumes:
      - /home/lijinjin/xa/config:/home/node/.openclaw
      - /home/lijinjin/xa/workspace:/home/node/.openclaw/workspace
      - /home/lijinjin/xa/extensions:/home/node/.openclaw/extensions
      - /home/lijinjin/xa/entrypoint.sh:/entrypoint.sh:ro
secrets:
  gateway_token:
    file: /home/lijinjin/xa/secrets/gateway_token.txt
  wecom_bot_id:
    file: /home/lijinjin/xa/secrets/wecom_bot_id.txt
  wecom_bot_secret:
    file: /home/lijinjin/xa/secrets/wecom_bot_secret.txt
```

推荐仍用下面的相对路径版本，少绑死用户名。

```yaml
services:
  xa-gateway:
    image: openclaw/openclaw:latest
    container_name: xa-gateway
    user: "1000:1000"
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"
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
      - "18789:18789"
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

写入：

```bash
cat > ~/xa/docker-compose.yml <<'EOF'
services:
  xa-gateway:
    image: openclaw/openclaw:latest
    container_name: xa-gateway
    user: "1000:1000"
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"
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
      - "18789:18789"
    init: true
    entrypoint: ["/bin/sh", "/entrypoint.sh"]

secrets:
  gateway_token:
    file: ./secrets/gateway_token.txt
  wecom_bot_id:
    file: ./secrets/wecom_bot_id.txt
  wecom_bot_secret:
    file: ./secrets/wecom_bot_secret.txt
EOF
```

`docker compose pull` / `up` **必须在 `~/xa` 下执行**，该目录要同时有：

```text
~/xa/docker-compose.yml
~/xa/entrypoint.sh
~/xa/config/openclaw.json
~/xa/workspace/
~/xa/extensions/
~/xa/secrets/gateway_token.txt
~/xa/secrets/wecom_bot_id.txt
~/xa/secrets/wecom_bot_secret.txt
```

### 6.4 阶段 B：国内模型与第三方参数（Docker 全注入）

**前置：** 第 7 节 `/healthz` 已通过；企微插件与通道按 `WeCom 通道插件接入手册.md` 配完（检查清单第 8 步）。  
**原则：** 模型 `baseUrl`、API Key、模型 ID、协议等**全部**走 secret → entrypoint → `${VAR}`；**禁止**用 `oc config set` 写入明文。

#### 6.4.1 新增 5 个 secret 文件

```bash
printf '%s' '你的模型APIKey'                    > ~/xa/secrets/model_api_key.txt
printf '%s' 'https://api.deepseek.com/v1'        > ~/xa/secrets/model_base_url.txt
printf '%s' 'deepseek-chat'                      > ~/xa/secrets/model_id.txt
printf '%s' 'domestic/deepseek-chat'             > ~/xa/secrets/model_ref.txt
printf '%s' 'openai-completions'                 > ~/xa/secrets/model_api.txt
chmod 600 ~/xa/secrets/model_*.txt
sudo chown 1000:1000 ~/xa/secrets/model_*.txt
```

将示例 URL、模型 ID 换成你的供应商实际值；`model_ref` 必须为 `domestic/` + `model_id`。

#### 6.4.2 升级 entrypoint.sh（整文件替换）

本节**不含** OA / MySQL / 身份转换 export。若已经接了桥接，**不要**用下面这段覆盖 `~/xa/entrypoint.sh`（会丢掉 `OA_MYSQL_PASSWORD`、`OA_*` 与 `WECOM_IDENTITY_*`）。已接 OA 时直接用仓库 `docker/entrypoint.sh`（见 `OA_tool/OA Workflow Bridge 接入手册.md` 第 5.3 节）。

```bash
cat > ~/xa/entrypoint.sh <<'EOF'
#!/bin/sh
set -eu
export OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < /run/secrets/gateway_token)"
export XA_IT_WECOM_BOT_ID="$(tr -d '\n' < /run/secrets/wecom_bot_id)"
export XA_IT_WECOM_BOT_SECRET="$(tr -d '\n' < /run/secrets/wecom_bot_secret)"
export XA_DOMESTIC_API_KEY="$(tr -d '\n' < /run/secrets/model_api_key)"
export XA_DOMESTIC_BASE_URL="$(tr -d '\n' < /run/secrets/model_base_url)"
export XA_DOMESTIC_MODEL_ID="$(tr -d '\n' < /run/secrets/model_id)"
export XA_DOMESTIC_MODEL_REF="$(tr -d '\n' < /run/secrets/model_ref)"
export XA_DOMESTIC_API="$(tr -d '\n' < /run/secrets/model_api)"
exec node dist/index.js gateway --bind lan --port 18789
EOF
chmod 755 ~/xa/entrypoint.sh
sudo chown 1000:1000 ~/xa/entrypoint.sh
```

#### 6.4.3 升级 docker-compose.yml（在 6.3 基础上追加 5 个 secret）

在 `services.xa-gateway.secrets` 与底部 `secrets:` 各增加：

```yaml
      - model_api_key
      - model_base_url
      - model_id
      - model_ref
      - model_api
```

```yaml
  model_api_key:
    file: ./secrets/model_api_key.txt
  model_base_url:
    file: ./secrets/model_base_url.txt
  model_id:
    file: ./secrets/model_id.txt
  model_ref:
    file: ./secrets/model_ref.txt
  model_api:
    file: ./secrets/model_api.txt
```

阶段 B 完成后 `~/xa/secrets/` 应有 **8 个** `.txt` 文件。新增 secret 挂载须重建容器：

```bash
cd ~/xa
docker compose down
docker compose up -d
```

#### 6.4.4 在 `openclaw.json` 中写入 models 占位（不写明文）

在顶层增加或合并 `models` 段，并确保 Agent 使用 `${XA_DOMESTIC_MODEL_REF}`：

```json
"models": {
  "mode": "merge",
  "providers": {
    "domestic": {
      "baseUrl": "${XA_DOMESTIC_BASE_URL}",
      "apiKey": "${XA_DOMESTIC_API_KEY}",
      "api": "${XA_DOMESTIC_API}",
      "timeoutSeconds": 20,
      "models": [
        {
          "id": "${XA_DOMESTIC_MODEL_ID}",
          "name": "domestic-model",
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

在 `agents.entries` 中对应 Agent 上：

```json
"model": "${XA_DOMESTIC_MODEL_REF}"
```

`contextWindow`、`maxTokens` 等非第三方参数可留 json 固定值。在 `providers.domestic`（或 `bailian`）上加 `"timeoutSeconds": 20`，与 `api` 同级。改 secret 轮换 Key 或 `baseUrl` 时**只改** `~/xa/secrets/*.txt` 并 `docker compose down && docker compose up -d`，不必改 json 明文。

使用 `qwen3.8-max` / `qwen3.8-flash` 时，`compat.thinkingFormat: "qwen"` **必填**，否则百炼按默认 xhigh 思考，企微要等十几秒才出 `kind=final`。完整说明与已上线改法见 `DashScope 兼容 Provider 配置手册.md` **§2.4 / §4.2**。Provider 键若是 `bailian`，把上面片段的 `"domestic"` 改成 `"bailian"`，并保证 `model_ref.txt` 前缀一致。

#### 6.4.5 验证注入与模型

```bash
docker exec xa-gateway sh -c '
  for v in XA_DOMESTIC_API_KEY XA_DOMESTIC_BASE_URL XA_DOMESTIC_MODEL_ID \
           XA_DOMESTIC_MODEL_REF XA_DOMESTIC_API; do
    eval "test -n \"\$$v\"" || { echo "MISSING:$v"; exit 1; }
  done
  echo MODEL_INJECT_OK
'

docker exec -it xa-gateway node dist/index.js config validate
docker exec -it xa-gateway node dist/index.js models status
docker exec -it xa-gateway node dist/index.js models list --provider domestic
```

通过后按 `DashScope 兼容 Provider 配置手册.md` 做工具调用与回归测试。

**变更第三方参数时：** 只改 secret 文件 + `compose down/up`；不要用 CLI 写 `baseUrl` / `apiKey` 明文。

### 6.5 说明

- Compose 的 `secrets:`（非 Swarm）把宿主机文件只读挂进容器，**不会**出现在 `environment:` 明文里。
- 非 Swarm 模式下该文件在宿主机仍是明文；靠目录权限 `600` 和仅服务账号可读来保护。需要加密落盘时再上 Swarm secret 或企业 Vault。
- `user: "1000:1000"` 时，若启动报 `/run/secrets` Permission denied，把 secret 文件改成组/其他可读，或暂时去掉 `user:` 验证。

不要使用 `env_file: .env` 传递 BotSecret / Gateway Token。

---

## 7. 启动与验证

```bash
cd ~/xa
docker compose pull
docker compose up -d
docker compose ps
docker logs --tail 80 xa-gateway
```

`docker-compose.yml` 的 `image` 保持 `openclaw/openclaw:latest`，不要改。加速源报「免费节点繁忙」或 VPN 下仍拉失败时，用下面两法，**拉完打标签对齐 yml，再 `docker compose up -d`**。Windows 开了 VPN 不等于 WSL 里的 dockerd 走 VPN。

**方案 A（先试）：从 GHCR 拉，再 tag。** `registry-mirrors` 不管 `ghcr.io`。**必须执行 `docker tag`。** 不 tag 则本地只有 `ghcr.io/openclaw/openclaw:latest`，`docker images` 里**不会出现** `openclaw/openclaw`；第 4 节和 OA 手册 4.2 默认写的 Hub 名会对不上，Docker 会再去 Docker Hub 拉。若决定让 yml 的 `image:` 直接写 ghcr 名、且不 tag：第 4 节 / OA 手册必须用 4.2 的「GHCR 名」整段，不要混用，也不要补拉 `openclaw/openclaw:latest`。

```bash
docker pull ghcr.io/openclaw/openclaw:latest
docker tag ghcr.io/openclaw/openclaw:latest openclaw/openclaw:latest
cd ~/xa && docker compose up -d
```

**方案 B：关掉加速，给 dockerd 配 VPN 的 HTTP 代理。** 端口换成你客户端的（常见 `7890` / `10809`）。NAT 下 Windows 主机 IP 用 `grep nameserver /etc/resolv.conf`；mirrored 网络用 `127.0.0.1`。

```bash
sudo cp /etc/docker/daemon.json /etc/docker/daemon.json.bak
echo '{}' | sudo tee /etc/docker/daemon.json
sudo mkdir -p /etc/systemd/system/docker.service.d
WIN_HOST=$(grep nameserver /etc/resolv.conf | awk '{print $2}')
sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf >/dev/null <<EOF
[Service]
Environment="HTTP_PROXY=http://${WIN_HOST}:7890"
Environment="HTTPS_PROXY=http://${WIN_HOST}:7890"
Environment="NO_PROXY=localhost,127.0.0.1"
EOF
sudo systemctl daemon-reload
sudo systemctl restart docker
docker pull openclaw/openclaw:latest
cd ~/xa && docker compose up -d
```

拉通后可删 `http-proxy.conf` 并恢复 `daemon.json.bak`。不要用非官方第三方 OpenClaw 镜像。

容器应为 `Up`，日志不要循环重启。然后：

```bash
curl http://127.0.0.1:18789/healthz
docker exec -it xa-gateway node dist/index.js gateway status --deep
docker exec -it xa-gateway node dist/index.js agents list --bindings
```

Windows 浏览器打开 `http://localhost:18789/`，Dashboard 的 token 使用：

```bash
cat ~/xa/secrets/gateway_token.txt
```

绑定应能看到 `wecom` / `default` → `itservicedeskagent`（企微插件未装时通道可能不健康，但 agent 列表仍应存在）。

企微插件与通道见 `WeCom 通道插件接入手册.md`，不要在 `Restarting` 时跑 `configure`。

OA 只读预检（当前阶段可选，且 **不会** 建单）：

```bash
docker exec -it xa-gateway sh -c 'export OA_MYSQL_PASSWORD="$(tr -d "\n" < /run/secrets/oa_mysql_password)" OA_API_USER_ID="$(tr -d "\n" < /run/secrets/oa_api_user_id)" OA_APP_SECRET="$(tr -d "\n" < /run/secrets/oa_app_secret)"; node /home/node/.openclaw/extensions/oa-workflow-bridge/scripts/readonly-preflight.mjs'
```

未配置 OA 凭据时失败是预期行为。正式恢复 OA 前读 `OA_tool/OA Workflow Bridge 接入手册.md`。

---

## 8. 用 OpenClaw 命令配置（网关起来之后）

可以、也**应该**用 OpenClaw 自带命令配置，不要把所有项都手改 json。分两段：

| 阶段 | 何时 | 做什么 |
| --- | --- | --- |
| 启动前 | 容器 `Restarting`、日志 `Invalid config` | 第 5 步手改模板（或下面的 `doctor --fix`）。向导连不上稳定 Gateway，配不完 |
| 启动后 | `docker compose ps` 为 `Up`，`/healthz` 通 | `config validate`；企微见 `WeCom 通道插件接入手册.md`；模型见 **6.4** + `DashScope 兼容 Provider 配置手册.md` |

容器内没有全局 `openclaw` 命令时，一律：

```bash
docker exec -it xa-gateway node dist/index.js <子命令>
```

下面简写为 `oc`，即 `docker exec -it xa-gateway node dist/index.js`。

### 8.1 配置是否合法

```bash
oc config validate
oc gateway status --deep
oc doctor
```

`config validate` 通过再改模型或插件。`--json` 便于把报错贴出来排查。

### 8.2 企业微信插件安装与配置

网关 `Up` 且 `/healthz` 通之后，企微插件的安装、白名单、通道配置、验证与排错，**一律按独立文档操作**：

→ **[WeCom 通道插件接入手册.md](WeCom 通道插件接入手册.md)**

该文档涵盖：`plugins.allow`、`channels.wecom`、`allowFrom`、secrets / entrypoint、收发测试等完整流程。

### 8.3 国内模型（Docker 全注入，禁止 CLI 写明文）

第三方模型参数（`baseUrl`、API Key、模型 ID、协议、Agent `model`）**一律**按 **第 6.4 节** 注入，不要：

- 在 `openclaw.json` 写明文 URL 或 Key；
- 用 `oc config set models.providers.domestic.baseUrl 'https://...'` 等命令写真值；
- 使用 `onboard` / `models auth paste-api-key` 把 Key 写入 auth 文件（与 Docker secrets 体系不一致）。

网关 Up 且企微通后：完成 **6.4** → `config validate` → `models status` → 按 `DashScope 兼容 Provider 配置手册.md` 回归。

若仅需**非敏感** catalog 元数据（如 `contextWindow`），可手改 json 或 `oc config set`；**不得**用 CLI 覆盖 `${VAR}` 占位符为明文。

### 8.4 不要用 `onboard` 覆盖 xA

`onboard` / `setup` 会按默认向导写一套新配置，容易盖掉 `itservicedeskagent`、workspace 和插件路径。本部署已经有 xA 的 `openclaw.json` 和 workspace，**不要**在该容器里再跑一遍 `onboard`。网关起来后只做第 5 步 + 第 8.2 节企微文档 + **6.4** 模型注入 + `DashScope 兼容 Provider 配置手册.md`。

---

## 9. 日常运维

完整命令、巡检、备份、升级回滚、三层排障见 **[OpenClaw Gateway Docker 运维手册.md](OpenClaw Gateway Docker 运维手册.md)**。本节只保留最短入口。

```bash
cd ~/xa
docker compose up -d
docker compose ps
curl -sS http://127.0.0.1:18789/healthz
docker compose down           # 停止（不删镜像、不删 ~/xa 数据）
docker compose restart xa-gateway
docker logs -f --timestamps xa-gateway
```

`restart: unless-stopped` 加上 `systemctl enable docker` 后，重开 WSL 一般会拉起 Docker；若容器没起来再执行 `docker compose up -d`。改了 `secrets/*.txt`、entrypoint 或 compose 的挂载时，必须 `docker compose down && docker compose up -d`，只 `restart` 不够。

---

## 10. 检查清单

| 步 | 做什么 | 成功标准 |
| --- | --- | --- |
| 1 | WSL2 Ubuntu | `wsl -l -v` 为 2 |
| 2 | Docker Engine + Compose | `docker compose version` 有输出 |
| 3 | systemd + 加速 | `hello-world` 成功 |
| 4 | `~/xa` 拷规则/插件/配置 | config / workspace / extensions 有文件；桥接的 `extensions/oa-workflow-bridge/node_modules/{mysql2,jpeg-js,pngjs}` 都存在（OA 桥接接入手册 4.2） |
| 5 | 改 `openclaw.json` | 无 `handoffTemplate`；无 `C:\`、无 powershell/DPAPI；路径为 `/home/node/...` |
| 6 | secrets + entrypoint + compose（阶段 A） | 无 `.env`；3 个 secret；entrypoint 3 行 export |
| 7 | `compose up` | `/healthz` 通，Dashboard 能打开 |
| 8 | `WeCom 通道插件接入手册.md` | 企微插件与通道配置完成；测试机器人能收发 |
| 9 | **6.4** + `DashScope 兼容 Provider 配置手册.md` | 8 个 secret；`compat.thinkingFormat: "qwen"`；`MEMORY.md` 存在；工具调用回归通过 |

---

## 11. 常见问题

| 现象 | 处理 |
| --- | --- |
| `registry-1.docker.io` i/o timeout | 检查 `registry-mirrors`；yml 仍用 `openclaw/openclaw:latest` |
| 加速源「免费节点繁忙」 | 第 7 节方案 A（GHCR 后 **必须 tag**）或方案 B（关加速 + dockerd 代理） |
| 拉 `ghcr.io` 超时 | Windows VPN 未作用于 dockerd，用方案 B |
| 第 4 节 / OA 手册 `npm install` 又在拉 `openclaw/openclaw:latest` | 本机镜像名是 `ghcr.io/openclaw/openclaw:latest`（方案 A 未 tag，或 yml 已改成 ghcr）。`docker images` 没有 `openclaw/openclaw` 时不要去 Docker Hub 补拉。用 OA Redis 接入手册 4.2 的「GHCR 名」整段，或先 `docker tag` |
| `docker images` 没有 `openclaw/openclaw` / `compose ps` IMAGE 是 ghcr | 不是缺镜像。Gateway 已在用 GHCR 名。装依赖见 OA 桥接接入手册 4.2 |
| `gateway.bind` 校验失败、容器重启 | `--bind` / json 里只能用 `lan`、`loopback`、`auto`、`tailnet`，不要写 IP |
| Permission denied 读写挂载目录 | `sudo chown -R 1000:1000 ~/xa` |
| 读 `/run/secrets` Permission denied | secret 文件权限过严，或 `user: "1000:1000"` 读不到 root 的 400 文件 |
| json 里写了 `/home/YOUR_LINUX_USER/...` | 容器内无此路径，改为 `/home/node/.openclaw/...` |
| 工作区放在 `/mnt/c` 又慢又报错 | 迁到 `~/xa` |
| 企微收不到消息 | 见 `WeCom 通道插件接入手册.md` 第 13 节；确认插件 enabled、`allowFrom` 含 `"*"`（测试） |
| 企微发出去很久才回、客户端一直空白 | 见 `WeCom 通道插件接入手册.md` **7.4**（打开「思考中」）与 `DashScope 兼容 Provider 配置手册.md` §2.4 / §6.7（关掉 qwen3.8-max 隐藏思考） |
| `*_FILE` 环境变量不生效 | OpenClaw 不认该约定，必须用 `entrypoint.sh` export |
| `meta: Invalid input`、容器 Restarting | 删掉非法 `meta` 键（`handoffTemplate` 等，见 5.0），然后 `docker compose down && docker compose up -d` |
| `plugin path not found: .../wecom-openclaw-plugin` 且 `unknown channel id: wecom` | 本仓库不含该插件。没有则按 5.5 去掉 wecom；有插件或网关 Up 后按 `WeCom 通道插件接入手册.md` 安装 |
| `plugin path not found: .../oa-workflow-bridge-redis`、Restarting (78) | json 仍写旧目录。allow / paths / entries 改为 `oa-workflow-bridge`（OA 桥接接入手册 5.1），再 `down && up` |
| Gateway Up 但企微 `autostart suppressed` | crash-loop breaker。见运维手册 **11.4**；不要 `channels start --channel` |
| 容器 `Restarting` 时 `docker exec` 进不去 | 先 `compose down`，按 5.0/5.5 改 json，或 `docker run ... node dist/index.js doctor --fix` 修挂载配置 |
| 想用 `onboard` 代替改 json | 不要。会覆盖 xA 的 agent/workspace。见 8.4 |
| 模型仍不智能 / 占位符 | 检查清单第 9 步：是否完成 **6.4**；`models status` 是否 unresolved |
| 改了 baseUrl 不生效 | 改 `model_base_url.txt` 后须 `compose down/up`；勿用 CLI 写明文 |
| `channels add wecom` 没有 wecom | 见 `WeCom 通道插件接入手册.md` 第 5–6 节（allowlist + 安装插件） |
| `Command 'npm' not found` | **不要** `sudo apt install npm`。第 4 节用官方镜像安装；约定见 `OA_tool/OA Workflow Bridge 接入手册.md` 第 4.2 节 |

---

## 12. 和本仓库其他资料的关系

- 本仓库只维护 Linux / Docker 路径。不要在容器里执行 Windows 原生 PowerShell / DPAPI 脚本。
- 业务规则看 `workspace-rules/workspace/AGENTS.md` 与 `workspace-rules/xA 提示词规则优化说明.md`；OA 契约看 `OA_tool/OA Workflow Bridge 接入手册.md`；凭据边界看 `第三方凭据注入与配置中心演进.md`。
- 企业 Vault / **Nacos 配置中心** 可替换 Docker secret 文件来源：保持 **6.0 变量名契约** 与 `${VAR}` 占位符，只换 entrypoint 或同步脚本的取数方式。见 **[第三方凭据注入与配置中心演进.md](第三方凭据注入与配置中心演进.md)**。
- 装完之后的启停、巡检、备份、升级、排障见 **[OpenClaw Gateway Docker 运维手册.md](OpenClaw Gateway Docker 运维手册.md)**。第 10 节是**安装**检查清单，不是日常巡检。
- 迁到内网 Linux 服务器或 VM 时，不要继续用本文第 1 节 WSL 步骤，改走 **[OpenClaw Gateway Linux 服务器安装手册.md](OpenClaw Gateway Linux 服务器安装手册.md)**。同一企微 Bot 不要在 WSL 与服务器上同时 `up`。
- MySQL 与 OA 桥接见 **[MySQL 数据库准备.md](MySQL%20数据库准备.md)** 与 **[OA_tool/OA Workflow Bridge 接入手册.md](OA_tool/OA%20Workflow%20Bridge%20接入手册.md)**。

---

## 13. 安全注意

- `~/xa/secrets/` 与 `entrypoint.sh` 不要提交到 git，不要打进镜像。
- 不要把 BotSecret、Gateway Token、模型 Key、模型 **baseUrl** 写入 `openclaw.json` 明文。
- 日志不得出现 token、Header、附件 base64、原始 SenderId。
- 测试环境使用测试企微机器人，不要接生产账号。

---

## 14. 容量扩展

先分清要扩的是**另一套业务**，还是**同一个 xA 的用户量**。不要默认「复制一份 compose 再起一个容器」。

扩容决策、多套目录/端口/密钥的完整步骤与 YAML 示例见 **[OpenClaw Gateway 部署拓扑与选型.md](OpenClaw Gateway 部署拓扑与选型.md) 附录 A**（原本节全文迁入，步骤未改）。

### 14.1 一句话（原文保留）

扩「另一个机器人 / 另一套业务」→ 复制 compose，**并**换目录、端口、密钥、配置，再起新容器。  
扩「同一个 xA 的用户量」→ **不要**复制，只扩这一套的机器和模型。  
扩「同一网关里多个 Agent」→ 先确认企微插件多账号可用，再在**同一个**容器的 json 里加 agent 和 binding。
