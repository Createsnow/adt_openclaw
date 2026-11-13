# Ecology 流程创建 API 说明

插件调用的泛微 Ecology HTTP 接口。域名 `https://adtekoa.com`。插件侧状态与错误码见 [OA Workflow Bridge 接入手册.md](OA%20Workflow%20Bridge%20接入手册.md)，身份链路见 [企微到OA身份.md](企微到OA身份.md)。

| 接口 | 用途 | 认证 |
| --- | --- | --- |
| `POST /api/ec/dev/auth/applytoken` | 换 token | `appid` + RSA(secret) |
| `POST /api/workflow/paService/doCreateRequest` | 建单 | token + `appid` + RSA(**申请人**人员 id) |
| `POST /api/workflow/paService/getCreateWorkflowList` | 只读预检：602 是否可建 | token + `appid` + RSA(接口账号人员 id) |
| `GET /api/hrm/simpleinfo/getHrmSimpleInfo?userid=` | 提交前取部门 / 岗位 / 地点 | 同建单 |
| `POST /api/hrm/resful/getHrmUserInfoWithPage` | 按工号查人员 id（身份转换） | 现网只带 `Content-Type`，需 IP 白名单 |

## 1. RSA 加密

用 OA 给的 RSA 公钥（`oa-bridge-config.json` 的 `publicKeySpkiBase64`）分别加密 secret 和 userid：

```java
String secretEncry = rsa.encrypt(null, secret, null, "utf-8", spk, false);   // 换 token 用
String useridEncry = rsa.encrypt(null, userid, null, "utf-8", spk, false);   // 后续接口 Header 用
```

secret 和公钥都是密钥材料，只放 secret 文件和配置，不写进文档或仓库。

## 2. 换 token

`POST /api/ec/dev/auth/applytoken`，无 body，Header：`appid`、`secret` = `secretEncry`。**不带 userid。**

```json
{ "status": true, "code": 0, "msg": "获取成功!", "token": "770a10d8-…" }
```

成功 = `status=true` 且 `code=0` 且有 token。token 默认 30 分钟有效，插件缓存约 25 分钟。

## 3. 建单

`POST /api/workflow/paService/doCreateRequest`，`Content-Type: application/json`。

Header：`token`、`appid`、`userid` = RSA(**申请人**人员 id，与 `xqsqr` 同一人)。用接口账号人员 id 会让单据落到接口账号名下。**不要**写 `Content-Length: 0`，那会把请求体裁空。

```json
{
  "workflowId": "602",
  "requestName": "[IT-20261110-093015-AB12] 电脑死机",
  "otherParams": { "isnextflow": "0", "delReqFlowFaild": "1", "isVerifyPer": "1" },
  "mainData": [
    { "fieldName": "xqsqr", "fieldValue": "13437" },
    { "fieldName": "xqsqbm", "fieldValue": "714" },
    { "fieldName": "gw", "fieldValue": "636" },
    { "fieldName": "bgdd", "fieldValue": "3" },
    { "fieldName": "sqlx", "fieldValue": "0" },
    { "fieldName": "wtlx", "fieldValue": "10" },
    { "fieldName": "wtxqmskftp", "fieldValue": "电脑死机。" },
    { "fieldName": "clry", "fieldValue": "938" }
  ]
}
```

成功 = `code=SUCCESS` 且有数字 `data.requestid`。网络中断、5xx、没有单号都算结果不明（插件记 `unknown`，禁止自动重试）。

`otherParams`：`isnextflow` 取自配置，只允许 `"0"` / `"1"`。现网 `"0"` = 建单成功但停在申请人节点（生产测试开关，不是失败）；`"1"` = 自动流转。`delReqFlowFaild`、`isVerifyPer` 固定 `"1"`。

`mainData` 字段（`fieldValue` 一律字符串）：

