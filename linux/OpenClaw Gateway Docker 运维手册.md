# OpenClaw Gateway Docker 运维手册

装完之后怎么养：启停、巡检、备份、升级、排障、OA 对账。第一次安装见 [OpenClaw Gateway Linux 服务器安装手册.md](OpenClaw%20Gateway%20Linux%20服务器安装手册.md)。

## 1. 约定与启停

| 项 | 值 |
| --- | --- |
| 目录 | `~/xa`（所有 compose 命令在这里执行） |
| 容器 / 镜像 | `xa-gateway` / `xa-gateway-oa:2026.9.2`（OA 插件在镜像 `/opt/xa/oa-workflow-bridge`） |
| 健康检查 | `http://127.0.0.1:18789/healthz` |
| 容器内 CLI | `alias oc='docker exec -it xa-gateway node dist/index.js'` |
| OA 状态库 | 独立 MySQL `xa_oa`，不在本机 compose 里 |

`docker exec` 不跑 entrypoint，CLI 报 `missing env var` 不影响主进程。需要变量时用 `-e`，例如：

```bash
docker exec -it -e OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < ~/xa/secrets/gateway_token.txt)" \
  xa-gateway node dist/index.js config validate
```

改了什么、怎么生效：

| 改动 | 生效方式 |
| --- | --- |
| `openclaw.json` 业务字段（tools、allowFrom、bindings） | 多数热重载；不生效再 `docker compose restart xa-gateway` |
| `skills` / `bootstrapMaxChars` | `restart`，再在企微 `/new`（旧会话缓存截断结果） |
| 工作区规则 `AGENTS.md` 等 | 下一轮对话生效；建议 `/new` |
| `~/xa/secrets/*.txt`、entrypoint、compose、`plugins.load.paths`、端口 / bind | `docker compose down && docker compose up -d` |
| `~/xa/oa-bridge-config.json` | `down && up`（只读挂载，不必重建镜像） |
| OA 插件代码、`systems.json` | 重建镜像（建议新 tag），改 compose `image:`，`down && up` |

改 json 前先 `config validate`。禁止在容器里 `onboard` / `setup`，禁止用 `config set` 把 `${VAR}` 覆盖成明文。Control UI 若写出 `~/xa/config/agents/itservicedeskagent/agent/models.json`（可能含明文 Key），删掉后 `restart`。

## 2. 健康检查（出问题先跑）

只读脚本，不改配置、不重启：

```bash
bash <<'EOF'
cd ~/xa || exit 1
systemctl is-active docker
docker compose ps
docker inspect -f 'Status={{.State.Status}} Health={{.State.Health.Status}} RestartCount={{.State.RestartCount}}' xa-gateway
curl -sS -m 5 http://127.0.0.1:18789/healthz; echo
df -h ~/xa
stat -c '%a %n' ~/xa/secrets/*.txt
test -f ~/xa/workspace/MEMORY.md && echo "MEMORY.md OK" || echo "FAIL: 缺 MEMORY.md"
docker logs xa-gateway 2>&1 | grep -E 'agent model|Invalid config|breaker tripped|autostart suppressed|plugin path not found|MySQL init failed' | tail -n 20
docker stats --no-stream xa-gateway
EOF
```

期望：`Up (healthy)`，RestartCount 不持续增加，`/healthz` 含 `"ok":true`，secret 为 `600`，日志只有 `agent model: bailian/… (thinking=off …)`。

再看 OpenClaw 自身：

```bash
oc gateway status --deep
oc plugins list                              # oa-workflow-bridge、wecom-openclaw-plugin enabled
oc channels status --channel wecom --probe   # enabled, configured, running, works
oc agents list --bindings                    # wecom/default → itservicedeskagent
oc models status                             # 无 unresolved
```

## 3. 日志

```bash
docker logs -f --timestamps xa-gateway
docker logs --since 30m --timestamps xa-gateway
```

按现象 grep：

| 想看 | 命令 |
| --- | --- |
| 模型与思考开关 | `docker logs xa-gateway 2>&1 \| grep 'agent model'` |
| 模型耗时 | `docker logs --since 1h xa-gateway 2>&1 \| grep -E 'model-fetch\|kind=final\|timeoutMs'` |
| 发图误走媒体理解 | `… \| grep apply_media_understanding`（应无） |
| 企微收发 | `… \| grep -Ei 'wecom\|Authentication successful\|Reply message sent\|Reply ack\|DM dropped'` |
| 配置非法 / 熔断 | `… \| grep -Ei 'Invalid config\|breaker tripped\|autostart suppressed'` |
| OA 插件 / 数据库 | `… \| grep -E 'Cannot find (package\|module)\|plugin path not found\|MySQL init failed\|DB_UNAVAILABLE\|sweep failed'` |

