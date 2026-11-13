# Redis 独立实例部署手册

> 本文档由仓库根目录原文档**重组**而来：只调整章节归属与交叉引用，**不改变**部署步骤、命令、YAML、错误码或禁止事项。阅读顺序见 [README.md](README.md)。

适用对象：在 **WSL2 + Docker** 上部署 xA，并让 **OA Redis 版桥接**（`oa-workflow-bridge-redis`）对接 **独立 Redis 服务** 的工程师。

插件逻辑、工具 API、Key 设计、Gateway compose / entrypoint 见：

**`OA_tool/OA Workflow Bridge（Redis）接入手册.md`**（compose 增量与入口脚本在第 5.5 节）

本文只覆盖：**Redis 怎么作为独立服务跑起来、怎么加固、生产机/云实例怎么接、本机如何模拟。** OpenClaw 怎么只连：第 2 节契约 + 第 4 节指针。

---

## 0. 先定原则

| 原则 | 说明 |
| --- | --- |
| Redis 独立于 OpenClaw | 生产是单独机器、托管实例或集群；本机用 **独立 compose / 独立容器** 模拟 |
| Gateway 只持有连接串 | 唯一契约：`OA_REDIS_URL`。不要写进 `openclaw.json` 明文 |
| 密码分边存放 | Redis 机器一份 `requirepass`，应用机器一份连接密码。**路径独立，禁止符号链接、禁止共用同一文件** |
| Redis 跑 Linux | 工作站可以是 Windows；**不要**装 Redis for Windows / Memurai |
| 单主 + AOF 为生产 baseline | 插件是单节点客户端 + 单 Gateway；Sentinel / Cluster 需另行验证 |
| `noeviction` | OA 的 `ledger` 无 TTL，被 LRU 踢掉会破坏幂等 |
| 禁止 FLUSH | 生产禁止 `FLUSHDB` / `FLUSHALL`，禁止批量 `DEL *:ledger:*`。**本机测试清空**见第 9.4 节 |

Gateway 只启用 OA 插件 `oa-workflow-bridge-redis`。不要在 `plugins.allow` 中写旧 id `oa-workflow-bridge`。

---

## 1. 生产形态 vs 本机模拟

生产 Redis 不会和 OpenClaw 进程捆在同一份 compose 里。本仓库跑在 Windows 工作站上，不要把下面两件事混为一谈：

| 说法 | 含义 | 采用 |
| --- | --- | --- |
| 「部署在 Windows 上」 | 工位是 Windows，WSL2 里跑容器 | 可以 |
| 「在 Windows 上装 Redis」 | Win32 Redis / Memurai | **否** |
| 「本机隔开模拟生产」 | Redis 单独一份 Linux 容器，Gateway 只连 URL | **是** |

插件不关心 Redis 在哪台机器，只认：

```text
OA_REDIS_URL  →  redis://:密码@主机:6379/库号
               或 rediss://:密码@主机:6379/库号   （TLS，云厂商常见）
```

生产换成内网虚拟机、阿里云 Redis，**只改这一条 URL**（外加网络可达、密码、是否 TLS）。

### 1.1 三种摆法

| 摆法 | 模拟的是什么 | 结论 |
| --- | --- | --- |
| **A. `~/xa-redis` 独立 compose + `~/xa` 只连 URL** | 生产独立 Redis | **本文默认路径** |
| B. Redis 写进 `~/xa/docker-compose.yml` | 单机试点 | 不推荐；`compose down` 会把存储一起停 |
| C. Windows 原生 Redis，容器连 `127.0.0.1` | 错误的 OS + 错误的网络 | **不采用** |

C 不采用：官方 Redis 以 Linux 为准；容器里的 `127.0.0.1` 是 Gateway 自己，不是 Windows，也不是「另一台 Redis」。

### 1.2 本机 ↔ 生产对照

```text
[独立 Redis]                         [OpenClaw]
~/xa-redis/docker-compose.yml      ~/xa/docker-compose.yml
  只启动 redis:7-alpine                不声明 redis 服务
  网络名 xa-shared（可被加入）        networks: xa-shared  external: true
  数据 ./redis-data                    entrypoint 只 export OA_REDIS_URL
         │                                        │
         └──────── 主机名 xa-redis:6379 ────────┘
```

