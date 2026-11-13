# OpenClaw Gateway Linux 服务器安装手册

在 SmartX 超融合划出的 Linux 虚机上，用 Docker 跑起 xA Gateway（官方 OpenClaw + OA 桥接插件 + 企微通道）。装完之后的启停、巡检、备份、升级见 [OpenClaw Gateway Docker 运维手册.md](OpenClaw%20Gateway%20Docker%20运维手册.md)。

compose、entrypoint、Dockerfile、`openclaw.json` 都以仓库文件为准，本手册不再重贴。文中 `REPO` 指拷到服务器上的本仓库 `linux/` 目录。

## 0. 约定

| 项 | 值 |
| --- | --- |
| 系统 | Ubuntu 24.04 / 22.04，x86_64，systemd；≥ 4GB 内存、系统盘留 ≥ 20GB |
| 宿主 | SmartX 划出的虚机。不要在 SmartX 控制台或宿主节点上装；规格不够找平台扩虚机 |
| 工作目录 | `~/xa`，必须在虚机本机盘（ext4 / xfs），不要 NFS / CIFS / 超融合共享盘 |
| 容器用户 | uid `1000`（镜像用户 `node`）。宿主不必建 `node` 用户 |
| 镜像 | 自建 `xa-gateway-oa:2026.9.2` = `ghcr.io/openclaw/openclaw:2026.9.2` + OA 桥接插件与依赖 |
| 端口 | 宿主 `127.0.0.1:18789` → 容器 `18789`。不对公网开放，Dashboard 走 SSH 隧道 |
| MySQL | 独立机器，Gateway 经局域网连 3306 |

路径对照（`openclaw.json` 里一律写容器路径）：

```text
~/xa/config               → /home/node/.openclaw
~/xa/workspace            → /home/node/.openclaw/workspace
~/xa/extensions           → /home/node/.openclaw/extensions        （只放企微插件）
~/xa/oa-bridge-config.json→ /opt/xa/oa-workflow-bridge/bridge-config.json（只读）
~/xa/secrets/*.txt        → /run/secrets/<名字>
```

凭据规则：真值只放 `~/xa/secrets/*.txt`（`600`，属主 `1000:1000`），由 `entrypoint.sh` export 成环境变量，`openclaw.json` 只写 `${VAR}`。不要写进 compose `environment:`、`.env`、`bridge-config.json`，也不要用 `config set` 写明文。

**改了 secret、entrypoint、compose、`plugins.load.paths`、端口，必须 `docker compose down && docker compose up -d`，只 `restart` 不够。**

## 1. 服务器与 Docker

```bash
. /etc/os-release && echo "$PRETTY_NAME"; ps -p 1 -o comm=; uname -m; free -h; df -h /
sudo timedatectl set-timezone Asia/Shanghai
sudo ufw allow OpenSSH && sudo ufw enable
```

不要 `ufw allow 18789`。