`oa_workflow` 的回执码（如 `OA_IDENTITY_*`）不在 `docker logs`，在会话 jsonl 里，抽取方法见 [企微到OA身份.md](OA_tool/企微到OA身份.md) 第 7 节。不要 `cat` 整份 jsonl。

日志里出现 Gateway Token、BotSecret、模型 Key、Authorization、附件 base64、原始 SenderId，按安全事件处理：停止外传，轮换对应密钥。

容器日志已轮转（`json-file`，20m × 5）。轮转不管会话 jsonl 和 `media/inbound`。

## 4. 巡检

| 频率 | 检查 | 通过标准 |
| --- | --- | --- |
| 每日 | 第 2 节脚本 | 全部符合期望 |
| 每日 | 测试机器人发「你是谁」，同时 `docker logs -f` | 有 inbound、`Reply message sent`、`Reply ack received` |
| 每周 | `du -sh ~/xa/config/media/inbound ~/xa/workspace/media/inbound`；`tail -n 14 ~/xa/logs/inbound-prune.log` | 每天都有 `done total_deleted=` 记录 |
| 每周 | `docker system df`；`du -sh ~/xa` | 增长可解释 |
| 每周 | MySQL：`SELECT status, COUNT(*) FROM xa_oa.oa_ticket GROUP BY status;` | `unknown` / `submitting` 为 0，否则走第 10 节 |
| 每周 | `grep -nE 'sk-\|apiKey.: ."[^$]' ~/xa/config/openclaw.json` | 无明文 Key |
| 每月 | 第 5 节备份，`tar -tzf` 能列出 | 是 |
| 每月 | 记录镜像 digest、OpenClaw 版本、企微插件版本 | 已记 |
| 每月 | 百炼 Key、企微 Secret、OA AppSecret 是否临期 | 未过期 |

## 5. 备份与恢复

| 必须备份 | 可重建 |
| --- | --- |
| `~/xa` 下 `docker-compose.yml`、`entrypoint.sh`、`config/`、`workspace/`、`secrets/`、`oa-bridge-config.json` | 镜像（按仓库重建）、企微插件（npm 重装） |
| MySQL `xa_oa`（`mysqldump`，见安装手册第 3 节） | 容器 |

```bash
STAMP="$(date +%Y%m%d-%H%M%S)"; mkdir -p ~/xa-backups
cd ~/xa && docker compose stop
tar --exclude='xa/extensions' -czf ~/xa-backups/xa-${STAMP}.tar.gz -C ~ \
  xa/docker-compose.yml xa/entrypoint.sh xa/config xa/workspace xa/secrets xa/oa-bridge-config.json
chmod 600 ~/xa-backups/xa-${STAMP}.tar.gz
docker compose start
```

只备配置不停机时去掉 `stop` / `start`。备份含 secrets，只放本机或企业加密盘。

恢复：

```bash
cd ~/xa && docker compose down
mv ~/xa ~/xa.broken.$(date +%Y%m%d-%H%M%S) && mkdir ~/xa
tar -xzf ~/xa-backups/xa-<时间戳>.tar.gz -C ~
sudo chown -R 1000:1000 ~/xa && chmod 600 ~/xa/secrets/*.txt && chmod 755 ~/xa/entrypoint.sh
docker images | grep xa-gateway-oa      # 没有就按安装手册第 5 节重建
cd ~/xa && docker compose up -d
```

企微插件在 `extensions/` 下未备份，恢复后按安装手册第 8 节重装。验证后先用测试机器人，再切回生产 Bot。

## 6. 密钥轮换与升级

**密钥**：只改 `~/xa/secrets/*.txt`（先 `cp -a x.txt x.txt.bak`，`printf '%s'` 写新值），再 `down && up`，验证后删 `.bak`。

| 文件 | 新值来源 | 轮完验证 |
| --- | --- | --- |
| `gateway_token.txt` | `openssl rand -base64 32` | 新 token 能开 Dashboard |
| `wecom_bot_*.txt` | 企微后台重置机器人 | 收发正常 |
| `model_api_key.txt` | 百炼控制台新建 Key | 对话无 401 |
| `oa_mysql_password.txt` | DBA 先改 MySQL 密码 | 日志无 `MySQL init failed` |
| `oa_app_secret.txt` / `oa_api_user_id.txt` | OA 管理端 | OA 只读预检通过 |
| `wecom_identity_*.txt` | 企微自建应用 | 新员工 `prepare` 能查到身份 |