| 本机 | 生产 |
| --- | --- |
| `xa-redis` 容器 | Redis 虚拟机 / 云实例 |
| Docker 网络 `xa-shared` | VPC / 应用内网 |
| `OA_REDIS_URL=redis://:密码@xa-redis:6379/0` | `OA_REDIS_URL=redis://:密码@redis.internal:6379/0` |
| `~/xa-redis/secrets/redis_password.txt` | Redis 主机/控制台上的 `requirepass` |
| `~/xa/secrets/oa_redis_password.txt` | 应用侧自己的连接密码（Vault / 应用 secret） |
| 停 Gateway，Redis 继续跑 | 发版重启应用，不动 Redis |

本机单容器 **模拟不了**：Cluster/Sentinel 故障转移、跨机房延迟、云白名单。这些必须在目标 Redis 上验证。

---

## 2. 连接契约（OpenClaw 侧）

优先级（插件 `src/redis-client.mjs`）：

1. 环境变量 **`OA_REDIS_URL`**
2. 环境变量 `REDIS_URL`
3. `bridge-config.json` → `redis.url`（兜底，容器内不要写 `127.0.0.1`）

`bridge-config.json` 里仍要配 **`keyPrefix`、`database`**。`database` 须与 URL 路径 `/0` 一致。

建议：

```json
"redis": {
  "url": "redis://xa-redis:6379/0",
  "keyPrefix": "oa-bridge-xa-it",
  "database": 0
}
```

密码只放 URL / secret，不要写进 json。

---

## 3. 本机生产对齐：独立 Redis（`~/xa-redis`）

以下是 **推荐部署**。假定 OpenClaw 已按 WSL2 安装手册阶段 B，或 Linux 服务器安装手册第 13 节（模型已注入且 `/healthz` 通）跑通。

### 3.1 目录与密码（两边各一份，不要共用路径）

生产里 Redis 管理员设 `requirepass`，应用团队把**同一串值**写进自己的密钥库。本机要模拟的是这套分工，所以：

| 角色 | 文件（路径必须不同） | 用途 |
| --- | --- | --- |
| Redis 服务 | `~/xa-redis/secrets/redis_password.txt` | `--requirepass` |
| OpenClaw | `~/xa/secrets/oa_redis_password.txt` | 拼 `OA_REDIS_URL` |

**禁止** `ln -s`、禁止把 Gateway 的 `secrets.file` 指到 `~/xa-redis/...`。内容可以对齐，地址必须分开。

```bash
mkdir -p ~/xa-redis/{redis-data,secrets}
mkdir -p ~/xa/secrets

# 一次性在 shell 里生成值，分别写入两边；不要互相 ln / cp 后当「同一文件」用
REDIS_PASS="$(openssl rand -hex 24)"
printf '%s' "$REDIS_PASS" > ~/xa-redis/secrets/redis_password.txt
printf '%s' "$REDIS_PASS" > ~/xa/secrets/oa_redis_password.txt
unset REDIS_PASS

chmod 600 ~/xa-redis/secrets/redis_password.txt ~/xa/secrets/oa_redis_password.txt
sudo chown -R 1000:1000 ~/xa-redis
sudo chown 1000:1000 ~/xa/secrets/oa_redis_password.txt
```

密码用 hex，避免 URL 里出现 `@` `:` `/` `+` `=`。不要提交 git，不要写进 `openclaw.json`。

确认不是链接：

```bash
# 两条路径，两个 inode；都不应是 symbolic link
stat -c '%n %F %i' ~/xa-redis/secrets/redis_password.txt ~/xa/secrets/oa_redis_password.txt
```

### 3.2 Redis 启动脚本

`~/xa-redis/redis-entrypoint.sh`：

```sh
#!/bin/sh
set -eu
PASS="$(tr -d '\n' < /run/secrets/redis_password)"
exec redis-server \
  --bind 0.0.0.0 \
  --protected-mode yes \
  --appendonly yes \
  --appendfsync everysec \
  --save 900 1 \
  --save 300 10 \
  --maxmemory 256mb \
  --maxmemory-policy noeviction \
  --requirepass "$PASS"
```