安装 Docker Engine 与 Compose（官方源）：

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
sudo systemctl enable --now docker
```

重新 SSH 登录后验证：`groups` 含 `docker`，`docker run --rm hello-world` 成功。宿主不装 Node / npm。

拉镜像慢时二选一：

- Docker Hub 加速：`/etc/docker/daemon.json` 写 `{"registry-mirrors": ["<可用的加速源>"]}`。加速源只管 docker.io，不管 ghcr.io。
- 公司代理：写 `/etc/systemd/system/docker.service.d/http-proxy.conf`，内容为 `[Service]` 下 `Environment="HTTP_PROXY=…"`、`HTTPS_PROXY`、`NO_PROXY=localhost,127.0.0.1`，然后 `sudo systemctl daemon-reload && sudo systemctl restart docker`。

## 2. 拷仓库、建目录

在源机器上（只拷这一份仓库）：

```bash
rsync -avz /path/to/adt_openclaw/linux/ YOUR_LINUX_USER@SERVER:~/handoff/xa/
```

在服务器上：

```bash
REPO="$HOME/handoff/xa"
mkdir -p ~/xa/{config,workspace,extensions,secrets}
cp -r "$REPO/workspace-rules/workspace/." ~/xa/workspace/
cp "$REPO/docker/docker-compose.yml" "$REPO/docker/entrypoint.sh" ~/xa/
cp "$REPO/OA_tool/oa-workflow-bridge/bridge-config.example.json" ~/xa/oa-bridge-config.json
chmod 755 ~/xa/entrypoint.sh
```

`~/xa/workspace/MEMORY.md` 必须存在（缺了群聊寒暄会多跑一轮模型）。

## 3. 准备独立 MySQL（DBA 在 MySQL 机器上做）

要求：MySQL 5.7+ / 8.x 或 MariaDB 10.6+，`utf8mb4`，InnoDB。数据量很小（每张确认单一行，月约百行），插件连接池最多 4 个连接。表由插件启动时自动建。

```sql
CREATE DATABASE IF NOT EXISTS xa_oa CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'xa_oa'@'<Gateway 虚机 IP>' IDENTIFIED BY '<强随机密码>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER ON xa_oa.* TO 'xa_oa'@'<Gateway 虚机 IP>';
FLUSH PRIVILEGES;
```

- 只授权这一个库，不用 root，不给 `ALL ON *.*`。
- `bind-address` 不能只有 `127.0.0.1`；防火墙只放 Gateway 虚机 → 3306。
- 裸装后跑 `mysql_secure_installation`。匿名账号 `''@'localhost'` 会抢先匹配，表现为 `Access denied for user 'xa_oa'@'localhost'`。
- 备份：开 binlog 或每日 `mysqldump --single-transaction --routines xa_oa > xa_oa_$(date +%F).sql`。`oa_ticket` 是台账要保留；`oa_inbox` / `oa_identity` 是缓存，丢了会重建。
- 两个 Gateway 不能连同一个库；测试库和生产库分开（集成测试会清表）。

Gateway 虚机上验证：`nc -vz <MySQL 主机> 3306`。

## 4. 写 secrets（12 个）

变量名以仓库 `docker/entrypoint.sh` 为准，缺任何一个容器都起不来（`missing or empty secret`）。

| secret 文件 | 环境变量 | 内容 |
| --- | --- | --- |
| `gateway_token.txt` | `OPENCLAW_GATEWAY_TOKEN` | `openssl rand -base64 32` |
| `wecom_bot_id.txt` | `XA_IT_WECOM_BOT_ID` | 企微机器人 BotId |
| `wecom_bot_secret.txt` | `XA_IT_WECOM_BOT_SECRET` | 企微机器人 BotSecret |
| `model_api_key.txt` | `XA_DOMESTIC_API_KEY` | 百炼 API Key |
| `model_base_url.txt` | `XA_DOMESTIC_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `model_id.txt` | `XA_DOMESTIC_MODEL_ID` | 百炼模型 ID |
| `model_ref.txt` | `XA_DOMESTIC_MODEL_REF` | `bailian/` + 模型 ID（前缀必须等于 Provider 键 `bailian`） |
| `oa_mysql_password.txt` | `OA_MYSQL_PASSWORD` | 第 3 节的密码 |
| `oa_api_user_id.txt` | `OA_API_USER_ID` | OA 接口账号人员 id（只读预检用，不是申请人） |
| `oa_app_secret.txt` | `OA_APP_SECRET` | OA AppSecret |
| `wecom_identity_corpid.txt` | `WECOM_IDENTITY_CORPID` | 企业 corpid |
| `wecom_identity_secret.txt` | `WECOM_IDENTITY_SECRET` | 企微自建应用 secret（不是机器人 BotSecret） |

`XA_DOMESTIC_*` 是历史命名，与 Provider 键名无关；API 协议在 json 里写死 `openai-completions`。

```bash
cd ~/xa/secrets
openssl rand -base64 32 | tr -d '\n' > gateway_token.txt
printf '%s' '<值>' > wecom_bot_id.txt      # 其余文件同理，一律 printf '%s'，不要 echo（会多换行）
chmod 600 *.txt
```

## 5. 构建镜像

```bash
cd ~/handoff/xa
docker build -f docker/Dockerfile -t xa-gateway-oa:2026.9.2 .
docker run --rm --entrypoint ls xa-gateway-oa:2026.9.2 /opt/xa/oa-workflow-bridge/node_modules   # 要有 mysql2 / jpeg-js / pngjs
```

- 拉不到 GHCR：先拿到任一官方镜像，加 `--build-arg OPENCLAW_IMAGE=<本机镜像名>`。
- npm 慢：加 `--build-arg npm_config_registry=https://registry.npmmirror.com`。
- 生产机不能出网：在别的 Linux x64 上构建，`docker save … | gzip` 拷过来 `docker load`。
- 以后改了插件代码或 `systems.json` 都要重新构建（建议换新 tag，旧 tag 即回滚点）。