| 字段 | 含义 | 必填 | 来源 |
| --- | --- | --- | --- |
| `xqsqr` | 申请人人员 id | 是 | 身份转换 |
| `xqsqbm` / `gw` / `bgdd` | 部门 / 岗位 / 办公地点资源 id | 是 | 提交前 `getHrmSimpleInfo`（接口建单不触发表单联动，必须自己填） |
| `sqlx` | 申请类型：`0` 运维支持、`1` 权限申请、`2` IT 需求 | 是 | 模型给类型，插件转码 |
| `wtlx` / `szxt` / `szxtxq` | 所属系统选项 id，分别对应三种申请类型 | 按类型三选一 | `systems.json` 的 `optionId` |
| `xqlx1` | 需求类型：`0` 流程新建、`1` 流程优化、`2` 数据处理、`3` 集成对接 | IT 需求 | 模型 |
| `yjygsh` | 月节约工时 | IT 需求 | 模型 |
| `wtxqmskftp` | 问题描述，HTML 渲染 | 是 | 员工原文（转义、换行写 `<br/>`）+ 影响范围 / 发生时间 / 已尝试措施 / 最终补充；图片压成 JPEG 以 `<img src="data:image/jpeg;base64,…">` 内嵌。不写内部工单号 |
| `clry` | 处理人人员 id，多人逗号分隔 | 是 | `systems.json` 的 `handlers` |
| `scfj` | 文档附件 | 有文档才写 | 见下 |

`scfj` 的值是数组 `[{"filePath":"base64:<裸 base64>","fileName":"含扩展名"}]` 再 `JSON.stringify` 成字符串。`filePath` 必须带 `base64:` 前缀；发原生数组或裸 base64 都会 `PARAM_ERROR`。只放文档（pdf / office / txt 等），图片走 `wtxqmskftp`。

所属系统选项 id 与处理人 id 的唯一维护处是插件 `systems.json`（OA 选项编号没有 22）。`systemName` 必须与其中名称完全一致，如 `MES系统（越南B部）`。

## 4. 两条人事接口（不要混）

| | 身份点查 | 提交前资料 |
| --- | --- | --- |
| 接口 | `POST /api/hrm/resful/getHrmUserInfoWithPage`（官方拼写 `resful`） | `GET /api/hrm/simpleinfo/getHrmSimpleInfo?userid=<人员 id>` |
| 调用方 | `src/identity/oa-hrm.mjs`，`prepare` 缓存 miss 时 | `src/hrm-profile.mjs`，`submit_confirmed` 建单前 |
| 认证 | 只 `Content-Type`；需 OA 把 Gateway 出口 IP 加白 | 与建单同一套（无 token 返回 `002` 未登录） |
| 输入 | body `{"params":{"workcode":"<工号>"}}` | Query `userid` = Header 里的同一申请人 |
| 产出 | `data.dataList[0].id` | `simpleInfo.departmentid` / `jobtitle` / `locationid` |
| 超时 | 30 秒，不重试 | 30 秒，不重试 |
| 失败 | `OA_IDENTITY_*`，不写待确认单 | `OA_PROFILE_LOOKUP_FAILED` / `OA_PROFILE_INCOMPLETE`，退回待确认，不建单、不标 `unknown` |

`getHrmUserInfoWithPage` 判定：

| 结果 | 条件 |
| --- | --- |
| 成功 | `code="1"`（字符串）且 `data.totalSize=1`，`dataList[0].id` 为 1–18 位数字 |
| 未找到 | `totalSize=0` |
| 多条 | `totalSize>1`，不猜 |
| 账号无效 | `status` 为 `4` 解聘 / `5` 离职 / `6` 退休 / `7` 无效，或 `accounttype=1`（次账号） |

```bash
curl -sS -X POST 'https://adtekoa.com/api/hrm/resful/getHrmUserInfoWithPage' \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data '{"params":{"workcode":"<工号>"}}'
```

返回的人员记录含密码密文、身份证、手机、住址等，只取需要的数字 id，不写日志、不落库、不贴群；每次只查一个人，不当花名册接口扫。用到的字段：`id`（人员 id）、`workcode`（工号）、`status`、`accounttype`、`departmentid`、`jobtitle`、`locationid`。

参考：[Ecology API 文档](https://e-cloudstore.com/ec/api/applist/index.html#/)。