```bash
chmod 755 ~/xa-redis/redis-entrypoint.sh
sudo chown 1000:1000 ~/xa-redis/redis-entrypoint.sh
```

说明：

| 项 | 为何 |
| --- | --- |
| `--bind 0.0.0.0` | 容器内监听，供 Docker 网络访问；**不是**对公网暴露 |
| `--requirepass` | 生产必开 |
| `--appendonly yes` + `everysec` | AOF，重启不丢 pending/ledger |
| `--save` | RDB 额外快照 |
| `--maxmemory-policy noeviction` | 内存满则拒绝写入，不淘汰 ledger |
| `256mb` | 本机/小生产起点；按 key 量上调，见第 7 节 |

### 3.3 Redis compose（只含 Redis）

`~/xa-redis/docker-compose.yml`：

```yaml
services:
  xa-redis:
    image: redis:7.4-alpine
    container_name: xa-redis
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"
    secrets:
      - redis_password
    volumes:
      - ./redis-data:/data
      - ./redis-entrypoint.sh:/redis-entrypoint.sh:ro
    entrypoint: ["/bin/sh", "/redis-entrypoint.sh"]
    networks:
      - xa-shared
    healthcheck:
      # 已包含 AUTH + PING；compose ps 为 healthy 即通过，不必再手搓 redis-cli
      test: ["CMD-SHELL", "redis-cli -a \"$(tr -d '\\n' < /run/secrets/redis_password)\" ping | grep PONG"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 5s
    # 仅本机 redis-cli 调试；生产机不要映射到 0.0.0.0
    ports:
      - "127.0.0.1:6379:6379"

networks:
  xa-shared:
    name: xa-shared
    driver: bridge

secrets:
  redis_password:
    file: ./secrets/redis_password.txt
```

生产机上的 Redis 容器：**删掉 `ports` 整段**，只让应用所在 Docker 网络或 VPC 访问。

镜像建议钉小版本（示例 `7.4-alpine`），不要长期盯 `latest`。记录 `docker image inspect` 的 digest，升级前备份 `redis-data`。

### 3.4 启动 Redis

健康检查已经在做「带密码的 `PING`」。启动后只看状态，**不要**再 `exec redis-cli PING` 重复验一次。

```bash
cd ~/xa-redis
docker compose pull
docker compose up -d
docker compose ps
# STATUS 应为 Up (healthy)
```

`starting` 会持续到第一次检查成功（最多约 `start_period` + `retries × interval`）。一直不是 `healthy` 时看检查日志，而不是另开一条 PING：

```bash
docker inspect --format '{{.State.Health.Status}} {{.State.Health.Log}}' xa-redis
docker compose logs --tail 50 xa-redis
```

确认网络已创建：

```bash
docker network inspect xa-shared --format '{{.Name}} {{len .Containers}}'
```

---

## 4. OpenClaw 只做连接（`~/xa`）

**不要**在 `~/xa/docker-compose.yml` 里再声明 `xa-redis` 服务，也不要 `depends_on: xa-redis`（跨 compose 项目找不到对方服务）。启动顺序靠运维：先 Redis，再 Gateway。

Gateway 侧的 compose 增量、entrypoint 整文件、OA 凭据 secrets、主进程注入校验、启停命令写在 OA 接入手册（本文不重复 YAML，避免两处漂移）：

**[OA_tool/OA Workflow Bridge（Redis）接入手册.md](OA_tool/OA Workflow Bridge（Redis）接入手册.md) 第 5.5 节**

前置：第 3.1 节已分别写好两边 Redis 密码文件。`oa_redis_password` 的 `file:` 只能是 `./secrets/oa_redis_password.txt`（即 `~/xa/secrets/`），**不要**指向 `~/xa-redis/`。

### 4.1 启停顺序

先 Redis `up`，再 Gateway `up`。只停应用时不要 `down` Redis。完整命令与 Gateway 必须 `down && up`（只 `restart` 不够）见 OA 接入手册 **5.5.3**。

`cd ~/xa && docker compose down` **不会**停 `~/xa-redis`，这是预期。

---

## 5. 生产机 / 云 Redis 怎么接

本机跑通后，上生产通常 **不再部署 `~/xa-redis` 容器**，改为连已有 Redis。

### 5.1 独立 Linux 虚拟机（自建单主）