## 6. 写配置

**`~/xa/oa-bridge-config.json`**：填 `mysql.host` / `user` / `database`、`appId`、`publicKeySpkiBase64`；不写密码。初装 `active: false`，`isnextflow: "0"`。字段见 [OA 接入手册](OA_tool/OA%20Workflow%20Bridge%20接入手册.md) 第 4 节。

**`~/xa/config/openclaw.json`**：用仓库样例，但先去掉 `channels` 和 `bindings`（企微插件还没装，写了会 `unknown channel id: wecom`，容器反复重启）：

```bash
python3 - <<'EOF'
import json, pathlib
home = pathlib.Path.home()
cfg = json.loads((home / "handoff/xa/workspace-rules/openclaw.json").read_text())
for key in ("channels", "bindings", "wizard"):
    cfg.pop(key, None)
(home / "xa/config/openclaw.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
EOF
```

授权：

```bash
sudo chown -R 1000:1000 ~/xa
chmod 700 ~/xa/secrets && chmod 600 ~/xa/secrets/*.txt
```

SSH 用户不是 uid 1000 时，之后改 `~/xa` 下的文件用 `sudo -e` / `sudo tee`，改完再 `chown`。不要 `chmod 777`。

## 7. 第一次 up：网关 + 模型 + OA

```bash
cd ~/xa
docker compose up -d
docker compose ps                         # Up (healthy)
docker logs --tail 100 xa-gateway
curl -sS http://127.0.0.1:18789/healthz   # 含 "ok":true
```

日志应有：

- `agent model: bailian/<模型 ID> (thinking=off, …)`
- `[oa-workflow-bridge] loaded (MySQL state)`

不应有：`Invalid config`、`Unknown model`、`MySQL init failed`、`Cannot find package 'mysql2'`、`plugin path not found`。

MySQL 上 `SHOW TABLES FROM xa_oa;` 应有 `oa_identity` / `oa_inbox` / `oa_ticket`。再跑 OA 只读预检（[OA 接入手册](OA_tool/OA%20Workflow%20Bridge%20接入手册.md) 7.2）。

`docker exec` 不跑 entrypoint，CLI 报 `missing env var` 不影响主进程。需要时用 `-e` 带上变量：

```bash
docker exec -it -e OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < ~/xa/secrets/gateway_token.txt)" \
  xa-gateway node dist/index.js config validate
```

下文用别名简写容器内 CLI：

```bash
alias oc='docker exec -it xa-gateway node dist/index.js'
```

Dashboard：在自己电脑上 `ssh -N -L 18789:127.0.0.1:18789 YOUR_LINUX_USER@SERVER`，浏览器开 `http://127.0.0.1:18789/`，填 `gateway_token.txt` 的值。

不要在容器里跑 `onboard` / `setup` / `configure`：会覆盖 `itservicedeskagent`、工作区和插件路径。

## 8. 接企业微信

插件 id 已在 `plugins.allow` / `entries`（来自样例），现在安装：

```bash
oc plugins install npm:@wecom/wecom-openclaw-plugin@<版本> --force --accept-capabilities
oc plugins list     # @wecom/wecom-openclaw-plugin … enabled，version ≥ 2026.7.2
```

`<版本>` 取 npm 包页当时的 Version，必须 ≥ 2026.7.2。一定要带 `npm:` 前缀：不带前缀或用 `plugins update` 会装 catalog 钉死的旧版。不要用 `doctor --fix` 装。版本细节见 [WeCom 通道插件接入手册.md](WeCom%20通道插件接入手册.md) 第 5 节。`load.paths` 不加企微目录。

写通道与路由（`${…}` 两侧单引号保留，否则 shell 会吃掉变量）：

```bash
oc config set channels.wecom.enabled true
oc config set channels.wecom.botId '${XA_IT_WECOM_BOT_ID}'
oc config set channels.wecom.secret '${XA_IT_WECOM_BOT_SECRET}'
oc config set channels.wecom.dmPolicy open
oc config set channels.wecom.groupPolicy open
oc config set channels.wecom.allowFrom '["*"]'
oc config set channels.wecom.sendThinkingMessage true    # 插件 < 2026.7.2 必须 false
oc config set bindings '[{"type":"route","agentId":"itservicedeskagent","match":{"channel":"wecom","accountId":"default"}}]'
cd ~/xa && docker compose down && docker compose up -d
```