注入检查（只看非空，不打印值）：

```bash
docker exec xa-gateway sh -c 'for v in OPENCLAW_GATEWAY_TOKEN XA_IT_WECOM_BOT_ID XA_DOMESTIC_API_KEY OA_MYSQL_PASSWORD WECOM_IDENTITY_SECRET; do eval "test -n \"\$$v\"" || echo MISSING:$v; done; echo CHECKED'
```

**升级 OpenClaw**：改 `docker/Dockerfile` 的 `OPENCLAW_IMAGE`（或 `--build-arg`），用新 tag 构建，改 compose `image:`，`down && up`，再 `config validate`、`doctor`（只看不改）。回滚 = 把 `image:` 改回旧 tag 再 `down && up`。`doctor --fix` 会改 `agents.entries`，先备份 json，不要在生产 Bot 上首次试。配置被改坏时连 `config/` 一起恢复。

**升级企微插件**：见 [WeCom 通道插件接入手册.md](WeCom%20通道插件接入手册.md) 第 5 节。

升级后回归：第 2 节 + 测试机器人发「你是谁」，`model-fetch` 到 `kind=final` 约 2～5 秒。

## 7. inbound 原件回收（cron）

插件提交后只删自己的 staging 副本，通道落盘的原件在两处，都会涨：

| 宿主机 | 说明 |
| --- | --- |
| `~/xa/config/media/inbound` | OpenClaw state 目录下的原件 |
| `~/xa/workspace/media/inbound` | 工作区下的原件 |

用仓库脚本 `docker/prune-inbound.sh`：只删满 24 小时（`-mmin +1440`）的文件，日志写 `~/xa/logs/inbound-prune.log`（北京时间）。

```bash
mkdir -p ~/xa/scripts ~/xa/logs
cp ~/handoff/xa/docker/prune-inbound.sh ~/xa/scripts/ && chmod 700 ~/xa/scripts/prune-inbound.sh
find ~/xa/config/media/inbound ~/xa/workspace/media/inbound -type f -mmin +1440 -ls   # 先干跑
~/xa/scripts/prune-inbound.sh && tail -n 5 ~/xa/logs/inbound-prune.log
( crontab -l 2>/dev/null; echo "15 3 * * * $HOME/xa/scripts/prune-inbound.sh" ) | crontab -
crontab -l && systemctl is-active cron
```

用跑 Gateway 的同一用户，不要 root。脚本在、crontab 没有，不会自动删。

不要：`rm -rf ~/xa/workspace`；对工作区根目录 `find -delete`；手删 `oa-workflow-bridge/staging/`（插件自己回收）；为腾盘删 `oa_ticket`。

## 8. 崩溃熔断（crash-loop breaker）

日志出现 `restart-loop breaker tripped` / `[wecom] channel autostart suppressed`：5 分钟内多次不洁启动后，控制面照常起来，但通道不自动拉。先修好根因（json / secret / 插件路径），然后二选一：

- 什么都不做，约 5 分钟后同一进程会自己拉起通道；
- 立即拉起（需要 token）：

```bash
docker exec -it -e OPENCLAW_GATEWAY_TOKEN="$(tr -d '\n' < ~/xa/secrets/gateway_token.txt)" \
  xa-gateway node dist/index.js gateway call channels.start --params '{"channel":"wecom","accountId":"default"}'
```

不要再 `compose restart`（会重新计数），不要用 `channels start --channel`。之后 `channels status --channel wecom --probe` 应为 `works`，日志有 `Authentication successful`。

## 9. 排障速查