1. 内网安全组只放行 OpenClaw 所在网段的 `6379`。
2. `bind` 内网 IP 或 `0.0.0.0` + 安全组；`protected-mode yes`；`requirepass`。
3. AOF + `noeviction`，与第 3.2 节相同。
4. Gateway 的 `OA_REDIS_URL` 改主机名，例如：

```sh
export OA_REDIS_URL="redis://:${REDIS_PASS}@10.20.30.40:6379/0"
```

容器要能路由到该 IP（同一 VPC，或宿主机网络）。**不要**再加入 `xa-shared` 去找 `xa-redis` 这个名字。

### 5.2 云托管 Redis（阿里云 / 腾讯云等）

| 项 | 做法 |
| --- | --- |
| 白名单 | 加入 Gateway 出口 IP 或交换机 |
| 密码 | 控制台设置；写入 Gateway secret，与本机同一套 `OA_REDIS_URL` |
| TLS | URL 用 `rediss://`（两个 s） |
| 库号 | 与 `bridge-config.json` 的 `database` 一致 |
| 内存策略 | 控制台改为 **noeviction**（或等价「不淘汰」） |
| 持久化 | 开启 AOF / 云备份 |

示例：

```sh
export OA_REDIS_URL="rediss://:${REDIS_PASS}@r-xxxxxxxx.redis.rds.aliyuncs.com:6379/0"
```

### 5.3 Sentinel / Cluster

`oa-workflow-bridge-redis` 使用 **单节点** Redis 客户端，按指定 key 做 `GET`/`SET`/`DEL`，当前按 **单 Gateway** 部署。

| 拓扑 | 与当前插件 |
| --- | --- |
| 单主 + AOF（可有只读副本，应用只写主） | **支持**，生产推荐 |
| Sentinel 自动切主 | **未验证** |
| Redis Cluster | **未验证** |

生产第一期用 **单主（或云单节点）+ AOF + 密码 + 内网**。多 Gateway / 附件跨机以后再用 SQL 存文件，不在本插件里做。

---

## 6. OA 插件接入（消费者）

Redis 起来之后，Gateway 加载 OA 桥接插件。插件拷贝、`openclaw.json` 的 `plugins.allow` / `load.paths`、工具 API、Key 设计与只读预检见：

**[OA_tool/OA Workflow Bridge（Redis）接入手册.md](OA_tool/OA Workflow Bridge（Redis）接入手册.md)**

Docker 凭据由 `oa-workflow-bridge-redis/src/secret-resolver.mjs` 读 `OA_API_USER_ID` / `OA_APP_SECRET`（见 OA 接入手册第 5.5 节）。未注入时预检和 `prepare` 一律 `NOT_CONFIGURED`，**不会**回退 PowerShell、DPAPI 或任何映射文件。身份映射权威是 Redis `idmap`（现网 `requesterSenderId` 为加密 userid；见 `OA_tool/企微到OA身份与数据流.md`）。加密 userid → 明文 → OA 工号对齐由独立适配器写 `idmap`（STRING + EX），桥接只 GET。不要在桥接 `oa-client.mjs` 里调企微或 `getHrmUserInfoWithPage`。提交前 `getHrmSimpleInfo` 是建单链，见 `xA 现网加固与演进全景.md` 第 7 节。设计见 `OA_tool/身份适配器说明.md`。`idmap` 可设 EX；`pending` 带宽限 `PX` 兜底回收（过期判定仍看 JSON `expiresAt`）；`ledger` / `idx` 仍然禁止 Redis TTL。

上线闸门（**不要**把 Redis「已通」当成 `prepare` 已通或可以忽略 npm 依赖）：

- 现网是否调用 `doCreateRequest` 看实际加载的 `bridge-config.json`；切流核对见 OA Redis 手册第 10 节
- 现网 `tools.alsoAllow` **已含** `oa_workflow`。不要移出。桥接与身份适配器都要按 OA Redis 手册 4.2 装 `node_modules/redis`（现网已装齐）。Redis 进程在跑、插件已 `loaded (Redis state)`，仍可能因缺 npm 包而确认准备失败；备份恢复后须重装
- 不要因 Redis 已通就略过 4.2

