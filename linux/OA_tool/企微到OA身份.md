# 企微到 OA：身份

讲清楚：谁在调 OA 接口、谁是申请人、企微通道给了什么、加密 userid 怎么变成 OA 人员 id、出错怎么查。部署见[安装手册](../OpenClaw%20Gateway%20Linux%20服务器安装手册.md)，OA 接口与建单字段见 [Ecology 流程创建 API 说明.md](Ecology%20流程创建%20API%20说明.md)，工具契约见 [OA Workflow Bridge 接入手册.md](OA%20Workflow%20Bridge%20接入手册.md)。

## 1. 结论

- 企微智能机器人推来的 `from.userid` 是 **`wo` 开头的加密 userid**（机器人不是超级管理员创建时都这样），不是明文账号，也不是工号。
- 本企业企微明文 userid 就是 OA 工号。OA 建单要的是**数字人员 id**，只能按工号查。
- 所以链路是：加密 userid →（企微自建应用）明文 userid = 工号 →（OA 人事接口）人员 id → 缓存到 `oa_identity`。
- 员工不用报工号；查找键是 `mappingCode` = SHA-256(加密 userid 转小写) 前 24 位。原始 userid、明文 userid、工号都不落库、不打日志、不回给员工。

## 2. 四种身份，不要混

| 名称 | 形态 | 放在哪 | 用在哪 |
| --- | --- | --- | --- |
| appid | 如 `2026-09-01-xxxx` | `oa-bridge-config.json` 的 `appId` | 每个 Ecology 请求 Header `appid` |
| AppSecret | UUID 形态 | `oa_app_secret.txt` → `OA_APP_SECRET` | 只在 `applytoken` 时 RSA 加密后用 |
| 接口账号人员 id | 1–18 位数字 | `oa_api_user_id.txt` → `OA_API_USER_ID` | 只用于只读预检 Header `userid` |
| **申请人人员 id** | 1–18 位数字 | `oa_identity` 缓存、工单 `oa_requester_id` | 建单 Header `userid`（RSA）、表单 `xqsqr`、提交前 `getHrmSimpleInfo` |

**建单 Header `userid` 必须是申请人。** 用接口账号的话，单据会落在接口账号名下，即使 `xqsqr` 填了员工。管理员还要确认该应用能以员工身份创建流程 602（`isVerifyPer=1`）。

接口账号人员 id 不知道时，用该账号工号调 `getHrmUserInfoWithPage` 自查（见 Ecology 文档第四步），只抄 `data.dataList[].id`。不要把 appid、工号、`wo…` 写进 `oa_api_user_id.txt`。

AGENTS.md 里的「建议责任人」是给员工看的姓名，不是身份映射；OA 处理人 id 在 `systems.json`。

## 3. 通道给了什么

`aibot_msg_callback` body 里有 `msgid`、`aibotid`、`chattype`（`single` / `group`）、`chatid`（群）、`from.userid`（加密）、`msgtype`、正文或附件 url、`response_url`（敏感）。**没有**姓名、部门、工号、OA 人员 id。

企微插件写进 OpenClaw 后，`SenderId` = `from.userid`，到 `oa_workflow` 的可信上下文是：

```text
messageChannel = wecom
requesterSenderId = from.userid（加密串，模型改不了）
sessionKey / sessionId
```

群聊按实际发送人建单，不能用 `chatid` 代替人。核对现网形态（不要把完整值贴出去）：

```bash
docker logs xa-gateway --since 10m 2>&1 | grep -E 'aibot_msg_callback|"userid"'
```

## 4. 转换流水线

代码在 `oa-workflow-bridge/src/identity/`，是 Gateway 进程内模块，由 `prepare` 调用；不是独立服务，不注册工具。开关 `bridge-config.json` 的 `identity.adapter`（现网 `on`）。

