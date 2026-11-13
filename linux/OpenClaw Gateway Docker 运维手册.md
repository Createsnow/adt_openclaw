# OpenClaw Gateway Docker 运维手册

> 本文档由仓库根目录原文档**重组**而来：只调整章节归属与交叉引用，**不改变**部署步骤、命令、YAML、错误码或禁止事项。阅读顺序见 [README.md](README.md)。

**快捷跳转：** [目录](#toc) · [健康检查](#sec-03) · [巡检清单](#sec-05) · [应急速查](#sec-12-4) · [OA 对账](#sec-12-5) · [相关文档](#sec-17)

<a id="toc" name="toc"></a>

## 目录

点击条目即可跳转到对应章节；各章末尾可返回目录或进入上一节 / 下一节。

- [概述](#overview)
  - [适用对象与边界](#audience)
  - [环境差异（Linux 服务器须跳过）](#env-diff)
  - [默认约定](#defaults)
  - [重要提示](#notes)
  - [快速入口](#quick-start)
- [日常运维](#part-ops)
  - [1. 先分清两份清单](#sec-01)
  - [2. 日常启停](#sec-02)
  - [3. 健康检查命令包](#sec-03)
    - [3.1 Windows 侧：WSL 还在吗](#sec-03-1)
    - [3.2 Ubuntu 侧：Docker 还在吗](#sec-03-2)
    - [3.3 容器与端口](#sec-03-3)
    - [3.4 OpenClaw 自身状态](#sec-03-4)
    - [3.5 启动日志](#sec-03-5)
    - [3.6 一次性巡检脚本](#sec-03-6)
  - [4. 日志](#sec-04)
    - [4.1 常用查看命令](#sec-04-1)
    - [4.2 按现象 grep](#sec-04-2)
    - [4.3 日志里禁止出现的内容](#sec-04-3)
    - [4.4 日志把磁盘写满时](#sec-04-4)
  - [5. 巡检清单](#sec-05)
    - [5.1 每日](#sec-05-1)
    - [5.2 每周](#sec-05-2)
    - [5.3 每月](#sec-05-3)
- [变更与生命周期](#part-lifecycle)
  - [6. 备份与恢复](#sec-06)
    - [6.1 必须备份 vs 可以不备份](#sec-06-1)
    - [6.2 做一次备份](#sec-06-2)
    - [6.3 恢复](#sec-06-3)
  - [7. 密钥轮换](#sec-07)
    - [7.1 各密钥怎么轮](#sec-07-1)
    - [7.2 生效](#sec-07-2)
  - [8. 镜像与插件：升级、核对、回滚](#sec-08)
    - [8.1 先看清当前版本](#sec-08-1)
    - [8.2 升级 OpenClaw 镜像](#sec-08-2)
    - [8.3 回滚 OpenClaw 镜像](#sec-08-3)
    - [8.4 升级企微插件](#sec-08-4)
    - [8.5 升级后回归](#sec-08-5)
  - [9. 配置变更怎么落地](#sec-09)
- [宿主与资源](#part-host)
  - [10. 资源、磁盘、WSL 虚拟盘](#sec-10)
    - [10.1 容器资源](#sec-10-1)
    - [10.2 Docker 磁盘清理](#sec-10-2)
    - [10.3 WSL2 VHDX](#sec-10-3)
    - [10.4 inbound 原件满 24 小时回收](#sec-10-4)
      - [10.4.1 写入当前用户 crontab](#sec-10-4-1)
  - [11. 开机、睡眠、自愈](#sec-11)
    - [11.1 正常预期](#sec-11-1)
    - [11.2 Windows 重启后自动拉起](#sec-11-2)
    - [11.3 睡眠 / 休眠之后](#sec-11-3)
    - [11.4 crash-loop breaker](#sec-11-4)
- [排障与硬化](#part-troubleshoot)
  - [12. 三层排障与应急](#sec-12)
    - [12.1 层 1：Windows / WSL](#sec-12-1)
    - [12.2 层 2：Docker 守护进程与容器](#sec-12-2)
    - [12.3 层 3：OpenClaw / 企微 / 模型](#sec-12-3)
    - [12.4 应急速查](#sec-12-4)
      - [A. 容器在 Restarting](#sec-12-4-a)
      - [B. 企微突然不回](#sec-12-4-b)
      - [C. 很慢](#sec-12-4-c)
      - [D. 磁盘满](#sec-12-4-d)
      - [E. 误执行了 prune / down -v](#sec-12-4-e)
    - [12.5 OA 结果不明（unknown）对账](#sec-12-5)
  - [13. 建议补进 compose 的运维项](#sec-13)
    - [13.1 Gateway 健康检查](#sec-13-1)
    - [13.2 日志轮转](#sec-13-2)
    - [13.3 资源上限](#sec-13-3)
    - [13.4 钉住镜像版本](#sec-13-4)
  - [14. 多套环境时注意](#sec-14)
  - [15. 安全运维](#sec-15)
- [附录](#part-appendix)
  - [16. 打印用巡检表](#sec-16)
    - [16.1 每日](#sec-16-1)
    - [16.2 每周](#sec-16-2)
    - [16.3 每月 / 变更后](#sec-16-3)
  - [17. 相关文档](#sec-17)

---

<a id="overview" name="overview"></a>

## 概述

本文讲的是 **装完之后怎么养**：日常启停、巡检、备份、升级、排障。不替代安装手册里的安装步骤。

安装检查清单看 Linux 服务器安装手册第 23 节；**装完之后怎么养**看本文。

<a id="audience" name="audience"></a>

### 适用对象与边界

适用对象：已按 **[OpenClaw Gateway Linux 服务器安装手册.md](OpenClaw%20Gateway%20Linux%20服务器安装手册.md)** 跑通 xA OpenClaw Gateway，需要做日常启停、巡检、备份、升级、排障的工程师。

- **做：** 容器启停、健康检查、日志、巡检、备份恢复、密钥轮换、镜像/插件升级、磁盘与自愈、三层排障。
- **不做：** 第一次部署、重装、换机器。那些走安装检查清单，不要用本文巡检清单代替。

<a id="env-diff" name="env-diff"></a>

### 环境差异（Linux 服务器须跳过）

Linux 服务器环境**跳过**以下 WSL / Windows 专属小节：

| 小节 | 内容 | 为何跳过 |
| --- | --- | --- |
| [3.1](#sec-03-1) | WSL 探活 | 没有 WSL |
| [10.1](#sec-10-1) 中的 `.wslconfig` | WSL 内存上限 | 直接改虚机内存 |
| [10.3](#sec-10-3) | VHDX 压缩 | 没有 WSL 虚拟盘 |
| [11.2](#sec-11-2) | Windows 任务计划 | 用 systemd / cron |
| [11.3](#sec-11-3) | Windows 睡眠 | 服务器不休眠 |

安装检查清单看 Linux 服务器手册第 23 节。

<a id="defaults" name="defaults"></a>

### 默认约定

与安装手册一致：

| 项 | 值 |
| --- | --- |
| 工作目录 | `~/xa`（必须在 Linux 家目录，不要放 `/mnt/c`） |
| 容器名 | `xa-gateway` |
| 镜像 | 自建 `xa-gateway-oa:2026.9.2`（官方 OpenClaw + OA 桥接插件与依赖，`docker/Dockerfile`，见 OA 桥接接入手册 4.2）。OA 插件在镜像的 `/opt/xa/oa-workflow-bridge`，不在 `~/xa/extensions` |
| 网关端口 | 宿主 `18789` → 容器 `18789` |
| 健康检查 URL | `http://127.0.0.1:18789/healthz` |
| 容器内 CLI | `docker exec -it xa-gateway node dist/index.js <子命令>` |

第二套业务把目录、容器名、端口换成 `~/xa-hr`、`xa-hr-gateway`、`18790`，命令结构相同。OA 桥接的状态库是独立机器上的 MySQL（不在本机 compose 里），准备与备份见 [MySQL 数据库准备.md](MySQL%20数据库准备.md)。

<a id="notes" name="notes"></a>

### 重要提示

`docker exec` **不会**执行 `entrypoint.sh`，因此 CLI 可能报 `missing env var "OPENCLAW_GATEWAY_TOKEN"`。这不影响正在跑的 Gateway 主进程。以启动日志和 `/healthz` 为准；必须带环境变量时用 [第 3.4 节](#sec-03-4)写法。

<a id="quick-start" name="quick-start"></a>

### 快速入口

| 你要做什么 | 去哪 |
| --- | --- |
| 启动 / 停止 / 重启 | [2. 日常启停](#sec-02) |
| 出问题了，先探活 | [3. 健康检查命令包](#sec-03) |
| 复制一段脚本做巡检 | [3.6 一次性巡检脚本](#sec-03-6) |
| 查日志 / 按现象 grep | [4. 日志](#sec-04) |
| 日 / 周 / 月巡检 | [5. 巡检清单](#sec-05) |
| 备份或恢复 | [6. 备份与恢复](#sec-06) |
| 换 Token / Key / Secret | [7. 密钥轮换](#sec-07) |
| 升级或回滚镜像 / 插件 | [8. 镜像与插件](#sec-08) |
| 改了 json / secret / compose | [9. 配置变更怎么落地](#sec-09) |
| 磁盘满、inbound 回收 | [10. 资源与磁盘](#sec-10) · [10.4 inbound cron](#sec-10-4) |
| 开机起不来 / 睡眠后不收消息 / 熔断 | [11. 开机、睡眠、自愈](#sec-11) |
| 对号入座排障 | [12. 三层排障](#sec-12) |
| 容器 Restarting / 企微不回 / 很慢 / 盘满 | [12.4 应急速查](#sec-12-4) |
| 多套 Gateway | [14. 多套环境](#sec-14) |
| 打印勾选表 | [16. 打印用巡检表](#sec-16) |

[↑ 目录](#toc) · [下一节 → 1. 先分清两份清单](#sec-01)

---

<a id="part-ops" name="part-ops"></a>

## 日常运维

启停、探活、日志、日/周/月巡检。容器异常时先跑 [第 3 节健康检查](#sec-03)，不要直接发测试消息。

<a id="sec-01" name="sec-01"></a>

## 1. 先分清两份清单

| 清单 | 何时用 | 在哪 |
| --- | --- | --- |
| **安装检查清单** | 第一次部署、重装、换机器 | Linux 服务器手册第 23 节、企微/百炼各自文档末尾 |
| **运维巡检清单** | 已经在跑，每天/每周/每月保养 | [本文第 5 节](#sec-05) |

不要用安装清单代替巡检。安装清单通过只说明「当时装对了」，不说明「现在还健康」。

[↑ 目录](#toc) · [下一节 → 2. 日常启停](#sec-02)

---

<a id="sec-02" name="sec-02"></a>

## 2. 日常启停

所有 compose 命令必须在 **`~/xa`** 下执行（该目录要有 `docker-compose.yml`）。

```bash
cd ~/xa

# 启动（已存在则跳过，不存在则创建）
docker compose up -d

# 查看状态
docker compose ps
docker compose ps -a

# 只重启 Gateway（不重建容器，secret / yml 改过之后不够）
docker compose restart
docker compose restart xa-gateway

# 停止并删除容器（不删镜像、不删 ~/xa 数据）
docker compose down

# 停止但不删容器（少用；日常用 down 或 restart 即可）
docker compose stop
docker compose start
```

**改了什么，用哪条：**

| 你改了什么 | 用哪条 |
| --- | --- |
| 只想让进程重新读已挂载的 `openclaw.json`（多数热重载字段） | 可先等热重载；不生效再 `docker compose restart xa-gateway` |
| `plugins.load.paths`、`gateway.port` / `bind`、entrypoint、compose 的 `secrets:` / `volumes:` | `docker compose down && docker compose up -d` |
| `~/xa/secrets/*.txt` 内容 | **必须** `docker compose down && docker compose up -d`（环境变量在进程启动时注入） |
| 只看日志 | `docker compose logs` / `docker logs`，不要重启 |

```bash
cd ~/xa
docker compose down
docker compose up -d
docker compose ps
curl -sS http://127.0.0.1:18789/healthz
```

期望：`xa-gateway` 为 `Up` 或 `Up (healthy)`，`/healthz` 返回含 `"ok":true` 的 JSON。仓库 [`docker/docker-compose.yml`](docker/docker-compose.yml) **已含** `healthcheck`；安装手册初装生成的 compose 若还没有，见[第 13 节](#sec-13)。

[← 1. 先分清两份清单](#sec-01) · [↑ 目录](#toc) · [下一节 → 3. 健康检查命令包](#sec-03)

---

<a id="sec-03" name="sec-03"></a>

## 3. 健康检查命令包（出问题先跑这一组）

按顺序执行。任一步失败，先停在该步，不要跳到「发测试消息」。

<a id="sec-03-1" name="sec-03-1"></a>

### 3.1 Windows 侧：WSL 还在吗

在 **Windows PowerShell**（不是 Ubuntu）：

```powershell
wsl -l -v
wsl --status
wsl -d Ubuntu-24.04 -- echo WSL_OK
```

成功标准：`Ubuntu-24.04` 的 `VERSION` 为 `2`，最后一条打印 `WSL_OK`。

发行版名不是 `Ubuntu-24.04` 时，用 `wsl -l -v` 里的实际名字替换 `-d` 参数。

<a id="sec-03-2" name="sec-03-2"></a>

### 3.2 Ubuntu 侧：Docker 还在吗

在 **Ubuntu 终端**：

```bash
ps -p 1 -o comm=
systemctl is-active docker
docker info >/dev/null && echo DOCKER_OK
docker compose version
```

成功标准：第一行是 `systemd`，`docker` 为 `active`，打印 `DOCKER_OK`，`docker compose version` 有版本号。

Docker 没起来：

```bash
sudo systemctl start docker
sudo systemctl enable docker
systemctl is-active docker
```

<a id="sec-03-3" name="sec-03-3"></a>

### 3.3 容器与端口

```bash
cd ~/xa
docker compose ps -a
docker inspect -f '{{.State.Status}} {{.State.RestartCount}} {{.State.ExitCode}} {{.State.Error}}' xa-gateway
ss -lnt | grep 18789 || netstat -lnt | grep 18789
curl -sS -o /tmp/xa-healthz.json -w 'HTTP %{http_code}\n' http://127.0.0.1:18789/healthz
cat /tmp/xa-healthz.json; echo
```

成功标准：

| 项 | 期望 |
| --- | --- |
| `compose ps` | `xa-gateway` 为 `Up`，不在 `Restarting` / `Exited` |
| RestartCount | 刚启动后可以是 0～1；持续增加说明崩溃循环 |
| `curl` | `HTTP 200`，JSON 含 `"ok":true` |
| 端口 | 有进程监听 `18789` |

Windows 浏览器再打开 `http://localhost:18789/`。Dashboard 的 token：

```bash
cat ~/xa/secrets/gateway_token.txt; echo
```

<a id="sec-03-4" name="sec-03-4"></a>

### 3.4 OpenClaw 自身状态

```bash
docker exec -it xa-gateway node dist/index.js gateway status --deep
docker exec -it xa-gateway node dist/index.js config validate
docker exec -it xa-gateway node dist/index.js agents list --bindings
docker exec -it xa-gateway node dist/index.js plugins list
docker exec -it xa-gateway node dist/index.js channels list
docker exec -it xa-gateway node dist/index.js channels status --channel wecom --probe
docker exec -it xa-gateway node dist/index.js models status
```

`config validate` 若报 `Missing env var`，用下面这一组（从宿主机 secret 注入，**不会**把真值写进 json）：

```bash
docker exec -it \
  -e OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < ~/xa/secrets/gateway_token.txt)" \
  -e XA_IT_WECOM_BOT_ID="$(tr -d '\n' < ~/xa/secrets/wecom_bot_id.txt)" \
  -e XA_IT_WECOM_BOT_SECRET="$(tr -d '\n' < ~/xa/secrets/wecom_bot_secret.txt)" \
  -e XA_DOMESTIC_API_KEY="$(tr -d '\n' < ~/xa/secrets/model_api_key.txt)" \
  -e XA_DOMESTIC_BASE_URL="$(tr -d '\n' < ~/xa/secrets/model_base_url.txt)" \
  -e XA_DOMESTIC_MODEL_ID="$(tr -d '\n' < ~/xa/secrets/model_id.txt)" \
  -e XA_DOMESTIC_MODEL_REF="$(tr -d '\n' < ~/xa/secrets/model_ref.txt)" \
  -e XA_DOMESTIC_API="$(tr -d '\n' < ~/xa/secrets/model_api.txt)" \
  xa-gateway node dist/index.js config validate
```

阶段 A 还没有模型 5 个 secret 时，去掉对应的 `-e XA_DOMESTIC_*` 行。

成功标准：

| 命令 | 期望 |
| --- | --- |
| `gateway status --deep` | Gateway 在跑，端口 18789 |
| `config validate` | 通过，无 `Invalid config` |
| `agents list --bindings` | `wecom` / `default` → `itservicedeskagent`（未装企微时 agent 仍应存在） |
| `plugins list` | 已启用的插件为 enabled |
| `channels status --channel wecom --probe` | 已配企微时为 `enabled, configured, running, works` |
| `models status` | 无 `unresolved` / `Unknown model` |

<a id="sec-03-5" name="sec-03-5"></a>

### 3.5 启动日志（主进程是否真的健康）

```bash
docker logs --tail 120 --timestamps xa-gateway
docker logs xa-gateway 2>&1 | grep -E 'agent model|Invalid config|breaker tripped|autostart suppressed|listening|bind' || true
```

期望看到类似：

```text
agent model: domestic/qwen3.8-max (thinking=off, fast=off)
```

或 `bailian/qwen3.8-max`。不要出现：

```text
Invalid config
meta: Invalid input
restart-loop breaker tripped
[wecom] channel autostart suppressed
plugin path not found
unknown channel id: wecom
```

<a id="sec-03-6" name="sec-03-6"></a>

### 3.6 一次性巡检脚本（复制整段）

在 Ubuntu 里执行。脚本只读、不改配置、不重启容器。

```bash
bash <<'EOF'
set -u
cd "${HOME}/xa" || { echo "FAIL: ~/xa 不存在"; exit 1; }

echo "===== 1. Docker / compose ====="
systemctl is-active docker || echo "FAIL: docker 未 active"
docker compose ps || true

echo
echo "===== 2. 容器状态 ====="
if docker inspect xa-gateway >/dev/null 2>&1; then
  docker inspect -f 'Status={{.State.Status}} RestartCount={{.State.RestartCount}} ExitCode={{.State.ExitCode}}' xa-gateway
else
  echo "FAIL: 容器 xa-gateway 不存在"
fi

echo
echo "===== 3. /healthz ====="
if curl -sS -m 5 http://127.0.0.1:18789/healthz; then
  echo
else
  echo "FAIL: /healthz 无响应"
fi

echo
echo "===== 4. 磁盘与权限 ====="
df -h "${HOME}/xa"
echo -n "secrets 权限: "
stat -c '%a %n' "${HOME}/xa/secrets"/*.txt 2>/dev/null || echo "无 secrets 文件"
test -f "${HOME}/xa/workspace/MEMORY.md" && echo "MEMORY.md: OK" || echo "FAIL: 缺少 ~/xa/workspace/MEMORY.md"

echo
echo "===== 5. 启动日志关键行 ====="
docker logs xa-gateway 2>&1 | grep -E 'agent model|Invalid config|breaker tripped|autostart suppressed|plugin path not found' | tail -n 20 || true

echo
echo "===== 6. 资源 ====="
docker stats --no-stream xa-gateway 2>/dev/null || true
docker system df

echo
echo "===== 巡检脚本结束（OpenClaw CLI 请按第 3.4 节手动跑） ====="
EOF
```

OA 状态库（独立 MySQL）的连通性看插件日志即可，不在本机巡检脚本里查：

```bash
docker logs --since 24h xa-gateway 2>&1 | grep -E 'MySQL init failed|DB_UNAVAILABLE|sweep failed' | tail -n 5
# 期望：无输出
```

[← 2. 日常启停](#sec-02) · [↑ 目录](#toc) · [下一节 → 4. 日志](#sec-04)

---

<a id="sec-04" name="sec-04"></a>

## 4. 日志

<a id="sec-04-1" name="sec-04-1"></a>

### 4.1 常用查看命令

```bash
cd ~/xa

# 跟踪（Ctrl+C 只停跟踪，不停容器）
docker compose logs -f xa-gateway
docker logs -f --timestamps xa-gateway

# 最近 N 行
docker logs --tail 80 --timestamps xa-gateway
docker compose logs --tail 80 xa-gateway

# 按时间
docker logs --since 30m --timestamps xa-gateway
docker logs --since 2026-08-31T00:00:00 --timestamps xa-gateway

# 只看错误关键字
docker logs --since 24h xa-gateway 2>&1 | grep -Ei 'error|fatal|invalid|denied|breaker|unresolved|enoent|429'
```


<a id="sec-04-2" name="sec-04-2"></a>

### 4.2 按现象 grep（完整命令）

在 Ubuntu 执行。`grep` 不到不代表没问题，再对一下[第 3 节](#sec-03)健康检查。

```bash
# 模型实际用了哪一个、思考开没开
docker logs xa-gateway 2>&1 | grep -E 'agent model'

# 模型调用耗时（elapsedMs 只是首包；体感看它后面多久出现 kind=final）
docker logs --since 1h xa-gateway 2>&1 | grep -E 'model-fetch|kind=final|elapsedMs|timeoutMs'

# 发图是否误走媒体理解（应接近 0ms 或不出现）
docker logs --since 1h xa-gateway 2>&1 | grep -E 'apply_media_understanding'

# 企微鉴权与收发
docker logs --since 1h xa-gateway 2>&1 | grep -Ei 'wecom|Authentication successful|Reply message sent|Reply ack|inbound|DM dropped'

# 配置非法 / 崩溃循环
docker logs xa-gateway 2>&1 | grep -Ei 'Invalid config|meta: Invalid|breaker tripped|autostart suppressed|Restarting'

# 群聊 MEMORY.md 二次调用
docker logs --since 24h xa-gateway 2>&1 | grep -E 'MEMORY.md|ENOENT'

# 模型找不到 / 占位符没注入
docker logs xa-gateway 2>&1 | grep -Ei 'Unknown model|unresolved|model_not_found|Missing env var'

# OA 插件没加载 / 连不上库（镜像不对或 MySQL 不通）
docker logs --since 1h xa-gateway 2>&1 | grep -E "Cannot find (package|module)|plugin path not found|MySQL init failed"
```

`oa_workflow` 的 `OA_IDENTITY_*` **不会**出现在 `docker logs`。员工说「还不能提交到 OA」时，到会话 jsonl 抽工具 `code`，完整命令见 `OA_tool/企微到OA身份.md` 9.9 节。不要 `cat` 整份 jsonl（含加密 userid）。

<a id="sec-04-3" name="sec-04-3"></a>

### 4.3 日志里禁止出现的内容

发现下面这些，当作安全事件：立刻截断外传、轮换对应密钥（[第 7 节](#sec-07)），不要把完整日志贴到群里。

- Gateway Token、企微 BotSecret、模型 API Key
- 请求 Header 里的 Authorization
- 附件 base64
- 原始 SenderId（通道 `from.userid`，现网为加密串；不要当工号外传）

排查时只拷贝 **去掉真值后的** 关键字行。

<a id="sec-04-4" name="sec-04-4"></a>

### 4.4 日志把磁盘写满时

现网 Gateway compose **已加** 日志轮转（`json-file`，单文件 20m，最多 5 个）。容器日志仍在：

```text
/var/lib/docker/containers/<容器ID>/<容器ID>-json.log
```

轮转只管这份 stdout，**不管** `~/xa` 里的会话 jsonl、`media/inbound`。改 `logging` 须 `down && up`，只 `restart` 不够。核对：

```bash
docker inspect -f '{{json .HostConfig.LogConfig}}' xa-gateway
docker inspect -f '{{.LogPath}}' xa-gateway
sudo ls -lh "$(docker inspect -f '{{.LogPath}}' xa-gateway)"
docker system df
```

应看到 `max-size` / `max-file`。盘仍满：先看 jsonl 与两处 `media/inbound`（[第 10.4 节](#sec-10-4)），不要删 OA 台账。应急（会丢掉该容器已有日志，不删 `~/xa`）：

```bash
cd ~/xa
docker compose down
# 确认没有业务写入后再清未用对象；不要加 -a 除非你知道在删什么
docker container prune -f
sudo sh -c 'truncate -s 0 "$(docker inspect -f "{{.LogPath}}" xa-gateway)"' 2>/dev/null || true
docker compose up -d
```

[← 3. 健康检查命令包](#sec-03) · [↑ 目录](#toc) · [下一节 → 5. 巡检清单](#sec-05)

---

<a id="sec-05" name="sec-05"></a>

## 5. 巡检清单

<a id="sec-05-1" name="sec-05-1"></a>

### 5.1 每日（约 5 分钟）

| # | 做什么 | 命令 | 成功标准 |
| --- | --- | --- | --- |
| 1 | 容器在跑 | `cd ~/xa && docker compose ps` | `xa-gateway` 为 `Up` |
| 2 | 健康接口 | `curl -sS http://127.0.0.1:18789/healthz` | HTTP 200，`"ok":true` |
| 3 | 没有崩溃循环 | `docker inspect -f '{{.State.RestartCount}}' xa-gateway` | 数字不再持续增加 |
| 4 | 日志无致命关键字 | [第 4.2 节](#sec-04-2) `Invalid config` / `breaker` 那条 | 无匹配，或都是已处理的旧日志 |
| 5 | 企微抽测（工作日） | 测试机器人发「你是谁」；同时 `docker logs -f --timestamps xa-gateway` | 有 inbound，有 `Reply message sent` 与 `Reply ack received` |

未装企微时，第 5 步改成 Control UI 发一条，或只做 1～4。

<a id="sec-05-2" name="sec-05-2"></a>

### 5.2 每周

| # | 做什么 | 命令 | 成功标准 |
| --- | --- | --- | --- |
| 1 | 资源 | `docker stats --no-stream xa-gateway` | 内存未长期顶满限额；CPU 不是持续 100% |
| 2 | Docker 磁盘 | `docker system df` | Images / Containers / Logs 未异常膨胀 |
| 3 | 工作区磁盘 | `du -sh ~/xa ~/xa/workspace ~/xa/config` | 相对上周增长可解释 |
| 3b | inbound 原件 | `du -sh ~/xa/config/media/inbound ~/xa/workspace/media/inbound`；`tail -n 14 ~/xa/logs/inbound-prune.log` | 两处体积相对上周可解释；日志每天有 `deleted_files=`（可为 0）。未装 cron 见[第 10.4 节](#sec-10-4) |
| 4 | secret 权限 | `stat -c '%a %n' ~/xa/secrets/*.txt` | 文件为 `600`（或 `640` 且仅服务账号可读） |
| 5 | MEMORY.md | `test -f ~/xa/workspace/MEMORY.md && echo OK` | 打印 `OK` |
| 6 | 模型仍解析 | `docker logs xa-gateway 2>&1 \| grep 'agent model' \| tail -n 3` | 仍是预期的 `domestic/...` 或 `bailian/...`，`thinking=off` |
| 7 | 插件/通道 | [第 3.4 节](#sec-03-4) `plugins list` + `channels status --channel wecom` | enabled，无 `autostart suppressed` |
| 8 | 无明文 Key 漂移 | `grep -R --exclude-dir=workspace -E 'sk-|dashscope|BotSecret|apiKey.: .[^$]' ~/xa/config/openclaw.json ~/xa/config/agents 2>/dev/null \| head` | 不应把真值搜出来；占位符 `${VAR}` 可以有 |

OA 状态库抽查（在能连 MySQL 的机器上执行，只读）：待对账单应为 0，有则按[第 12.5 节](#sec-12-5)处理。

```sql
SELECT status, COUNT(*) FROM xa_oa.oa_ticket GROUP BY status;
```

<a id="sec-05-3" name="sec-05-3"></a>

### 5.3 每月

| # | 做什么 | 命令 / 动作 | 成功标准 |
| --- | --- | --- | --- |
| 1 | 备份 | [第 6 节](#sec-06) | 备份包能在本机 `tar -tzf` 列出文件 |
| 2 | 恢复演练（建议对 staging） | [第 6.3 节](#sec-06-3) | `/healthz` 通，测试消息能回 |
| 3 | 镜像与插件版本 | [第 8.1 节](#sec-08-1) | 与本文档版本矩阵、企微指南第 16 节一致 |
| 4 | 密钥是否临期 | 百炼控制台、企微后台 | Key / Secret 未过期 |
| 5 | WSL 虚拟盘 | [第 10.3 节](#sec-10-3) | VHDX 未把宿主机盘吃满 |
| 6 | 清理无用镜像 | [第 10.2 节](#sec-10-2) | 只删悬空/旧 tag，当前正在用的保留 |
| 7 | 配置与文档 | 对照安装手册变量表（工位 6.0 / Linux 服务器 6.1） | json 仍是 `${VAR}`，无手写明文 URL/Key |

[← 4. 日志](#sec-04) · [↑ 目录](#toc) · [下一节 → 6. 备份与恢复](#sec-06)

---

<a id="part-lifecycle" name="part-lifecycle"></a>

## 变更与生命周期

备份恢复、密钥轮换、镜像/插件升级、配置怎么落地。改 secret 或 compose 必须 `down && up`，只 `restart` 不够。

<a id="sec-06" name="sec-06"></a>

## 6. 备份与恢复

<a id="sec-06-1" name="sec-06-1"></a>

### 6.1 必须备份 vs 可以不备份

| 必须备份 | 可以不备份（能重建） |
| --- | --- |
| `~/xa/config/`（尤其 `openclaw.json`） | `xa-gateway-oa` 镜像（按 OA 桥接接入手册 4.2 重建） |
| `~/xa/workspace/` | 正在跑的容器 |
| `~/xa/secrets/` | 企微插件（能从 npm 重装）、OA 插件源码（在本仓库与镜像里） |
| `~/xa/docker-compose.yml`、`entrypoint.sh` | — |
| `~/xa/oa-bridge-config.json`（OA 桥接现网配置） | — |
| OA 状态库 `xa_oa`（独立 MySQL 机器，按 [MySQL 数据库准备.md](MySQL%20数据库准备.md) 第 5 节 `mysqldump`） | — |

**不要**把含 `secrets/` 的备份传到公共网盘、不要提交 git。备份文件权限应是 `600`，只放在本机或企业加密盘。

<a id="sec-06-2" name="sec-06-2"></a>

### 6.2 做一次备份

在 Ubuntu：

```bash
BACKUP_DIR="${HOME}/xa-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "${BACKUP_DIR}"

# 停服务再备更稳（staging 附件不再变化）；只备 config/workspace/secrets 时可以不停
cd ~/xa
docker compose stop

tar --exclude='xa/extensions/*/node_modules' \
    --exclude='xa/extensions/*/npm' \
    -czf "${BACKUP_DIR}/xa-${STAMP}.tar.gz" \
    -C "${HOME}" \
    xa/docker-compose.yml \
    xa/entrypoint.sh \
    xa/config \
    xa/workspace \
    xa/secrets \
    xa/oa-bridge-config.json \
    xa/extensions

chmod 600 "${BACKUP_DIR}/xa-${STAMP}.tar.gz"
docker compose start
curl -sS http://127.0.0.1:18789/healthz; echo

ls -lh "${BACKUP_DIR}/xa-${STAMP}.tar.gz"
tar -tzf "${BACKUP_DIR}/xa-${STAMP}.tar.gz" | head
```

OA 状态库在独立 MySQL 上，不在这个 tar 里；按 MySQL 准备文档另做 `mysqldump`。

只备份配置和密钥、不停机（插件源码可从本仓库重拷）：

```bash
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "${HOME}/xa-backups"
tar -czf "${HOME}/xa-backups/xa-config-${STAMP}.tar.gz" \
  -C "${HOME}" xa/docker-compose.yml xa/entrypoint.sh xa/config xa/workspace xa/secrets
chmod 600 "${HOME}/xa-backups/xa-config-${STAMP}.tar.gz"
```

Windows 侧若要把备份拷到 `F:\backup`，用 WSL 路径，不要在资源管理器里对着正在跑的 `~/xa` 直接打包：

```bash
mkdir -p /mnt/f/backup/xa
cp -a "${HOME}/xa-backups/xa-${STAMP}.tar.gz" /mnt/f/backup/xa/
```

<a id="sec-06-3" name="sec-06-3"></a>

### 6.3 恢复

**先停旧容器，再覆盖数据，最后 up。** 恢复会覆盖当前 `~/xa`，先确认你要回到的是哪一份 tar。

```bash
BACKUP_TAR="${HOME}/xa-backups/xa-20260831-090000.tar.gz"   # 换成实际文件名
test -f "${BACKUP_TAR}" || { echo "备份文件不存在"; exit 1; }

cd ~/xa
docker compose down

# 可选：把当前坏掉的目录挪走，而不是直接覆盖
mv "${HOME}/xa" "${HOME}/xa.broken.$(date +%Y%m%d-%H%M%S)"
mkdir -p "${HOME}/xa"

tar -xzf "${BACKUP_TAR}" -C "${HOME}"
sudo chown -R 1000:1000 "${HOME}/xa"
chmod 600 "${HOME}/xa/secrets/"*.txt
chmod 755 "${HOME}/xa/entrypoint.sh"

# OA 插件和依赖在镜像里，不在备份里。换机器 / 镜像丢了时，先在仓库 linux/ 下重建：
#   docker build -f docker/Dockerfile -t xa-gateway-oa:2026.9.2 .
docker images | grep xa-gateway-oa

cd ~/xa
docker compose up -d
sleep 5
docker compose ps
curl -sS http://127.0.0.1:18789/healthz; echo
docker logs --tail 80 --timestamps xa-gateway
```

恢复后必做：

```bash
docker exec -it xa-gateway node dist/index.js config validate
docker exec -it xa-gateway node dist/index.js channels status --channel wecom
docker exec -it xa-gateway node dist/index.js models status
```

再用测试机器人发一条「你是谁」。不要在没验证前把生产 Bot 指回来。

[← 5. 巡检清单](#sec-05) · [↑ 目录](#toc) · [下一节 → 7. 密钥轮换](#sec-07)

---

<a id="sec-07" name="sec-07"></a>

## 7. 密钥轮换

原则与安装手册 6.4.5 相同：**只改 `~/xa/secrets/*.txt`，再 `compose down/up`，不要用 CLI 写真文。**

<a id="sec-07-1" name="sec-07-1"></a>

### 7.1 各密钥怎么轮

| 文件 | 环境变量 | 新值怎么来 | 轮完还要做什么 |
| --- | --- | --- | --- |
| `gateway_token.txt` | `OPENCLAW_GATEWAY_TOKEN` | 见下方 openssl | 用新 token 打开 Dashboard |
| `wecom_bot_id.txt` / `wecom_bot_secret.txt` | `XA_IT_WECOM_*` | 企微管理后台重置 | 测收发；旧 Secret 会失效 |
| `model_api_key.txt` | `XA_DOMESTIC_API_KEY` | 百炼控制台禁用旧 Key、建新 Key | 发一条对话；看是否 401 |
| `model_base_url.txt` 等 | `XA_DOMESTIC_*` | 按百炼指南改 | `docker logs` 里 `agent model` 仍正确 |
| `oa_mysql_password.txt` | `OA_MYSQL_PASSWORD` | DBA 在 MySQL 上改该账号密码 | 先在 MySQL 改密码，再改本文件并 `down && up` Gateway |
| `oa_api_user_id.txt` | `OA_API_USER_ID` | OA 管理端人员资源 ID | **只读预检** Header `userid`；**不是**建单 Header。建单用身份转换得到的申请人。由 `oa-workflow-bridge` 读取 |
| `oa_app_secret.txt` | `OA_APP_SECRET` | OA 控制台轮换 AppSecret | 旧值作废后再测预检 |
| `wecom_identity_corpid.txt` / `wecom_identity_secret.txt` | `WECOM_IDENTITY_*` | 企微自建应用重置 | 与 BotSecret 分开；测 `prepare` 能查到申请人（`oa_identity` 有行） |

生成新 Gateway Token：

```bash
cp -a ~/xa/secrets/gateway_token.txt ~/xa/secrets/gateway_token.txt.bak
openssl rand -base64 32 | tr -d '\n' > ~/xa/secrets/gateway_token.txt
chmod 600 ~/xa/secrets/gateway_token.txt
sudo chown 1000:1000 ~/xa/secrets/gateway_token.txt
```

轮换模型 Key：

```bash
cp -a ~/xa/secrets/model_api_key.txt ~/xa/secrets/model_api_key.txt.bak
printf '%s' '新的APIKey' > ~/xa/secrets/model_api_key.txt
chmod 600 ~/xa/secrets/model_api_key.txt
sudo chown 1000:1000 ~/xa/secrets/model_api_key.txt
```

每一行一个文件，**不要**末尾多空行（`printf '%s'` 不要用 `echo`）。

<a id="sec-07-2" name="sec-07-2"></a>

### 7.2 生效

```bash
cd ~/xa
docker compose down
docker compose up -d
sleep 5
curl -sS http://127.0.0.1:18789/healthz; echo
docker exec xa-gateway sh -c '
  for v in OPENCLAW_GATEWAY_TOKEN XA_IT_WECOM_BOT_ID XA_IT_WECOM_BOT_SECRET \
           XA_DOMESTIC_API_KEY XA_DOMESTIC_BASE_URL XA_DOMESTIC_MODEL_ID \
           XA_DOMESTIC_MODEL_REF XA_DOMESTIC_API; do
    eval "test -n \"\$$v\"" || { echo "MISSING:$v"; exit 1; }
  done
  echo SECRET_INJECT_OK
'
```

`SECRET_INJECT_OK` 只说明变量非空，不打印真值。阶段 A 没有模型 secret 时，把循环里的 `XA_DOMESTIC_*` 删掉。

验证 Dashboard：

```bash
echo "用这个 token 打开 http://localhost:18789/ :"
cat ~/xa/secrets/gateway_token.txt; echo
```

旧 token 应立刻失效。验证通过后再删除 `.bak`：

```bash
rm -f ~/xa/secrets/*.txt.bak
```

轮换失败要回退时：

```bash
mv ~/xa/secrets/gateway_token.txt.bak ~/xa/secrets/gateway_token.txt
# 其他文件同理
cd ~/xa && docker compose down && docker compose up -d
```

[← 6. 备份与恢复](#sec-06) · [↑ 目录](#toc) · [下一节 → 8. 镜像与插件](#sec-08)

---

<a id="sec-08" name="sec-08"></a>

## 8. 镜像与插件：升级、核对、回滚

<a id="sec-08-1" name="sec-08-1"></a>

### 8.1 先看清当前版本

```bash
docker inspect -f '{{.Config.Image}} {{.Image}}' xa-gateway
docker image inspect --format '{{index .RepoDigests 0}} {{.Id}} {{.Created}}' "$(docker inspect -f '{{.Config.Image}}' xa-gateway)"
docker exec -it xa-gateway node dist/index.js --version
docker exec -it xa-gateway node dist/index.js plugins list
```

`image inspect` 的参数必须是本机真实名字（`inspect` 第一段输出）。本机只有 `ghcr.io/openclaw/openclaw:latest` 时，不要写 `openclaw/openclaw:latest`。

把输出（镜像 digest、OpenClaw 版本、企微插件版本）记进变更记录。升级前先做[第 6.2 节](#sec-06-2)备份。

企微插件与 OpenClaw 的版本配对见 `WeCom 通道插件接入手册.md` 第 16 节。摘要：

| OpenClaw | 企微插件 | `sendThinkingMessage` |
| --- | --- | --- |
| ≥ 2026.3.22 | ≥ 2026.3.24 | 初装 `false` |
| ≥ 2026.7.x | **≥ 2026.7.2**（推荐） | 收发稳定后再 `true` |
| 2026.7.1 + 插件 2026.5.7 | 可收发 | **不要**打开思考中占位 |

<a id="sec-08-2" name="sec-08-2"></a>

### 8.2 升级 OpenClaw 镜像

现网跑的是自建镜像 `xa-gateway-oa`。升级 OpenClaw = 改仓库 `docker/Dockerfile` 的 `FROM`（或 `--build-arg OPENCLAW_IMAGE=`）、换一个新 tag 重新构建、改 compose 的 `image:`，再按下面第 4 步起切换；旧 tag 留着就是回滚点。下面 `docker compose pull` 那一步对自建镜像不适用。

```bash
cd ~/xa

# 1. 备份
# （执行第 6.2 节）

# 2. 记下旧镜像
docker inspect -f '{{.Image}}' xa-gateway > /tmp/xa-gateway-image-before.txt
cat /tmp/xa-gateway-image-before.txt

# 3. 拉新镜像（compose 的 image: 须与正在用的仓库名一致；混用 Docker Hub 名和 ghcr 名会拉错源）
docker compose pull
# 拉不动时用安装手册第 7 节方案 A（GHCR 后 tag）或方案 B（dockerd 代理）

# 4. 切换
docker compose down
docker compose up -d
sleep 8

# 5. 验证
curl -sS http://127.0.0.1:18789/healthz; echo
docker exec -it xa-gateway node dist/index.js --version
docker exec -it xa-gateway node dist/index.js config validate
docker exec -it xa-gateway node dist/index.js doctor
docker logs --tail 80 --timestamps xa-gateway
```

升级后 schema 报警时，**先备份 json**，再考虑：

```bash
docker exec -it xa-gateway node dist/index.js doctor --fix
```

`--fix` 可能改 `agents.entries` 结构。改完必须再 `config validate`，并用测试消息回归。不要在生产 Bot 上第一次试 `--fix`。

<a id="sec-08-3" name="sec-08-3"></a>

### 8.3 回滚 OpenClaw 镜像

若升级前记下了镜像 ID：

```bash
OLD_IMAGE="$(cat /tmp/xa-gateway-image-before.txt)"
echo "回滚到 ${OLD_IMAGE}"
# tag 目标必须与 yml 的 image: 一致。本机 compose 若写 ghcr.io/openclaw/openclaw:latest，把下一行换成该名。
docker tag "${OLD_IMAGE}" openclaw/openclaw:latest
cd ~/xa
docker compose down
docker compose up -d
curl -sS http://127.0.0.1:18789/healthz; echo
```

更稳妥：每次构建用新 tag（例如 `xa-gateway-oa:2026.9.2`），回滚就是把 compose 的 `image:` 改回旧 tag 再 `down && up`。

配置已被 `doctor --fix` 改坏时：不要只回滚镜像，按[第 6.3 节](#sec-06-3)把 `config/` 一起恢复。

<a id="sec-08-4" name="sec-08-4"></a>

### 8.4 升级企微插件

**命令正文只在** `WeCom 通道插件接入手册.md` **第 16 节**。本节只保留核对与重启。

`plugins update wecom-openclaw-plugin` **不会**把现网 2026.7.1 从 catalog 钉死的 **2026.5.7** 升到 npm 最新。CLI 打出 `up to date (2026.5.7)` 是预期。`docker exec` 的 `Missing env var` 见企微手册 4.1，与版本无关。

要 ≥ 2026.7.2（才能开「思考中」）：按该手册 16.3 用 `npm:@wecom/wecom-openclaw-plugin@<版本> --force --accept-capabilities`，再：

```bash
cd ~/xa
docker compose restart xa-gateway
sleep 5
curl -sS http://127.0.0.1:18789/healthz; echo
docker exec -it xa-gateway node dist/index.js plugins list
docker exec -it xa-gateway node dist/index.js channels status --channel wecom
```

`plugins list` 的 `version` 必须已是目标号。升完先保持 `sendThinkingMessage: false` 测收发，通过后再按企微指南 **7.4** 打开占位。打开后思考中不消失：立刻改回 `false` 并 `docker compose restart xa-gateway`。不要 `doctor --fix`。不要把 `wecom-openclaw-plugin` 写入 `alsoAllow`。

<a id="sec-08-5" name="sec-08-5"></a>

### 8.5 升级后回归（最短路径）

```bash
cd ~/xa
curl -sS http://127.0.0.1:18789/healthz; echo
docker exec -it xa-gateway node dist/index.js config validate
docker exec -it xa-gateway node dist/index.js agents list --bindings
docker exec -it xa-gateway node dist/index.js channels status --channel wecom
docker logs xa-gateway 2>&1 | grep -E 'agent model' | tail -n 5
```

然后用**测试机器人**发「你是谁」，同时：

```bash
docker logs -f --timestamps xa-gateway
```

期望：`model-fetch` 的 200 到 `kind=final` 约 2～5 秒（已按百炼指南关掉隐藏思考），然后 `Reply message sent` + `Reply ack received`。详细延迟见 `DashScope 兼容 Provider 配置手册.md` §5.4 / §6.7。

[← 7. 密钥轮换](#sec-07) · [↑ 目录](#toc) · [下一节 → 9. 配置变更怎么落地](#sec-09)

---

<a id="sec-09" name="sec-09"></a>

## 9. 配置变更怎么落地

| 变更 | 是否要重建容器 | 命令 |
| --- | --- | --- |
| `openclaw.json` 多数业务字段（tools、allowFrom、bindings） | 通常热重载；不生效再重启 | `docker compose restart xa-gateway` |
| `plugins.load.paths`、gateway `port`/`bind` | 要 | `cd ~/xa && docker compose down && docker compose up -d` |
| secret 文件内容 | 要 down/up | 同上 |
| compose / entrypoint | 要 down/up | 同上 |
| workspace 规则文件（`AGENTS.md` 等） | 一般不用重启 | 下一轮对话生效；异常再 restart |
| 扩展目录里新拷插件 | 要 down/up | 先 `sudo chown -R 1000:1000 ~/xa/extensions`，再 `down && up` |
| OA 插件代码 / `systems.json` | 要重建镜像 + down/up | 按 OA 桥接接入手册 **4.2** `docker build`，再 `down && up` |
| `~/xa/oa-bridge-config.json` | 要 down/up | 只读挂载，不必重建镜像 |

改完 json 先校验再重启：

```bash
docker exec -it \
  -e OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < ~/xa/secrets/gateway_token.txt)" \
  xa-gateway node dist/index.js config validate
cd ~/xa && docker compose restart xa-gateway
```

**禁止：** 在该容器里跑 `onboard` / `setup`；用 `config set` 把 `${XA_DOMESTIC_BASE_URL}` 等占位符覆盖成明文。见安装手册 8.3、8.4。

若 Control UI 曾写出 `~/xa/config/agents/itservicedeskagent/agent/models.json`（可能含明文 Key）：

```bash
ls -l ~/xa/config/agents/itservicedeskagent/agent/models.json
# 确认后删除，只保留 openclaw.json + secrets
rm -f ~/xa/config/agents/itservicedeskagent/agent/models.json
cd ~/xa && docker compose restart xa-gateway
```

[← 8. 镜像与插件](#sec-08) · [↑ 目录](#toc) · [下一节 → 10. 资源、磁盘、WSL 虚拟盘](#sec-10)

---

<a id="part-host" name="part-host"></a>

## 宿主与资源

容器资源、Docker 磁盘、WSL 虚拟盘、inbound 原件回收，以及开机/睡眠/熔断自愈。Linux 服务器跳过 WSL 专属小节。

<a id="sec-10" name="sec-10"></a>

## 10. 资源、磁盘、WSL 虚拟盘

<a id="sec-10-1" name="sec-10-1"></a>

### 10.1 容器资源

```bash
docker stats --no-stream
docker stats --no-stream xa-gateway

# 宿主机（WSL）内存与磁盘
free -h
df -h
df -h ~/xa
du -sh ~/xa ~/xa/config ~/xa/workspace ~/xa/extensions ~/xa/secrets
du -sh ~/xa/workspace/* 2>/dev/null | sort -h | tail -n 20
```

当前 compose **没有** `mem_limit` / `cpus`。WSL 默认可能吃掉大量 Windows 内存。建议在 Windows 用户目录创建 `.wslconfig`（不是 Ubuntu 里的 `/etc/wsl.conf`）。

在 **Windows PowerShell** 查看/编辑（按你的内存改数字；下面是 32GB 机器的示例）：

```powershell
notepad "$env:USERPROFILE\.wslconfig"
```

示例内容：

```ini
[wsl2]
memory=8GB
processors=4
swap=4GB
localhostForwarding=true
```

改完后在 PowerShell 执行，再重开 Ubuntu：

```powershell
wsl --shutdown
```

```bash
cd ~/xa && docker compose up -d
```

容器限额见[第 13.3 节](#sec-13-3)。加限额后若 Gateway 被 OOM 杀掉：

```bash
docker inspect -f '{{.State.OOMKilled}} {{.State.ExitCode}}' xa-gateway
dmesg -T 2>/dev/null | grep -i -E 'oom|killed process' | tail
```

把限额调大，或先查是不是日志/会话把内存打满。

<a id="sec-10-2" name="sec-10-2"></a>

### 10.2 Docker 磁盘清理（先看再删）

```bash
docker system df
docker images
docker ps -a
docker volume ls
```

只删悬空镜像（没有 tag、没有容器在用）：

```bash
docker image prune -f
```

删已停止容器、悬空镜像、无用网络（**不会**删 `~/xa` 绑定挂载里的文件）：

```bash
docker system prune -f
```

**不要**日常执行 `docker system prune -a --volumes`：会删掉未在跑的镜像和未挂到当前容器的 volume。若曾把数据改用命名卷，有丢数据风险。

<a id="sec-10-3" name="sec-10-3"></a>

### 10.3 WSL2 VHDX 把 Windows 盘吃满

发行版虚拟盘在 Windows 上，常见路径类似：

```text
E:\WSL\Ubuntu-24.04\...vhdx
```

在 **管理员 PowerShell** 查看体积：

```powershell
Get-ChildItem -Recurse -Filter *.vhdx E:\WSL\Ubuntu-24.04 | Select-Object FullName, Length, LastWriteTime
```

先在 Ubuntu 里删大文件、`docker image prune`，再压缩（**先 `wsl --shutdown`**）：

```powershell
wsl --shutdown
wsl --manage Ubuntu-24.04 --set-sparse true
Optimize-VHD -Path "E:\WSL\Ubuntu-24.04\ext4.vhdx" -Mode Full
```

`Optimize-VHD` 需要 Hyper-V 模块。没有该命令时，用磁盘管理工具压缩，或把路径换成 `wsl -l -v` 对应发行版实际 vhdx。压缩不是备份，做之前仍建议[第 6.2 节](#sec-06-2)先打包 `~/xa`。

工作区若在 `/mnt/c` 会又慢又容易权限错。确认不在 Windows 盘上：

```bash
df -h ~/xa
readlink -f ~/xa
# 期望类似 /home/YOUR_LINUX_USER/xa ，不要是 /mnt/c/... 或 /mnt/e/...
```

<a id="sec-10-4" name="sec-10-4"></a>

### 10.4 inbound 原件满 24 小时回收（cron）

插件提交后只删 staging 副本，**不删**通道原件。人一多，下面**两处**都会涨（compose 是两套挂载，不是同一目录）：

| 宿主机 | 容器内 | 作用 |
| --- | --- | --- |
| `~/xa/config/media/inbound` | `/home/node/.openclaw/media/inbound` | 桥接允许根之一（`stateDir/media/inbound`） |
| `~/xa/workspace/media/inbound` | `/home/node/.openclaw/workspace/media/inbound` | 通道落盘；桥接同样允许拷进 staging。模型禁止 `read` |

待确认窗口默认 24 小时；插件收到附件时已拷进自己的 staging，不再回读原件，但为稳妥仍只删满 24 小时的原件。因此只删 **满 1440 分钟** 的文件。用 `-mmin +1440`，不要用 `-mtime +1`（GNU find 常变成满两天才匹配）。

先确认是两份还是符号链接：

```bash
ls -ld ~/xa/config/media/inbound ~/xa/workspace/media/inbound
readlink -f ~/xa/config/media/inbound
readlink -f ~/xa/workspace/media/inbound
du -sh ~/xa/config/media/inbound ~/xa/workspace/media/inbound
```

`readlink -f` 不同就要两处都清。先干跑（只列出、不删除）：

```bash
find ~/xa/config/media/inbound ~/xa/workspace/media/inbound \
  -type f -mmin +1440 -ls
```

列表里不得出现 `staging`、`sessions`、`AGENTS.md`。

装脚本（跑 Gateway 的同一 Linux 用户，不要 root）：

```bash
mkdir -p ~/xa/scripts ~/xa/logs
```

`~/xa/scripts/prune-inbound.sh`：

```bash
#!/bin/sh
set -eu

LOG="${HOME}/xa/logs/inbound-prune.log"
LOCK="${HOME}/xa/logs/inbound-prune.lock"

DIRS="
${HOME}/xa/config/media/inbound
${HOME}/xa/workspace/media/inbound
"

ts() { TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S'; }
mkdir -p "$(dirname "$LOG")"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(ts) SKIP already running" >> "$LOG"
  exit 0
fi

total=0
for dir in $DIRS; do
  [ -d "$dir" ] || { echo "$(ts) SKIP missing $dir" >> "$LOG"; continue; }
  n=$(find "$dir" -type f -mmin +1440 -print -delete | wc -l)
  find "$dir" -mindepth 1 -type d -empty -delete 2>/dev/null || true
  bytes=$(du -sb "$dir" 2>/dev/null | awk '{print $1}')
  echo "$(ts) dir=$dir deleted_files=$n remain_bytes=${bytes:-0}" >> "$LOG"
  total=$((total + n))
done
echo "$(ts) done total_deleted=$total" >> "$LOG"
```

日志时间固定为 **北京时间**（`Asia/Shanghai`），格式如 `2026-09-16 03:15:01`。不要用 `date -Is`（会打出 `2026-09-16T03:15:01+08:00`，不好对表）。

用 nano 写入上面全文。已有脚本时不要整份跳过：打开后只把 `ts()` 换成上面这一行即可。

```bash
nano ~/xa/scripts/prune-inbound.sh
```

粘贴脚本（或只改 `ts()`）→ `Ctrl+O` → 回车 → `Ctrl+X`。然后：

```bash
chmod 700 ~/xa/scripts/prune-inbound.sh
~/xa/scripts/prune-inbound.sh
tail -n 5 ~/xa/logs/inbound-prune.log
```

这一步是**马上清一次**。要每天自动跑，必须再写入当前用户的 crontab（下面 [10.4.1](#sec-10-4-1)）。脚本在、crontab 没有，第二天不会自己删。

<a id="sec-10-4-1" name="sec-10-4-1"></a>

#### 10.4.1 写入当前用户 crontab

在 **Ubuntu 终端**操作（WSL 里打开 Ubuntu，或 SmartX 虚机 SSH）。不要用 Windows PowerShell 跑 `crontab`。

**1. 拼出这一台机器的完整命令行**（不要手写「你的用户名」）：

```bash
whoami
echo "$HOME"
ls -l "$HOME/xa/scripts/prune-inbound.sh"
echo "15 3 * * * $HOME/xa/scripts/prune-inbound.sh"
timedatectl | grep Time
```

`ls` 必须能看到脚本。最后一条 `echo` 的输出整行复制，例如用户是 `lijinjin` 时是：

```text
15 3 * * * /home/lijinjin/xa/scripts/prune-inbound.sh
```

`15 3 * * *` 表示每天 **03:15**（上面 `timedatectl` 的时区）。工位 WSL 与 SmartX 虚机是两台机器，crontab **不会**互相同步，要在跑 Gateway 的那台各写一次。

**2. 看有没有写过：**

```bash
crontab -l
```

已有上面那一行（路径对应当前 `$HOME`）就不用再改。提示 `no crontab for …` 或没有 `prune-inbound.sh` 这一行，继续第 3 步。

**3. 编辑：**

```bash
crontab -e
```

第一次会问 `Select an editor`：输入 **`1`** 选 nano，回车。把第 1 步复制的那一行贴到文件末尾（单独占一行）。保存退出：

1. `Ctrl+O`（写出）
2. 回车（确认文件名）
3. `Ctrl+X`（退出）

成功时终端出现 `crontab: installing new crontab`。

**4. 再读一遍：**

```bash
crontab -l
systemctl is-active cron
```

`crontab -l` 必须出现第 1 步那一行。`cron` 为 `active`。不是 `active` 时：`sudo systemctl enable --now cron`（有的发行版服务名是 `crond`）。

crontab 只是预约，**不会立刻删文件**。现在再清一次仍用：

```bash
"$HOME/xa/scripts/prune-inbound.sh"
```

第二天看日志里是否有约 03:15 的 `done total_deleted=`（数字可为 0）：

```bash
tail -n 20 ~/xa/logs/inbound-prune.log
```

工位 WSL：03:15 时电脑休眠或没开 Ubuntu，这次会错过，下次开机后要等再一个 03:15。SmartX 虚机保持开机则按点跑。

不要：`rm -rf ~/xa/workspace`；对工作区根目录 `find`；手删 `oa-workflow-bridge/staging/`（未提交副本，插件 GC）；为腾盘删 `oa_ticket` 台账。已进 OA 的附件在 Ecology，清 inbound 原件不影响已提交工单。

[← 9. 配置变更怎么落地](#sec-09) · [↑ 目录](#toc) · [下一节 → 11. 开机、睡眠、自愈](#sec-11)

---

<a id="sec-11" name="sec-11"></a>

## 11. 开机、睡眠、自愈

<a id="sec-11-1" name="sec-11-1"></a>

### 11.1 正常预期

| 层 | 谁负责起来 |
| --- | --- |
| WSL2 | 打开 Ubuntu 或 `wsl -d Ubuntu-24.04`；Windows 重启后不会一直挂着，除非另做任务计划 |
| systemd + dockerd | `/etc/wsl.conf` 里 `systemd=true`，且 `sudo systemctl enable docker` |
| 容器 | compose 里 `restart: unless-stopped` |

重开 Ubuntu 后容器没起来：

```bash
systemctl is-active docker
sudo systemctl start docker
cd ~/xa && docker compose up -d
docker compose ps
curl -sS http://127.0.0.1:18789/healthz; echo
```

<a id="sec-11-2" name="sec-11-2"></a>

### 11.2 Windows 重启后自动拉起（可选）

WSL 不会在你没登录、没碰 WSL 时保证一直跑。需要开机就服务时，用**任务计划程序**在登录后跑：

```powershell
wsl -d Ubuntu-24.04 -- bash -lc 'sudo systemctl start docker; cd "$HOME/xa" && docker compose up -d'
```

把上面这条做成「用户登录时」触发的计划任务。`docker` 组用户对 `systemctl start docker` 若要密码，改成已 enable 的 docker 在 systemd 下自动起，计划任务只执行 `docker compose up -d`。

<a id="sec-11-3" name="sec-11-3"></a>

### 11.3 睡眠 / 休眠之后

Windows 睡眠常导致 WSL 网络或时钟异常，企微 WebSocket 看起来「还在」但不再 inbound。

```bash
timedatectl status
date -u
cd ~/xa
docker compose restart xa-gateway
sleep 5
curl -sS http://127.0.0.1:18789/healthz; echo
docker logs --since 2m xa-gateway 2>&1 | grep -Ei 'wecom|Authentication|listening'
```

仍无 inbound：`docker compose down && docker compose up -d`。长期挂生产时，这台 PC **不要睡**，或迁到不休眠的 Linux 服务器（选型指南 5.5）。

<a id="sec-11-4" name="sec-11-4"></a>

### 11.4 crash-loop breaker

日志出现：

```text
restart-loop breaker tripped
[wecom] channel autostart suppressed
Use channels.start to override
```

含义（官方 [Restart recovery](https://docs.openclaw.ai/gateway/restart-recovery)）：5 分钟内多次不洁启动后，**控制面仍会起来**（`/healthz`、`ready`），但通道/Provider 账号不自动拉。根因（json / secret / 插件路径）必须先修好。

Gateway 已经是 `Up` 时，**不要**再 `compose restart`，也不要用 `channels start --channel wecom`（`--channel` 是 `status` / `add` / `login` 的 flag，熔断覆盖不是这条）。官方覆盖是 Gateway RPC `channels.start`：

```bash
docker exec -it \
  -e OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < ~/xa/secrets/gateway_token.txt)" \
  xa-gateway node dist/index.js gateway call channels.start \
  --params '{"channel":"wecom"}'
```

默认账号可省略 `accountId`；需要指定时用 `'{"channel":"wecom","accountId":"default"}'`。`docker exec` 不跑 entrypoint，必须 `-e` 注入 token（需要 `operator.admin`）。其它 `XA_*` 缺失警告可忽略，以主进程日志为准。

核对：

```bash
docker exec -it \
  -e OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < ~/xa/secrets/gateway_token.txt)" \
  xa-gateway node dist/index.js channels status --channel wecom --probe
docker logs --since 2m xa-gateway 2>&1 | grep -Ei 'wecom|Authentication'
```

期望：`enabled, configured, running, works`，以及 `Authentication successful`。`started: true` 只表示运行时 `running`，不等于企微已连上。

也可以什么都不做：同一进程保持 `ready` **约 5 分钟**（不洁启动窗口过完）后会自己拉被压住的通道，不必再重启。

只在修好配置、容器仍 `Restarting` 时才：

```bash
cd ~/xa
docker compose down
docker compose up -d
docker compose logs -f xa-gateway
```

[← 10. 资源、磁盘、WSL 虚拟盘](#sec-10) · [↑ 目录](#toc) · [下一节 → 12. 三层排障与应急](#sec-12)

---

<a id="part-troubleshoot" name="part-troubleshoot"></a>

## 排障与硬化

先定位 Windows / WSL、Docker、OpenClaw 哪一层，再对号入座。应急完整命令在 [12.4](#sec-12-4)。

<a id="sec-12" name="sec-12"></a>

## 12. 三层排障与应急

先定位在哪一层，再对号入座。

```text
Windows  ←→  WSL2 Ubuntu  ←→  dockerd / 容器  ←→  OpenClaw / 企微 / 百炼
```

<a id="sec-12-1" name="sec-12-1"></a>

### 12.1 层 1：Windows / WSL

| 现象 | 命令（PowerShell） | 处理 |
| --- | --- | --- |
| `wsl -l -v` 没有发行版 | `wsl -l -v` | 回安装手册第 1 节重装，不要在本手册里「修容器」 |
| VERSION 是 1 | `wsl --set-version Ubuntu-24.04 2` | 转成 WSL2 后 `wsl --shutdown` 再进 |
| 进不了 Ubuntu | `wsl --shutdown` 后重开 | 仍失败看 Windows 功能 VirtualMachinePlatform |
| 睡眠后全挂 | `wsl -d Ubuntu-24.04 -- echo ok` | [第 11.3 节](#sec-11-3)重启 Gateway |
| Windows 能开 Dashboard、WSL 内 curl 失败 | 在 Ubuntu 跑[第 3.3 节](#sec-03-3) | 查容器是否在听 `lan`；`gateway.bind` 不能写 IP |

WSL 里看 Windows 主机 IP（NAT 模式，给 dockerd 配代理用）：

```bash
grep nameserver /etc/resolv.conf
```

Windows 开了 VPN **不等于** WSL 里的 dockerd 走 VPN。拉镜像失败用安装手册第 7 节方案 A/B。

<a id="sec-12-2" name="sec-12-2"></a>

### 12.2 层 2：Docker 守护进程与容器

| 现象 | 命令 | 处理 |
| --- | --- | --- |
| `Cannot connect to the Docker daemon` | `systemctl is-active docker` | `sudo systemctl start docker`；组权限：`groups` 含 `docker`，否则 `wsl --shutdown` 后重进 |
| 容器 `Restarting` (78) | `docker logs --tail 120 xa-gateway` | 按日志修 json（删 `meta`、去 wecom、补 `name`、OA 路径改成 `/opt/xa/oa-workflow-bridge`），再 `down && up` |
| `docker exec` 进不去 | `docker compose ps` | 先让容器 `Up`，不要在 Restarting 时 exec |
| 权限 denied 挂载目录 | `ls -ln ~/xa` | `sudo chown -R 1000:1000 ~/xa` |
| 读 `/run/secrets` Permission denied | `stat ~/xa/secrets/*` | 适当放宽文件「其他用户可读」，或核对 `user: "1000:1000"` |
| 端口占用 | `ss -lnt \| grep 18789` | 停掉另一套占用 18789 的 compose，或改宿主端口 |

干净拉起（不删数据目录）：

```bash
cd ~/xa
docker compose down
docker compose up -d
docker compose ps
docker logs --tail 80 --timestamps xa-gateway
```

<a id="sec-12-3" name="sec-12-3"></a>

### 12.3 层 3：OpenClaw / 企微 / 模型

| 现象 | 先跑 | 处理文档 |
| --- | --- | --- |
| `/healthz` 不通但容器 Up | [第 3.3](#sec-03-3)、[3.5](#sec-03-5) 节 | `bind` 必须是 `lan`；entrypoint 与 json 一致 |
| `meta: Invalid input` | `grep -n meta ~/xa/config/openclaw.json` | 安装手册 5.0，只删 `handoffTemplate` 等非法键 |
| `plugin path not found` / `unknown channel id: wecom` | `ls ~/xa/extensions` | 安装手册 5.5 或企微指南 |
| `plugin path not found: .../oa-workflow-bridge-redis` 或 `/opt/xa/oa-workflow-bridge` | `docker inspect -f '{{.Config.Image}}' xa-gateway` | 镜像须是 `xa-gateway-oa`；`load.paths` 只写 `/opt/xa/oa-workflow-bridge`（OA 桥接接入手册 5.1）；旧 id `oa-workflow-bridge-redis` / `wecom-oa-identity-adapter` 不要留 |
| Gateway Up 但 `autostart suppressed` | [第 3.5 节](#sec-03-5)日志 | **[第 11.4 节](#sec-11-4)** RPC 覆盖或等 5 分钟；不要 `channels start --channel` |
| 企微收不到 | [第 3.4 节](#sec-03-4) channels + [第 4.2 节](#sec-04-2) wecom grep | 企微指南第 13 节；`allowFrom` 测试环境含 `"*"` |
| 发出去很久才回 | [第 4.2 节](#sec-04-2) `model-fetch` / `kind=final` | 百炼指南 §2.4、§6.7；企微指南 7.4 |
| `Unknown model` / unresolved | `cat ~/xa/secrets/model_ref.txt; echo` | 前缀必须等于 json 里 `providers` 键名 |
| `docker exec` 报 Missing env var | — | 可忽略，或用[第 3.4 节](#sec-03-4)带 `-e` 的命令 |
| OA 预检失败 | 见下方 | `DB_UNAVAILABLE` / `DB_SCHEMA_MISSING` 查 MySQL；其余是 OA 凭据或依赖，见 OA 桥接接入手册 8.2 / 10 |
| 员工「确认准备失败」/ 日志 `Cannot find package 'mysql2'` 或 `MySQL init failed` | `docker inspect -f '{{.Config.Image}}' xa-gateway` | 缺包说明没用自建镜像，按 OA 桥接接入手册 4.2 重建；连库失败按该手册第 10 节，再 `down && up` |
| docker logs 出现 `smartsheet_get_records` | `grep alsoAllow ~/xa/config/openclaw.json` | WeCom 手册 9.2；现网旁路已清。不要为 OA 去重新授权文档 |
| 员工「还不能提交到 OA」/ `OA_IDENTITY_NOT_CONFIGURED` | `docker logs` grep 不到该码是预期 | 企微到OA身份 9.9 节：先看 `WECOM_IDENTITY_FILES_OK` / `INJECTED`，再抽会话 jsonl |
| 员工「OA 需要人工核对」/ `RECONCILIATION_REQUIRED` | `oa_ticket.status` 为 `unknown` 或卡在 `submitting` | **[第 12.5 节](#sec-12-5)** 对账；禁止再点确认 |

OA 只读预检（**不会建单**）：

```bash
docker exec -it xa-gateway sh -c 'export OA_MYSQL_PASSWORD="$(tr -d "\n" < /run/secrets/oa_mysql_password)" OA_API_USER_ID="$(tr -d "\n" < /run/secrets/oa_api_user_id)" OA_APP_SECRET="$(tr -d "\n" < /run/secrets/oa_app_secret)"; node /opt/xa/oa-workflow-bridge/scripts/readonly-preflight.mjs'
```

规则包已把 `oa_workflow` 加入 `tools.alsoAllow`（全局与 Agent 两处须一致），**不要**加入 `wecom_mcp`。现网是否调用 `doCreateRequest` 看实际加载的 `bridge-config.json`；接入核对见 OA 桥接接入手册第 5 / 8 节。不要移出白名单。不要把 `OA_BRIDGE_INACTIVE` 当成已建单。员工「确认准备失败」时，若日志有 `Cannot find package 'mysql2'` / `MySQL init failed` 再按 OA 桥接接入手册 4.2（重建镜像）/ 第 10 节处理；不要先当 OA 接口故障。

<a id="sec-12-4" name="sec-12-4"></a>

### 12.4 应急速查（按现象给完整命令）

<a id="sec-12-4-a" name="sec-12-4-a"></a>

#### A. 容器在 Restarting

```bash
cd ~/xa
docker compose ps -a
docker logs --tail 200 --timestamps xa-gateway
docker compose down
# 按日志改 ~/xa/config/openclaw.json 后：
docker compose up -d
docker compose ps
docker logs --tail 80 --timestamps xa-gateway
```

日志是 `plugin path not found: .../oa-workflow-bridge-redis`：json 的 allow / entries 改成 `oa-workflow-bridge`、paths 改成 `/opt/xa/oa-workflow-bridge`（见 OA 桥接接入手册 5.1），确认 compose 用 `xa-gateway-oa` 镜像，再 `up -d`。`Restarting` 时不要 `docker exec`。

<a id="sec-12-4-b" name="sec-12-4-b"></a>

#### B. 企微突然不回（容器仍 Up）

```bash
curl -sS http://127.0.0.1:18789/healthz; echo
docker logs --since 30m xa-gateway 2>&1 | grep -Ei 'wecom|breaker|inbound|Authentication|error'
```

有 `autostart suppressed`：走 **[第 11.4 节](#sec-11-4)** RPC，不要 `compose restart`。没有熔断再重启：

```bash
cd ~/xa
docker compose restart xa-gateway
sleep 5
docker exec -it \
  -e OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < ~/xa/secrets/gateway_token.txt)" \
  xa-gateway node dist/index.js channels status --channel wecom --probe
```

仍无 inbound：`down && up`，并确认没有第二套容器抢同一个 Bot：

```bash
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'xa|18789|18790'
```

<a id="sec-12-4-c" name="sec-12-4-c"></a>

#### C. 很慢

```bash
docker logs -f --timestamps xa-gateway
```

看时间线：inbound → `[model-fetch] response elapsedMs=` → `kind=final` → `Reply message sent`。`[model-fetch] start` 应带 `timeoutMs=20000`。发图后若出现数秒级 `apply_media_understanding`，按百炼指南 §4.2 关掉 `tools.media` 并把 catalog `input` 收成 `["text"]`。首包到终包超过约 8 秒，按百炼指南补 `compat.thinkingFormat: "qwen"` 和 `MEMORY.md`。通道正常但客户端一直空白，按企微指南 7.4 开「思考中」（插件 ≥ 2026.7.2）。

<a id="sec-12-4-d" name="sec-12-4-d"></a>

#### D. 磁盘满

```bash
df -h
docker system df
du -sh ~/xa/* | sort -h
sudo ls -lh "$(docker inspect -f '{{.LogPath}}' xa-gateway)"
```

先按[第 4.4](#sec-04-4) / [10.2](#sec-10-2) 节处理容器日志和悬空镜像。容器日志已轮转；盘仍满多半是会话 jsonl 或两处 `media/inbound`。inbound 走[第 10.4 节](#sec-10-4) cron（满 24 小时），不要手删、不要删 ledger。再按[第 10.3 节](#sec-10-3)考虑 VHDX。不要删整个 `~/xa/workspace` 或 `redis-data` 来腾地方。

<a id="sec-12-4-e" name="sec-12-4-e"></a>

#### E. 误执行了 prune / down -v

`docker compose down` **默认不删** 绑定挂载的 `~/xa/config` 等。`down -v` 会删 **compose 声明的 named volume**。当前安装手册用的是绑定挂载，一般还在；若改成 named volume，先看有没有备份。有备份走[第 6.3 节](#sec-06-3)。没有备份不要再 `prune --volumes`。

<a id="sec-12-5" name="sec-12-5"></a>

### 12.5 OA 结果不明（unknown）对账

员工看到「OA 需要人工核对」，或工具回执 `RECONCILIATION_REQUIRED`。插件已经锁死：不能再确认、不能取消、不能开新单。这是故意的——超时 / 5xx / 成功但没数字单号时，OA 里可能已经有单，也可能没有。**禁止**让员工再点确认，**禁止**自动 `submit_confirmed`。

OA 明确拒绝（`failed` / `OA_CREATE_REJECTED`）不是这条：那张确认单已经结束，员工改稿后直接报新问题即可。不要把拒绝和对账混成一步。

契约与错误码以 [OA Workflow Bridge 接入手册.md](OA_tool/OA%20Workflow%20Bridge%20接入手册.md) **2.2 / 7.5 / 8.3** 为准。下面只写值班动作。所有 SQL 在能连 OA 状态库（独立 MySQL）的机器上执行，用有写权限的账号。

#### 1. 查库（按确认号点查）

确认号从当轮会话 jsonl 或员工刚收到的失败回执里取（`confirmationId`，形如 `OA-…`）。

```sql
SELECT confirmation_id, external_ticket_id, status, request_id, error_code, oa_requester_id,
       FROM_UNIXTIME(created_at / 1000) AS created, FROM_UNIXTIME(updated_at / 1000) AS updated
  FROM xa_oa.oa_ticket WHERE confirmation_id = 'OA-把确认号贴这里';

-- 当前所有待对账
SELECT confirmation_id, external_ticket_id, request_id, error_code, FROM_UNIXTIME(updated_at / 1000)
  FROM xa_oa.oa_ticket WHERE status IN ('unknown', 'submitting');
```

`status` 是 `unknown`（或 Gateway 崩溃时卡住的 `submitting`）才走本节。`request_id` 有值说明 OA 已建单、只是本地没记上。

#### 2. 对 Ecology

用 `oa_requester_id`（申请人人员 id）、`created` 时间、流程 **602**、标题前缀 `[IT-…]`（即 `external_ticket_id`），看有没有**数字** `requestId`。有单以 OA 为准，不要再打 `doCreateRequest`。

#### 3. 有单：收成已提交

```sql
UPDATE xa_oa.oa_ticket
   SET status = 'submitted', request_id = '数字单号', active_sender = NULL,
       draft_json = NULL, staged_json = NULL, updated_at = UNIX_TIMESTAMP() * 1000
 WHERE confirmation_id = 'OA-…' AND status IN ('unknown', 'submitting');
```

改完告诉员工数字工单号；`active_sender = NULL` 后这个人可以再报新问题，旧确认号再查得到 `ALREADY_SUBMITTED`。

#### 4. 没单：放人重填

```sql
UPDATE xa_oa.oa_ticket
   SET status = 'failed', error_code = 'RECONCILED_NOT_IN_OA', active_sender = NULL,
       draft_json = NULL, staged_json = NULL, updated_at = UNIX_TIMESTAMP() * 1000
 WHERE confirmation_id = 'OA-…' AND status IN ('unknown', 'submitting');
```

同一确认号再确认得到 `OA_CREATE_REJECTED`，不会再打 OA。让员工重新说明问题后 `prepare` 新单。本机 staging 目录会被插件定时回收。

#### 禁止

- 让员工对旧确认号再点「确认提交」
- 删 `oa_ticket` 行、改 `external_ticket_id`、批量 `UPDATE` 不带 `confirmation_id` 条件
- 把 `unknown` 当成 `failed` 却不去 OA 核对（OA 里可能已经有单）
- 改状态时忘了 `active_sender = NULL`（这个人会一直开不了新单）

Gateway 在「正在提交」时崩溃、库里停在 `submitting`，也走本节，不要 `compose restart` 当重试。

[← 12.4 应急速查](#sec-12-4) · [↑ 目录](#toc) · [下一节 → 13. 建议补进 compose 的运维项](#sec-13)

---

<a id="sec-13" name="sec-13"></a>

## 13. 建议补进 compose 的运维项

日志轮转已写入现网与安装手册默认 yml（[第 13.2 节](#sec-13-2)）。下面 **[13.1](#sec-13-1) / [13.3](#sec-13-3) / [13.4](#sec-13-4)** 仍须改 yml 才生效。改完必须 `cd ~/xa && docker compose down && docker compose up -d`。先备份 yml。

<a id="sec-13-1" name="sec-13-1"></a>

### 13.1 Gateway 健康检查

加了 `healthcheck` 后，`docker compose ps` 才能出现 `healthy`。

```yaml
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "node -e \"require('http').get('http://127.0.0.1:18789/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\"",
        ]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 40s
```

容器内若没有 `curl`，用上面的 `node` 探测，不要写 `curl`。`bind: lan` 时 `127.0.0.1` 仍可用（Gateway 在容器内本机监听）。

加完后检查：

```bash
cd ~/xa
docker compose down
docker compose up -d
sleep 20
docker inspect -f '{{.State.Health.Status}}' xa-gateway
docker compose ps
```

期望 `healthy`。一直 `starting`：看 `docker inspect xa-gateway --format '{{json .State.Health}}'` 和启动是否慢于 `start_period`。

<a id="sec-13-2" name="sec-13-2"></a>

### 13.2 日志轮转（现网已加）

Gateway 服务下已挂：

```yaml
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"
```

数字按磁盘改。验收与应急见[第 4.4 节](#sec-04-4)。

<a id="sec-13-3" name="sec-13-3"></a>

### 13.3 资源上限（按机器改数字）

```yaml
    mem_limit: 2g
    memswap_limit: 2g
    cpus: "2.0"
```

先用[第 10.1 节](#sec-10-1) `docker stats` 看实际用量再设。设太小会 OOM，Gateway 看起来像无故重启。

<a id="sec-13-4" name="sec-13-4"></a>

### 13.4 钉住镜像版本（可选）

```yaml
    image: openclaw/openclaw:2026.7.1
```

或：

```yaml
    image: openclaw/openclaw@sha256:把第8.1节看到的digest写在这里
```

改 tag 后 `docker compose pull && docker compose up -d`。回滚改回旧 tag 再 `up -d`。

[← 12. 三层排障与应急](#sec-12) · [↑ 目录](#toc) · [下一节 → 14. 多套环境时注意](#sec-14)

---

<a id="sec-14" name="sec-14"></a>

## 14. 多套环境时注意

```bash
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

| 约束 | 命令上怎么体现 |
| --- | --- |
| 同一企微 Bot 只能一个 Gateway | 不要同时 `up` 两套挂了同一 `wecom_bot_*.txt` 的目录 |
| 每套独立目录 | `cd ~/xa` 与 `cd ~/xa-hr` 分别操作，不要串 compose 文件 |
| 端口 | IT `18789`，HR `18790`，测试 `18791` |
| MySQL 共用 | 每套用不同库（`mysql.database`）和账号 |

第二套日常命令示例：

```bash
cd ~/xa-hr
docker compose ps
curl -sS http://127.0.0.1:18790/healthz; echo
docker logs --tail 80 --timestamps xa-hr-gateway
docker exec -it xa-hr-gateway node dist/index.js gateway status --deep
```

[← 13. 建议补进 compose 的运维项](#sec-13) · [↑ 目录](#toc) · [下一节 → 15. 安全运维](#sec-15)

---

<a id="sec-15" name="sec-15"></a>

## 15. 安全运维（装完之后仍要做）

```bash
# secret 权限
chmod 600 ~/xa/secrets/*.txt
sudo chown 1000:1000 ~/xa/secrets/*.txt
stat -c '%a %U %G %n' ~/xa/secrets/*.txt

# json 里不应出现明文 Key / 完整 URL（占位符 ${VAR} 除外）
grep -nE 'sk-|apiKey.: ."([^$]|https://)' ~/xa/config/openclaw.json || echo "openclaw.json 未扫到明文 apiKey"

# 监听范围：容器内应是 lan，不要把 18789 映射到公网
docker port xa-gateway
ss -lnt | grep 18789
```

Windows 防火墙：若必须让局域网访问 `18789`，只放行可信网段。`gateway.bind` 为 `lan` 时，token 必须是强随机值（安装手册用 `openssl rand -base64 32`）。

测试环境用测试机器人，不要把生产 BotSecret 放进 `~/xa-staging`。

[← 14. 多套环境时注意](#sec-14) · [↑ 目录](#toc) · [下一节 → 16. 打印用巡检表](#sec-16)

---

<a id="part-appendix" name="part-appendix"></a>

## 附录

打印勾选表、专题文档入口。

<a id="sec-16" name="sec-16"></a>

## 16. 打印用巡检表

<a id="sec-16-1" name="sec-16-1"></a>

### 16.1 每日

| 步 | 操作 | 通过 |
| --- | --- | --- |
| 1 | `cd ~/xa && docker compose ps` | `Up` |
| 2 | `curl -sS http://127.0.0.1:18789/healthz` | `"ok":true` |
| 3 | RestartCount 未持续增加 | ☐ |
| 4 | 日志无 `Invalid config` / `breaker tripped` | ☐ |
| 5 | 测试企微或 UI 能回一条 | ☐ |

<a id="sec-16-2" name="sec-16-2"></a>

### 16.2 每周

| 步 | 操作 | 通过 |
| --- | --- | --- |
| 1 | `docker stats --no-stream xa-gateway` | 未顶满 |
| 2 | `docker system df` 与 `du -sh ~/xa` | 增长可解释 |
| 2b | 两处 inbound `du` + `inbound-prune.log` | [第 10.4 节](#sec-10-4) cron 在跑 |
| 3 | `stat` secrets 为 `600` | ☐ |
| 4 | `MEMORY.md` 存在 | ☐ |
| 5 | `agent model` 仍是预期模型、`thinking=off` | ☐ |
| 6 | 企微 `channels status` enabled | ☐ |

<a id="sec-16-3" name="sec-16-3"></a>

### 16.3 每月 / 变更后

| 步 | 操作 | 通过 |
| --- | --- | --- |
| 1 | [第 6 节](#sec-06)备份，`tar -tzf` 能列出 | ☐ |
| 2 | [第 8.1 节](#sec-08-1)记录镜像 digest 与插件版本 | ☐ |
| 3 | 密钥未过期 | ☐ |
| 4 | 升级后走[第 8.5 节](#sec-08-5)回归 | ☐ |
| 5 | 未把 secrets 备份传到公共位置 | ☐ |

[← 15. 安全运维](#sec-15) · [↑ 目录](#toc) · [下一节 → 17. 相关文档](#sec-17)

---

<a id="sec-17" name="sec-17"></a>

## 17. 相关文档

| 文档 | 何时去看 |
| --- | --- |
| [xA 现网加固与演进全景.md](xA 现网加固与演进全景.md) | OA 主路径、切入范围、各层 I/O |
| [OpenClaw Gateway Linux 服务器安装手册.md](OpenClaw Gateway Linux 服务器安装手册.md) | 内网 Linux 服务器安装；防火墙 / SSH 隧道；方案 B 用服务器自己的代理 |
| [WeCom 通道插件接入手册.md](WeCom 通道插件接入手册.md) | 通道、allowFrom、思考中占位、插件升级 |
| [DashScope 兼容 Provider 配置手册.md](DashScope 兼容 Provider 配置手册.md) | 慢回复、`thinkingFormat`、`MEMORY.md`、crash-loop |
| [MySQL 数据库准备.md](MySQL%20数据库准备.md) | 独立 MySQL：建库、账号、网络、备份 |
| [OA_tool/OA Workflow Bridge 接入手册.md](OA_tool/OA%20Workflow%20Bridge%20接入手册.md) | OA 桥接插件接入与预检 |
| [openclaw.json 配置参考.md](openclaw.json 配置参考.md) | 字段含义、热重载范围 |
| [OpenClaw Gateway 部署拓扑与选型.md](OpenClaw Gateway 部署拓扑与选型.md) | 多套 compose、迁 Linux 服务器 |
| [第三方凭据注入与配置中心演进.md](第三方凭据注入与配置中心演进.md) | 以后 Nacos 换 secret 文件来源 |

[← 16. 打印用巡检表](#sec-16) · [↑ 目录](#toc)