附件 **不进 Redis**，在 `{OPENCLAW_STATE_DIR}/oa-workflow-bridge-redis/staging/`。`OPENCLAW_STATE_DIR=/home/node/.openclaw` 必须设（见 OA 接入手册第 5.5.1 节）。

---

## 7. 容量、内存与持久化

| 数据 | 量级直觉 | 策略 |
| --- | --- | --- |
| pending | 未确认工单；程序按 `expiresAt` 拒绝提交 | 很小 |
| ledger | 每张工单一条，按内部号永久幂等（不是冷却） | 随工单量线性增长；不要加 TTL |
| 附件 | 不在 Redis | 算 Gateway 磁盘 |

本机 `maxmemory 256mb` 足够试点。生产按 ledger 条数估算：单条通常数 KB，10 万条也远小于 256mb。仍建议监控 `used_memory`，满了 **加内存**，不要改成 `allkeys-lru`。ledger 防的是同一 `IT-…` 再打 OA（见 OA Redis 手册 3.3），不是按人冷却。

数据目录 `~/xa-redis/redis-data` 必须在 Linux 文件系统上（家目录），不要放 `/mnt/c`。

---

## 8. 多业务 / 多环境

| 目标 | Redis 实例 | database | keyPrefix | Gateway |
| --- | --- | --- | --- | --- |
| 单套 IT | 1 | `/0` | `oa-bridge-xa-it` | 1 |
| IT + HR 共用 Redis | 1 | `/0` `/1` | 各业务不同 | 每业务 1 |
| 生产 / 预发强隔离 | 2 套实例 | 各自 `/0` | 可同名 | 各 1 |
| 同业务多副本 | 1 | 相同 | 相同 | 多，但企微 Bot **单活**；附件卷必须共享 |

HR 示例：`OA_REDIS_URL=...@xa-redis:6379/1`，`keyPrefix` 改为 `oa-bridge-xa-hr`。

同一企微 Bot **不能**两套 Gateway 同时在线。多副本还要把 staging 做成共享卷，否则 confirm 落到另一实例会找不到附件。

---

## 9. 备份、恢复、密码轮换

### 9.1 备份

```bash
# 建议先停 Gateway，减少写入
cd ~/xa && docker compose stop

cd ~/xa-redis
docker compose exec -T xa-redis \
  redis-cli -a "$(tr -d '\n' < ./secrets/redis_password.txt)" BGSAVE
# 或直接拷数据目录（仍建议 Redis 已 SAVE）
tar -C ~ -czf "xa-redis-$(date +%Y%m%d).tar.gz" xa-redis/redis-data xa-redis/secrets
```

云 Redis 用控制台自动备份，不必拷容器目录。

### 9.2 恢复

停 Redis → 换回 `redis-data`（含 `appendonly.aof` / `dump.rdb`）→ 再 `up -d` → 再起 Gateway。恢复后用 `DBSIZE` 和已知工单号 `GET` 核对，不要 `FLUSH`。

### 9.3 轮换 Redis 密码（两处各自改，禁止共用文件）

生产顺序：先改 Redis 服务端密码并重启 Redis，再改应用侧连接密码并重启 Gateway。短暂 `WRONGPASS` 可接受；不要用符号链接「改一次两边生效」——那不是生产模型。

```bash
NEW_PASS="$(openssl rand -hex 24)"

# 1）Redis 机器
printf '%s' "$NEW_PASS" > ~/xa-redis/secrets/redis_password.txt
chmod 600 ~/xa-redis/secrets/redis_password.txt
sudo chown 1000:1000 ~/xa-redis/secrets/redis_password.txt
cd ~/xa-redis && docker compose down && docker compose up -d

# 2）应用机器（另一路径）
printf '%s' "$NEW_PASS" > ~/xa/secrets/oa_redis_password.txt
chmod 600 ~/xa/secrets/oa_redis_password.txt
sudo chown 1000:1000 ~/xa/secrets/oa_redis_password.txt
cd ~/xa && docker compose down && docker compose up -d

unset NEW_PASS
```

云 Redis：控制台改密（Redis 侧）→ 再改 `~/xa/secrets/oa_redis_password.txt` → 只重建 Gateway。

只 `restart` **不够**：entrypoint / Redis `--requirepass` 在创建容器时读各自的 secret。