| 现象 | 处理 |
| --- | --- |
| `Cannot connect to the Docker daemon` | `sudo systemctl start docker`；`groups` 含 `docker` |
| 容器 `Restarting` | `docker logs --tail 200 xa-gateway`；`down`，按日志改 json，`up`。Restarting 时别 `exec` |
| `/healthz` 不通但容器 Up | `gateway.bind` 必须是 `lan`；看启动日志 |
| 企微突然不回 | 先看日志有无熔断（第 8 节）；没有就 `restart`；仍不行 `down && up`，并查有无第二套容器抢同一 Bot：`docker ps -a` |
| 回复很慢 | 时间线：inbound → `model-fetch` → `kind=final` → `Reply message sent`。见 [DashScope 手册](DashScope%20兼容%20Provider%20配置手册.md) 第 4 节 |
| `Unknown model` / unresolved | `model_ref.txt` 前缀必须等于 Provider 键 `bailian` |
| `MySQL init failed` / `DB_UNAVAILABLE` | 见安装手册第 10 节 |
| `Cannot find package 'mysql2'` / `plugin path not found: /opt/xa/…` | 不是自建镜像；重建并核对 compose `image:` |
| 员工「还不能提交到 OA」/ `OA_IDENTITY_*` | [企微到OA身份.md](OA_tool/企微到OA身份.md) 第 7 节 |
| 员工「OA 需要人工核对」/ `RECONCILIATION_REQUIRED` | 第 10 节对账；禁止让员工再点确认 |
| 日志出现 `smartsheet_get_records` | `alsoAllow` 混进了旧工具；两处只留 `oa_workflow` |
| 磁盘满 | `df -h`；`du -sh ~/xa/* \| sort -h`；先清 inbound（第 7 节）和悬空镜像（`docker image prune -f`）；不要 `docker system prune -a --volumes` |
| OOM | `docker inspect -f '{{.State.OOMKilled}}' xa-gateway`；找平台扩虚机，不要只加 `mem_limit` |

OA 只读预检（不建单）：

```bash
docker exec -it xa-gateway sh -c 'export OA_MYSQL_PASSWORD="$(tr -d "\n" < /run/secrets/oa_mysql_password)" OA_API_USER_ID="$(tr -d "\n" < /run/secrets/oa_api_user_id)" OA_APP_SECRET="$(tr -d "\n" < /run/secrets/oa_app_secret)"; node /opt/xa/oa-workflow-bridge/scripts/readonly-preflight.mjs'
```

## 10. OA 结果不明（unknown）对账

员工看到「OA 需要人工核对」，或回执 `RECONCILIATION_REQUIRED`：超时 / 5xx / 返回里没有数字单号时，OA 里可能有单也可能没有。插件已锁住这个人，不能再确认、取消或开新单。**禁止**让员工再点确认，**禁止**自动重试。

OA 明确拒绝（`failed` / `OA_CREATE_REJECTED`）不走本节：那张单已结束，员工重新报即可。

SQL 在能写 `xa_oa` 的机器上执行。

**1. 查库**（确认号 `OA-…` 来自会话 jsonl 或失败回执）：

```sql
SELECT confirmation_id, external_ticket_id, status, request_id, error_code, oa_requester_id,
       FROM_UNIXTIME(created_at / 1000) AS created
  FROM xa_oa.oa_ticket WHERE status IN ('unknown', 'submitting');
```

`request_id` 有值说明 OA 已建单、只是本地没记上。Gateway 在提交中崩溃会停在 `submitting`，同样走本节。

**2. 对 Ecology**：按申请人 `oa_requester_id`、`created` 时间、流程 602、标题前缀 `[IT-…]`（`external_ticket_id`）找有没有数字 `requestId`。

**3a. OA 里有单 → 收成已提交**，并把数字单号告诉员工：

```sql
UPDATE xa_oa.oa_ticket
   SET status = 'submitted', request_id = '<数字单号>', active_sender = NULL,
       draft_json = NULL, staged_json = NULL, updated_at = UNIX_TIMESTAMP() * 1000
 WHERE confirmation_id = 'OA-…' AND status IN ('unknown', 'submitting');
```

**3b. OA 里没单 → 放人重报**：

```sql
UPDATE xa_oa.oa_ticket
   SET status = 'failed', error_code = 'RECONCILED_NOT_IN_OA', active_sender = NULL,
       draft_json = NULL, staged_json = NULL, updated_at = UNIX_TIMESTAMP() * 1000
 WHERE confirmation_id = 'OA-…' AND status IN ('unknown', 'submitting');
```

禁止：删 `oa_ticket` 行；改 `external_ticket_id`；不带 `confirmation_id` 条件批量 UPDATE；不去 OA 核对就把 `unknown` 改 `failed`；改状态时漏了 `active_sender = NULL`（这个人会一直开不了新单）。

## 11. 多套环境与安全

- 同一企微 Bot 只能被一个 Gateway 持有，不要同时 `up` 两套挂了同一 `wecom_bot_*.txt` 的目录。
- 另一套业务用独立目录、容器名、端口、secrets、Bot：`~/xa-hr` / `xa-hr-gateway` / `18790`，测试 `~/xa-staging` / `18791`。可以共用 MySQL 服务器，但必须不同库、不同账号。
- secrets `600`、属主 `1000:1000`；`docker port xa-gateway` 应只绑 `127.0.0.1`。
- 测试环境只用测试机器人，不放生产 BotSecret。