| 序 | 动作 | 失败码 |
| --- | --- | --- |
| 1 | 校验 senderId，算 `mapping_code` | `WECOM_IDENTITY_INVALID_SENDER` |
| 2 | 查 `oa_identity`：有未过期人员 id 直接用（零外部 HTTP） | — |
| 3 | 有未过期 `miss_code`：直接返回该码 | 上次的码 |
| 4 | 读 `WECOM_IDENTITY_CORPID` / `WECOM_IDENTITY_SECRET` | `OA_IDENTITY_NOT_CONFIGURED` |
| 5 | 企微 `gettoken`（缓存 90 分钟）→ `user/get`；失败回退 `batch/openuserid_to_userid` | `WECOM_IDENTITY_TOKEN_FAILED` / `WECOM_IDENTITY_OUT_OF_SCOPE`（81013 / 60011，不回退）/ `WECOM_OPENUSERID_INVALID` |
| 6 | 对齐工号：扩展属性「工号」若存在必须等于明文 userid，否则拒绝 | `WECOM_IDENTITY_ALIGN_MISMATCH` |
| 7 | `POST /api/hrm/resful/getHrmUserInfoWithPage`，body `{"params":{"workcode":"<工号>"}}`，只带 `Content-Type`（需 OA 把 Gateway 出口 IP 加白）；要求 `code="1"` 且 `totalSize=1` | 0 条 `OA_IDENTITY_NOT_FOUND`；多条 `OA_IDENTITY_AMBIGUOUS`；`status` ∈ 4/5/6/7 或 `accounttype=1` → `OA_IDENTITY_INACTIVE`；其他 `OA_IDENTITY_LOOKUP_FAILED` |
| 8 | 写 `oa_identity`，24 小时 | — |

- 企微、人事请求都**不自动重试**（企微超时 20 秒，人事 30 秒）。失败写 10 分钟负缓存，但 `OA_IDENTITY_NOT_CONFIGURED` 和 `WECOM_IDENTITY_TOKEN_FAILED` 不写，补完凭据马上能用。
- 身份失败时不写工单、不调建单。
- 回给模型的只有 `ok` / `code` / `message`，员工看到的话由插件 `hintZh` 给：账号类问题是「还不能提交到 OA」，查询失败类是「确认准备失败」。
- 人事接口返回的整段 `dataList` 含敏感字段，不写日志、不落库；每次只查当前发送人，不扫花名册。

提交时另有一条人事接口 `getHrmSimpleInfo`（token + RSA 申请人），取部门 / 岗位 / 地点，由 `hrm-profile.mjs` 调，不属于身份转换，失败只退回待确认。

## 5. 缓存 `oa_identity`

| 列 | 说明 |
| --- | --- |
| `mapping_code` | 主键，24 位 hex |
| `oa_user_id` | 命中时的人员 id |
| `miss_code` | 负缓存错误码 |
| `expires_at` | 毫秒时间戳，到期视为不存在，定时删除 |

身份只有这一套缓存，不要另做映射文件或花名册。员工调岗 / 离职要立刻生效，删掉该行，下次 `prepare` 重新查：

```sql
SELECT oa_user_id, miss_code, FROM_UNIXTIME(expires_at / 1000) FROM xa_oa.oa_identity WHERE mapping_code = '<24 位 hex>';
```

手工排查一个 open_userid（默认不读写缓存；`--write-cache` 写缓存；`--show-userid` 打印明文 userid，只在本机看）：

```bash
docker exec -it xa-gateway node /opt/xa/oa-workflow-bridge/scripts/manual-resolve.mjs <open_userid>
```

## 6. 配置与凭据

| 位置 | 内容 |
| --- | --- |
| `oa-bridge-config.json` | `appId`、`publicKeySpkiBase64`（新应用给了新公钥要换）、`"identity": {"adapter": "on"}` |
| `secrets/oa_app_secret.txt`、`oa_api_user_id.txt` | OA 凭据 |
| `secrets/wecom_identity_corpid.txt`、`wecom_identity_secret.txt` | 企微**自建应用**凭据（不是机器人 BotSecret）；员工要在该应用可见范围内 |
| `openclaw.json` | 不涉及 |