### 9.4 本机测试：一次性清空业务 key（`FLUSHDB`）

只用于 **工位 `~/xa-redis` 测试库**。测了很多轮之后，`ledger` / `idx` 没有 TTL，会一直堆着；`FLUSHDB` 一次清掉当前库（本项目是 `/0`）里的全部 key。

**生产、预发、云 Redis、以及已经有真实员工单的实例不要做。** 不要用 `FLUSHALL`（会把其它 `database` 一并清掉）。不要批量 `DEL *:ledger:*` 当「半清」。

清的是 Redis，不是 OA。已经在 Ecology 建成功的流程还在；企微会话 jsonl、`media/inbound` 原件、本机 staging 目录也不在这次命令里。

#### 步骤

建议先停 Gateway，避免清库过程中还有 `prepare` / `submit_confirmed` 往里写。

```bash
# 1）停 Gateway（Redis 保持 up）
cd ~/xa && docker compose stop

# 2）看当前有多少条（本机测试）
cd ~/xa-redis
docker compose exec -T xa-redis \
  sh -c 'PASS=$(tr -d "\n" < /run/secrets/redis_password); redis-cli -a "$PASS" -n 0 DBSIZE'

# 3）清空 db0
docker compose exec -T xa-redis \
  sh -c 'PASS=$(tr -d "\n" < /run/secrets/redis_password); redis-cli -a "$PASS" -n 0 FLUSHDB'

# 4）核对，应返回 0
docker compose exec -T xa-redis \
  sh -c 'PASS=$(tr -d "\n" < /run/secrets/redis_password); redis-cli -a "$PASS" -n 0 DBSIZE'

# 5）再起 Gateway
cd ~/xa && docker compose start
```

`FLUSHDB` 会写入 AOF，Redis 重启后仍是空库。不要为了清空去删 `~/xa-redis/redis-data/`。

#### 清完之后

| 变化 | 说明 |
| --- | --- |
| 同一内部 `IT-` 号可以再 `prepare` | 幂等台账没了；本机回归常用 |
| 企微身份会再查一次 | `idmap` 没了，下次 `prepare` 可能再打转换 HTTP |
| 未确认的 pending 立刻找不到 | 员工侧等同于没有待确认单，重新描述再 `prepare` |
| OA 里已建的单 | **不动** |

本机 staging 孤儿目录由下一次 `prepare` 的 GC 回收，见 OA 接入手册 3.3。不必为了清 Redis 去手删磁盘。

前缀、库号以现网 `bridge-config.json` 的 `redis.keyPrefix` / `redis.database` 为准。点查命令见 OA 接入手册 8.3。

---

## 10. 验证

```bash
# Redis：存活看 compose ps 的 healthy，不要再 PING
cd ~/xa-redis
docker compose ps
docker compose exec -T xa-redis \
  sh -c 'PASS=$(tr -d "\n" < /run/secrets/redis_password); redis-cli -a "$PASS" INFO persistence'
docker compose exec -T xa-redis \
  sh -c 'PASS=$(tr -d "\n" < /run/secrets/redis_password); redis-cli -a "$PASS" CONFIG GET maxmemory-policy'
# 期望：noeviction

# Gateway 已加载 Redis 版插件
docker exec -it xa-gateway node dist/index.js plugins list
# 有 oa-workflow-bridge-redis enabled

docker logs xa-gateway 2>&1 | grep oa-workflow-bridge-redis
# [oa-workflow-bridge-redis] loaded (Redis state) from ...

# 只读预检（OA 凭据配好后；不会建单）
docker exec -it xa-gateway node \
  /home/node/.openclaw/extensions/oa-workflow-bridge-redis/scripts/readonly-preflight.mjs
```

有工单操作后，用已知工单号点查（不要对生产做 `KEYS`）：

```bash
cd ~/xa-redis
docker compose exec -T xa-redis \
  sh -c 'PASS=$(tr -d "\n" < /run/secrets/redis_password); redis-cli -a "$PASS" -n 0 GET "oa-bridge-xa-it:ledger:IT-20260805-121500-A1B2"'
```

---