`dmPolicy: open` 时 `allowFrom` 必须含 `"*"`，否则私聊全被丢弃。改完用 `diff` 对照仓库 `workspace-rules/openclaw.json`。

验证：

```bash
oc channels status --channel wecom --probe   # enabled, configured, running, works
oc agents list --bindings                    # wecom/default → itservicedeskagent
```

## 9. 验收

1. 企微 `/new` 后 `/context detail`：`AGENTS.md` 未截断，`Skills list` 为 0。
2. 测试机器人私聊「你是谁」：1～2 秒出「思考中」，几秒内回固定自我介绍。
3. 报一个问题，出确认卡；回 `2` 取消。
4. 发图：日志无 `apply_media_understanding`，回复不描述图片内容。
5. 要真正建单时把 `oa-bridge-config.json` 的 `active` 改 `true`，`down && up`，确认后拿到数字 `requestId`。

装完后放好 inbound 清理 cron（运维手册第 7 节），否则 `media/inbound` 会一直涨。

## 10. 常见问题

| 现象 | 处理 |
| --- | --- |
| `missing or empty secret: /run/secrets/…` | 第 4 节缺文件或空文件；补齐后 `down && up` |
| 读 `/run/secrets` / 挂载目录 Permission denied | `sudo chown -R 1000:1000 ~/xa`，secret `600` |
| `gateway.bind` 校验失败 | 只能写 `lan` / `loopback` / `auto` / `tailnet`，不能写 IP |
| `Unknown model: bailian/…` / unresolved | `model_ref.txt` 必须是 `bailian/` + `model_id.txt`；改完 `down && up` |
| `MySQL init failed: …` | `ECONNREFUSED` / `ETIMEDOUT` 查网络与 `bind-address`；`ER_ACCESS_DENIED_ERROR` 查密码与账号 host；`ER_BAD_DB_ERROR` 查库名；`OA_MYSQL_PASSWORD is not configured` 查 secret |
| `plugin path not found: /opt/xa/oa-workflow-bridge` / `Cannot find package 'mysql2'` | compose 用的不是 `xa-gateway-oa`；按第 5 节构建 |
| `plugin path not found: …oa-workflow-bridge-redis` | json 还是旧 id，只留 `oa-workflow-bridge`，路径只留 `/opt/xa/oa-workflow-bridge` |
| `unknown channel id: wecom` | 插件没装就写了通道。去掉 `channels` 与 `bindings`，`down && up`，按第 8 节先装插件 |
| `blocked by allowlist` | `plugins.allow` 缺 `wecom-openclaw-plugin` |
| `meta: Invalid input` | 删掉非法 `meta` 键（如旧模板的 `handoffTemplate`） |
| Gateway Up 但 `autostart suppressed` | 崩溃熔断，见运维手册第 8 节；不要 `channels start --channel` |
| 回复要十几秒 | 见 [DashScope 手册](DashScope%20兼容%20Provider%20配置手册.md) 第 4 节 |
| 「思考中」一直转 | 插件 < 2026.7.2；`sendThinkingMessage` 改 `false` 并 `restart` |
| 服务器重启后容器没起 | `systemctl is-active docker`；`cd ~/xa && docker compose up -d` |

容器 Restarting、`docker exec` 进不去时：`docker compose down`，按日志手改 `~/xa/config/openclaw.json` 再 `up`。不得不用 `doctor --fix` 时，先备份 json，用 `docker run --rm --user 1000:1000 -v ~/xa/config:/home/node/.openclaw … xa-gateway-oa:2026.9.2 node dist/index.js doctor --fix`（必须用 OA 镜像，否则会把 OA 插件从配置里清掉），改完 `config validate` 再回归。

## 11. 安全

- `~/xa/secrets/` 和含 secrets 的备份不进 git、不进镜像、不传公共网盘。
- 日志里不得出现 token、Authorization、附件 base64、原始 SenderId。
- 测试用测试机器人；同一个 Bot 同一时刻只能被一个 Gateway 持有。切流：先停旧实例，再起新实例。
- 公网扫到 18789：立刻确认 compose 是 `127.0.0.1:18789:18789`，`down && up`，轮换 `gateway_token.txt`。