只在宿主机写 txt 不够：必须 compose 声明 secret、entrypoint export、`down && up`（仓库 `docker/` 已写好）。

上线自检：只读预检通过 → 测试号 `prepare` 得到 `AWAITING_CONFIRMATION`，`oa_identity` 多一行。预检码含义：`TOKEN_REJECTED` = secret / appid / 公钥有一个不对；`INVALID_CONFIGURATION` / `NOT_CONFIGURED` = 接口账号人员 id 缺失或不是纯数字。

## 7. 排障：员工说「还不能提交到 OA」

`oa_workflow` 回执不写 stdout，`docker logs | grep OA_IDENTITY` 为空是正常的，要去会话 jsonl 里看。

先看转换凭据是否注入（只判断有无）：

```bash
docker exec xa-gateway sh -c 'test -s /run/secrets/wecom_identity_corpid && test -s /run/secrets/wecom_identity_secret && echo FILES_OK || echo FILES_MISSING'
docker exec xa-gateway sh -c 'for d in /proc/[0-9]*; do tr "\0" "\n" < "$d/environ" 2>/dev/null | grep -q "^WECOM_IDENTITY_SECRET=" && { echo INJECTED; exit 0; }; done; echo NOT_INJECTED'
```

`FILES_MISSING` = compose 没挂；`FILES_OK` + `NOT_INJECTED` = entrypoint 没 export 或没 `down && up`。

再抽最新会话里的 `oa_workflow` 回执码（不要 `cat` 整份 jsonl，里面有加密 userid）：

```bash
python3 - <<'PY'
import json, re, pathlib
sess = pathlib.Path.home() / "xa/config/agents/itservicedeskagent/sessions"
files = [p for p in sess.glob("*.jsonl") if ".trajectory." not in p.name and ".reset." not in p.name]
p = max(files, key=lambda x: x.stat().st_mtime)
print("FILE", p.name)
codes = re.compile(r"(OA_IDENTITY_[A-Z_]+|WECOM_IDENTITY_[A-Z_]+|AWAITING_CONFIRMATION)")
for i, line in enumerate(p.open(encoding="utf-8", errors="replace"), 1):
    try: o = json.loads(line)
    except Exception: continue
    name = o.get("toolName") or o.get("name") or (o.get("message") or {}).get("toolName")
    if name == "oa_workflow":
        print(f"L{i}", sorted(set(codes.findall(json.dumps(o, ensure_ascii=False)))))
PY
```

| 回执 `code` | 处理 |
| --- | --- |
| `OA_IDENTITY_NOT_CONFIGURED` | 补 compose / entrypoint，`down && up`。不要改 `adapter=off` 绕过 |
| `WECOM_IDENTITY_TOKEN_FAILED` | 自建应用 secret 不对（别用 BotSecret） |
| `WECOM_IDENTITY_OUT_OF_SCOPE` | 把员工加进该自建应用可见范围 |
| `WECOM_IDENTITY_ALIGN_MISMATCH` | 企微账号与扩展属性「工号」不一致，找企微管理员 |
| `OA_IDENTITY_NOT_FOUND` / `OA_IDENTITY_INACTIVE` | OA 里按工号查不到或账号无效，找 OA 管理员 |
| `AWAITING_CONFIRMATION` | 身份已通 |

## 8. 禁止

- 把 appid、工号、登录名、`wo…` 加密串、接口账号人员 id 当作申请人或 `xqsqr`。
- 按姓名模糊匹配申请人；让员工自报工号当正式绑定。
- 把身份转换或人事查询做成模型可调工具；给身份 HTTP 加自动重试。
- 把 `response_url`、完整 `from.userid`、人事返回 JSON、secret 写进仓库、日志或群聊。
- 把身份映射文件放进 workspace 或 `.openclaw`（Agent 可能读到）。

参考：[企微智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463)、[openuserid_to_userid](https://developer.work.weixin.qq.com/document/path/101521)。