## 11. 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| Gateway 日志 `Redis init failed` | URL / 密码 / 网络 | 先看 Redis `compose ps` 是否 `healthy`；确认 Gateway 在 `xa-shared`；主机名是 `xa-redis` 不是 `127.0.0.1` |
| `network xa-shared declared as external, but could not be found` | Redis compose 未先 up | 先 `cd ~/xa-redis && docker compose up -d` |
| `NOAUTH` / `WRONGPASS` | 两边密码文件内容不一致，或 URL 未编码 | 分别核对 `~/xa-redis/secrets/redis_password.txt` 与 `~/xa/secrets/oa_redis_password.txt`；应用 hex；不要靠 symlink 对齐 |
| 插件未出现在 list | allow / path 不是 `oa-workflow-bridge-redis` | 改 `openclaw.json` 并 `down && up` |
| `OA bridge Redis store is not ready` | 启动时 Redis 未就绪 | 等 healthy 后重试工具调用 |
| `NOT_CONFIGURED` / 缺 OA 凭据 | 未注入 `OA_API_USER_ID` / `OA_APP_SECRET`。插件不回退 DPAPI | 按 OA 接入手册第 5.5 节补 secret / volume / entrypoint 后 `down && up` |
| `NOT_CONFIGURED` | OA 核心凭据为空 | 检查 `oa_api_user_id.txt` / `oa_app_secret.txt` 非空且已 `down && up` |
| `OA_IDENTITY_NOT_FOUND` | 适配器未查到人员 id | 核对自建应用可见范围、工号对齐；见身份适配器说明 |
| pending 重启后丢失 | 未开 AOF，或 data 目录在 `/mnt/c` | 第 3.2 节；数据放 Linux 盘 |
| 内存持续涨 | ledger 永久 key（预期） | 加 `maxmemory`，不要 LRU |

---

## 12. 禁止事项

- 不要在 Windows 安装原生 Redis 来「模拟生产」
- 不要让 Gateway 容器用 `127.0.0.1:6379` 连 Redis（除非 Redis 就在同一容器，本文不采用）
- 不要把 Redis 密码写入 `openclaw.json`
- 不要把 OA AppSecret、API User ID 写入 `openclaw.json`（走 `/run/secrets` + 环境变量）
- 不要把身份映射文件挂进 workspace 或 `.openclaw`
- 不要用 `ln -s` 或把 Gateway `secrets.file` 指到 `~/xa-redis/`，让两边共用同一密码文件
- 不要对生产执行 `FLUSHDB` / `FLUSHALL`（本机测试清空见第 9.4 节）
- 不要批量删除 `*:ledger:*`
- 不要把 `maxmemory-policy` 设成会淘汰 key 的策略
- 不要把 `6379` 映射到 `0.0.0.0`
- 不要在 `plugins.allow` 中写旧 id `oa-workflow-bridge`
- 不要把附件 base64 写入 Redis
- 不要把 Redis「已通」当成 `prepare` 已通；两包 `node_modules/redis` 见 OA Redis 手册 4.2。不要移出 `oa_workflow`

---

## 13. 相关文档

| 文档 | 内容 |
| --- | --- |
| `OA_tool/OA Workflow Bridge（Redis）接入手册.md` | 插件架构、Key、工具 API；Gateway compose / entrypoint 见该手册 5.5 |
| `OA_tool/OA插件与Redis链路.md` | OA 插件 × Redis 节点图、hop、五 action 点查 key |
| `xA 现网加固与演进全景.md` | OA 主路径、切入范围；Redis 在链路中的位置 |
| `OA_tool/企微到OA身份与数据流.md` | Redis `idmap`；加密 userid 与适配器 |
| `OA_tool/身份适配器说明.md` | miss 路径：`idmap` 由适配器写（STRING + EX；已验证）；ledger 仍禁止 TTL |
| `外部系统 Tool 插件设计规范.md` | 固定 action、可信上下文、两阶段确认、Docker 凭据 |
| `OpenClaw Gateway WSL2-Docker 安装手册.md` | 工位 WSL2 Gateway 阶段 A/B、目录与 secrets |
| `OpenClaw Gateway Linux 服务器安装手册.md` | Linux 服务器安装（独立完整路径） |
| `OpenClaw Gateway Docker 运维手册.md` | 日常启停、备份、巡检 |
| `WeCom 通道插件接入手册.md` | 通道与 `plugins.allow` |
