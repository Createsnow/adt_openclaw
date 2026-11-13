# Ecology 流程创建 API 说明

> 本文档由仓库原文档**重组**而来：只调整章节归属与交叉引用，**不改变**部署步骤、命令、YAML、错误码或禁止事项。阅读顺序见 [README.md](../README.md)。

上游 Ecology HTTP 步骤如下。插件侧字段映射、`otherParams` 现网值与成功判定见 [OA Workflow Bridge 接入手册.md](OA%20Workflow%20Bridge%20接入手册.md) 第 7 节。xA 建单与 `bridge-config.json` 的 `isnextflow` 对齐：现网 `"0"`（创建成功但不自动流转）；**不要**写 `Content-Length: 0`（会把 JSON 请求体裁成空）。

---

## 第一步：获取密钥（RSA 加密）

使用 RSA 公钥对 `userid` 和 `secret` 分别加密，得到加密后的密钥和用户标识。

**xA：** `applytoken` **只**加密 `secret`，请求不带 userid。创建流程时加密的 `userid` 是**申请人**人员 id（与 `xqsqr` 同一人），不是下面示例的 `1101`。公钥以现网 `bridge-config.json` 的 `publicKeySpkiBase64` 为准，不要抄本文示例 `spk`。

### 原始参数

| 参数 | 值 | 说明 |
|------|-----|------|
| `userid` | `1101`（示例） | OA 系统人员 ID |
| `secret` | `459fd617-7536-4815-bea9-fe84dbe54c4e` | 密钥（固定值） |
| `spk` | 见下方公钥 | RSA 公钥（固定值） |

### RSA 公钥（spk）

```
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA551c85LdA//lWyUKqMx2FAnMl2Vqbjqe6S1e6lAoEinkkEPyHZN2ktoWSr/SkNNHrr8g4/cudaoVC+6/SCTh1+XytEt/BAXpUkFVI79HAjDm7dAikAxxHjQ35g8gFRlbAtk0O8jqO8lcVsZVm6pp449JjA6Gt6OsbVqIk3DxariV3qdntxe8juvENgXt6KWWiSJKychmR/HiZVwPJ4HaFkYY7MBGPbHK1vI3d+wNWotSoO/N7mhWX8QyBcNa6FA0Zaiy57DLDWawnL8d8DHyTcgHC47RV15Wn3IywBLo1Fz0jGHQOOkhUSehCgKKAwnATJD/LRlXv5mbq3rKZd+3swIDAQAB
```

### 加密调用

```java
RSA rsa = new RSA();

// 加密 secret，用于获取 token
String secretEncry = rsa.encrypt(null, secret, null, "utf-8", spk, false);

// 加密 userid，用于接口调用
String useridEncry = rsa.encrypt(null, userid, null, "utf-8", spk, false);
```

### 加密输出

| 变量 | 用途 |
|------|------|
| `secretEncry` | 加密后的密钥，在第二步获取 token 时使用 |
| `useridEncry` | 加密后的用户 ID，在后续接口调用时使用 |

---

## 第二步：获取 Token

### 请求信息

| 项目 | 内容 |
|------|------|
| **接口地址** | `https://adtekoa.com/api/ec/dev/auth/applytoken` |
| **请求方式** | `POST` |
| **请求体（Body）** | 无 |

### 请求头部（Headers）

| Header | 值 | 说明 |
|--------|-----|-----|
| `appid` | 以 `bridge-config.json` 的 `appId` 为准（仓库样例 `2026-09-01-lijinjin`；官方示例 `oa-develop` 不要当现网） | 许可证号码 |
| `secret` | `secretEncry` | 第一步得到的 `secretEncry` |

### 返回示例

```json
{
    "msg": "获取成功!",
    "code": 0,
    "msgShowType": "none",
    "status": true,
    "token": "770a10d8-0b15-492b-a614-b2c537b512e5"
}
```

### 返回参数说明

| 参数名 | 类型 | 说明 |
|--------|------|------|
| `status` | boolean | 响应状态。`true`: 成功，`false`: 失败 |
| `code` | String | 响应码。`0` 代表成功 |
| `msg` | String | 响应信息 |
| `msgShowType` | String | 信息显示类型，默认 `"none"` |
| `token` | String | 认证通过的 token 信息（**默认 30 分钟内有效**） |

---

## 第三步：创建流程（Token 认证）

### 请求信息

| 项目 | 内容 |
|------|------|
| **接口地址** | `https://adtekoa.com/api/workflow/paService/doCreateRequest` |
| **请求方式** | `POST` |
| **Content-Type** | `application/json` |

### 请求头部（Headers）

> ⚠️ **`userid` 必填！否则将无法通过 token 认证！**

| Header | 必填 | 类型 | 说明 |
|--------|------|------|------|
| `token` | 是 | string | 第二步返回的 token 信息（默认30 分钟内有效） |
| `appid` | 是 | string | 许可证号码：以 `bridge-config.json` 的 `appId` 为准（仓库样例 `2026-09-01-lijinjin`） |
| `userid` | 是 | string | xA 建单：RSA 加密后的**申请人**人员 id（与 `xqsqr` 同一人）。不要用接口账号人员 id，否则单据落到接口账号头上。只读预检 `getCreateWorkflowList` 仍用接口账号 |
| `Content-Type` | 是 | string | `application/json` |

不要手写 `Content-Length: 0`。有 JSON Body 时由客户端按实际字节计算；写成 `0` 等于无请求体，流程创建会失败或落到空单。xA 插件 `oa-client.mjs` **不**设置该 Header。`applytoken` 仍无 userid；`doCreateRequest` 的 Header `userid` 由 `encryptCredential(pending.oaRequesterId)` 生成。

### 请求体（Body）示例

xA 插件实际发送的 `otherParams` 如下（`isnextflow` 取自 `bridge-config.json`，现网 `"0"`：建单成功但不自动流转，停在申请人节点。这是生产测试开关，不是草稿；项目可用后改成 `"1"` 并重启 Gateway。不要把现网 `"0"` 理解成建单失败）。

```json
{
  "workflowId": "602",
  "requestName": "test20260805",
  "otherParams": {
    "isnextflow": "0",
    "delReqFlowFaild": "1",
    "isVerifyPer": "1"
  },
  "mainData": [
    {
      "fieldName": "xqsqr",
      "fieldValue": "13437"
    },
    {
      "fieldName": "xqsqbm",
      "fieldValue": "714"
    },
    {
      "fieldName": "gw",
      "fieldValue": "636"
    },
    {
      "fieldName": "bgdd",
      "fieldValue": "3"
    },
    {
      "fieldName": "sqlx",
      "fieldValue": "0"
    },
    {
      "fieldName": "wtlx",
      "fieldValue": "16"
    },
    {
      "fieldName": "wtxqmskftp",
      "fieldValue": "测试创建流程接口"
    },
    {
      "fieldName": "clry",
      "fieldValue": "13437"
    }
  ]
}
```

### 请求参数说明

#### 根参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `workflowId` | String | 是 | 流程 ID：602 |
| `requestName` | String | 是 | 流程标题，如 `"test20260805"` |
| `otherParams` | Object | 否 | 其他参数配置 |
| `mainData` | Array | 是 | 主表数据，字段列表见下方 |

#### otherParams 参数

| 参数名 | 类型 | 说明 |
|--------|------|------|
| `isnextflow` | String | 取自 `bridge-config.json`，只允许 `"0"` / `"1"`。现网 `"0"`：建单成功但不自动流转，停在申请人节点。`"1"` 为建单后自动流转（目标口径）。处理人仍须写 `clry` |
| `delReqFlowFaild` | String | xA 固定 `"1"` |
| `isVerifyPer` | String | xA 固定 `"1"` |

官方 `clry` **始终必填**，值为附录对应负责人 id（多人逗号分隔、无空格）。xA 由插件按 `systemName` 取 `systems.json` 的 `handlers` 写入，模型不要传人员 id。现网 `isnextflow` 为 `"0"`（见 `bridge-config.json`）。不要抄官方示例的 `Content-Length: 0`。

#### mainData 字段说明

`mainData` 为数组，每条记录包含 `fieldName`（字段名）和 `fieldValue`（字段值）。

| fieldName | 说明 | 示例值 | 必填条件 |
|-----------|------|--------|----------|
| `xqsqr` | 申请人 ID | `"13437"` | 始终必填 |
| `xqsqbm` | 申请部门资源 ID | `"714"` | 始终必填。`doCreateRequest` 不会触发网页表单联动，须在提交前按申请人现查后写入 |
| `gw` | 岗位资源 ID | `"636"` | 始终必填，来源同上 |
| `bgdd` | 办公地点资源 ID | `"3"` | 始终必填，来源同上 |
| `sqlx` | 申请类型：`0` 运维支持、`1` 权限申请、`2` IT 需求 | `"0"` | 始终必填 |
| `wtlx` | 问题类型（取值见下方对照表） | `"16"` | 申请类型为 **运维支持** 时必填 |
| `szxt` | 所属系统（权限）（取值见下方对照表） | `"2"` | 申请类型为 **权限申请** 时必填 |
| `szxtxq` | 所属系统（需求）（取值见下方对照表） | `"2"` | 申请类型为 **IT 需求** 时必填 |
| `xqlx1` | 需求类型：`0`流程新建、`1`流程优化、`2`数据处理、`3`集成对接 | `"2"` | 申请类型为 **IT 需求** 时必填 |
| `yjygsh` | 月节约工时（H） | `"8"` | 申请类型为 **IT 需求** 时必填 |
| `wtxqmskftp` | 问题/需求描述（可附图片） | 纯文本，或文本后嵌 `<img src="data:image/jpeg;base64,…" />` | 始终必填。xA：先写问题文字（再拼影响范围 / 发生时间 / 已尝试措施 / 最终补充）。inbound **图片**先压缩为 JPEG 再转 base64，以 data URI 嵌在文字后。**不**写 xA 工单号 |
| `scfj` | 需求文档附件 | HTTP `fieldValue` 为 **JSON 字符串**，内容是数组：`"[{\"filePath\":\"base64:<裸base64>\",\"fileName\":\"含扩展名的文件名\"}]"` | 非必填。只写 **文档**（pdf / office / txt 等），不写图片。有文档才写。OA 开发确认字段内容是数组类型；`doCreateRequest` 的 `mainData.fieldValue` 一律是字符串，所以必须 `JSON.stringify` 后再放入。`filePath` 须带 Ecology 附件前缀 `base64:`，不要发 native 数组或裸 base64（现网均 `PARAM_ERROR`）。xA：`attachmentFieldName=scfj`，`filePath` 为 `base64:` + staging 转出的裸 base64，不传外链；该配置为空时**带文档**必须拒绝，不能只留「原件见企微」后报成功。仅有图片、无文档时不写 `scfj` |
| `clry` | 处理人员 | `"13437"` | 始终必填。值为附录对应负责人 id，多人逗号分隔。xA 由插件按所属系统写入，模型不传 |

有文档时 `mainData` 追加一条 `scfj`。OA 开发确认该字段**内容**是 `[{"filePath":"base64:<裸base64>","fileName":"含扩展名"}]` 数组；HTTP 上 `fieldValue` 必须写成该数组的 JSON 字符串，与其它 `mainData` 字段一样都是 string。`filePath` 必须带 `base64:` 前缀。不要发 native 数组或裸 base64。图片走 `wtxqmskftp` 内嵌，不要抄 OA 示例里的外链图，也不要把 png/jpg 放进 `scfj`。

---

## 附录：（wtlx、szxt、szxtxq）对应表

| ID | 系统/问题类型 | 对应负责人 | 对应负责人 id |
|----|--------------|-----------|-----------|
| 2 | OA 系统 | 易淑恒、周晓慧 | 4280,8134 |
| 3 | 企业微信 | 易淑恒、周晓慧 | 4280,8134 |
| 4 | ERP（金蝶）系统 | 林渊、邹茜茜 | 4649,9673 |
| 5 | 邮箱系统（国内） | 郑鹏程 | 938 |
| 6 | MES 系统（大磡） | 汤洲操、刘镇涛、何亮、肖浩华、谢宗辽 | 20445,7718,2893,10773,3681 |
| 7 | MES 系统（深汕） | 吴梓炯、蒙东林 | 8049,8050 |
| 8 | MES系统（越南B部） | 庞立亮、阮氏秋香 | 18196,10251 |
| 9 | 文件管理系统（国内） | 郑鹏程 | 938 |
| 10 | 电脑/打印机/网络问题（智园） | 郑鹏程 | 938 |
| 11 | 电脑/打印机/网络问题（大磡） | 莫嘉权 | 5957 |
| 12 | 电脑/打印机/网络问题（深汕） | 张威 | 4062 |
| 13 | 电脑/打印机/网络问题（越南） | 黄文明、阮世山、新文雄 | 6161,8232,8254 |
| 14 | 电脑/打印机/网络问题（光明） | 莫嘉权 | 5957 |
| 15 | 电脑/打印机/网络问题（泗洪） | 吴东东 | 27675 |
| 16 | OA 开发支持 | 林芷彤 | 13437 |
| 17 | 其他 | 易淑恒 | 4280 |
| 18 | ERP 开发支持 | 林炎 | 24697 |
| 19 | 北森招聘系统 | 周晓慧 | 8134 |
| 20 | 文件管理系统（越南） | 吴宇文 | 8254 |
| 21 | 邮箱系统（越南） | 吴宇文 | 8254 |
| 23 | MES系统（越南C部） | 庞立亮、阮名孟、范文南、新文雄、绍氏欣 | 18196,27697,27507,27338,9777 |
| 24 | 法大大电子签平台 | 邹茜茜 | 9673 |

OA 选项编号从 21 跳到 23，没有 22。xA 的 `systemName` 必须与 `systems.json` 名称一致（含括号，无「OA 系统」那种空格）：`邮箱系统（国内）`、`文件管理系统（国内）`、`MES系统（越南B部）`。`clry` 写入 `systems.json` 中的负责人 id，不是状态卡上的姓名。

## 第四步：两条人事接口（不要混）

生产有两次调 OA 人事，**不是同一个接口**。对照只在这里写全 HTTP；链路位置见 [../xA 现网加固与演进全景.md](../xA%20现网加固与演进全景.md) 第 7 节。

| | 身份点查（身份转换，`prepare` miss） | 提交前资料（桥接，`submit_confirmed`） |
| --- | --- | --- |
| **接口** | `POST /api/hrm/resful/getHrmUserInfoWithPage` | `GET /api/hrm/simpleinfo/getHrmSimpleInfo?userid=` |
| **谁调用** | `oa-workflow-bridge/src/identity/oa-hrm.mjs` | `oa-workflow-bridge/src/hrm-profile.mjs` → `OAClient.authenticatedRequest` |
| **认证** | 只 `Content-Type`，**无** token / appid / userid | token + `appid` + RSA(**申请人**)；与 `doCreateRequest` 同一套钥匙 |
| **查找键** | `params.workcode` = 工号 | Query `userid` = 已映射的数字人员 id |
| **成功产出** | `data.dataList[0].id` → `oa_identity` 缓存 / Header `userid` / `xqsqr` | `simpleInfo.departmentid` / `jobtitle` / `locationid` → `xqsqbm` / `gw` / `bgdd` |
| **失败码** | `OA_IDENTITY_NOT_FOUND` / `AMBIGUOUS` / `INACTIVE` / `LOOKUP_FAILED` | `OA_PROFILE_LOOKUP_FAILED` / `OA_PROFILE_INCOMPLETE` |
| **失败时建单** | 不写 pending、不建单 | pending 退回 awaiting，**不建单、不标 `unknown`** |

路径拼写是官方的 `resful`，不是 `restful`。`applytoken` / `doCreateRequest` / `getCreateWorkflowList` **仍然**要认证 Header。不要把身份点查的「现网可不带头」推广到建单或资料现查。

### 用工号查人员 id（身份转换）

用于：已知 **工号** 时查出 OA 内部人员 `id`（写入 `oa_api_user_id.txt`，或由身份转换写入 `oa_identity` 缓存）。

⚠️ **访问该接口需联系 OA 管理员把 Gateway 出口 IP 加入白名单。** 现网身份点查走此接口；白名单未开时会表现为人事 HTTP 失败（`OA_IDENTITY_LOOKUP_FAILED`），不要当成工号写错就换接口。

### 请求信息

| 项目         | 内容                                                        |
| ------------ | ----------------------------------------------------------- |
| **接口地址** | `https://adtekoa.com/api/hrm/resful/getHrmUserInfoWithPage` |
| **请求方式** | `POST`                                                      |
| **Content-Type** | `application/json; charset=utf-8`                       |
| **请求头**   | 见下方现网实测。官方 Token 文档对多数业务接口要求 `token` + `appid` + 加密 `userid`；**本接口在现网可无 Header** |

### 现网实测（2026-09-01，`https://adtekoa.com`）

只 POST JSON Body、**不带** `token` / `appid` / `userid`，按工号可以返回人员记录。成功时 `code` 为 `"1"`（字符串），人员资源 id 在 **`data.dataList[].id`**（不是根级 `id`，也不是工号、登录名）。

```bash
curl -sS -X POST 'https://adtekoa.com/api/hrm/resful/getHrmUserInfoWithPage' \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data '{"params":{"workcode":"工号"}}'
```

| 判定 | 条件 |
| --- | --- |
| 成功 | `code="1"` 且 `data.totalSize>=1`，取唯一一条 `dataList[].id`（1–18 位纯数字） |
| 未找到 | `totalSize=0` 或 `dataList` 空 |
| 多条 | `totalSize>1`：禁止猜，改人工核对 |
| Body 损坏 | 曾返回 `{"code":"-1","msg":"获取分页元素错误：null"}` |

`status`：`0`试用 `1`正式 `2`临时 `3`试用延期 `4`解聘 `5`离职 `6`退休 `7`无效。绑接口账号或申请人时，`4/5/6/7` 应拒绝。次账号（`accounttype=1`）不要直接当申请人。

### 提交前：按人员 id 读取部门 / 岗位 / 办公地点

`doCreateRequest` 只写 `xqsqr` 时，申请部门、岗位、办公地点会空。桥接在 `submit_confirmed`、调建单之前调用本接口，把资源 ID 写入 `xqsqbm` / `gw` / `bgdd`。查不到或任一 ID 不是 `1–18` 位数字则 **fail-closed，不建单**。处理人 `clry` 另按附录写入，不从本接口读取。

| 项目 | 内容 |
| --- | --- |
| **接口地址** | `GET https://adtekoa.com/api/hrm/simpleinfo/getHrmSimpleInfo?userid=<OA人员id>` |
| **请求头** | 与 `doCreateRequest` 相同：`token` + `appid` + RSA 加密**申请人**人员 id。Query `userid` 与 Header 解密后的人员 id 必须是同一人。无 token 时现网返回 `status=false`、`errorCode=002`（未登录） |
| **超时 / 重试** | 30 秒；同一请求不重试。`002` / 网络失败记 `OA_PROFILE_LOOKUP_FAILED`，**不要**标 ledger `unknown` |
| **写入建单** | `simpleInfo.departmentid` → `xqsqbm`；`simpleInfo.jobtitle` → `gw`；`simpleInfo.locationid` → `bgdd`。兼容顶层 / `data` 包裹与驼峰别名。**不要**用 `departmentName` / `fieldInfo` 的中文名当资源 ID |

禁止把完整响应（姓名、手机等）写入日志、数据库、员工回复或仓库。只保留三个数字资源 ID，且只在提交当次内存里使用，不写 pending。

**安全：** 响应含密码密文、身份证、手机、住址等。只抄三个资源 ID。匿名可查已被现网收回（`002`）；不要再裸调。不要当全员花名册扫描接口。

**运行时：** 桥接 `submit_confirmed` 经 **同一** `OAClient` 实例先 `getHrmSimpleInfo`、再 `doCreateRequest`（Header 都是申请人）。token 缓存约 25 分钟，通常只 `applytoken` 一次。身份适配器人事点查仍是 `getHrmUserInfoWithPage`（只 POST `params.workcode`，**不带**认证 Header），与本接口不是同一个。

### 请求体（Body）示例

```json
{
    "params":{
        "workcode" : "test1"	// 工号
    }
}
```

### 返回参数说明

```json
{
    "code":"1", // 1 成功，其他失败
    "data":{
        "totalSize":1, // 分页-总数
        "dataList":[ // 数据列表
            {
                "tempresidentnumber":"xxxx", // 暂住证号码
                "person_custom_data":{ // 个人自定义数据 
                    "field6":"2020-09-10"
                },
                "createdate":"2019-08-28", // 创建日期
                "language":"", // 系统语言
                "subcompanyid1":"5", // 分部id
                "subcompanyname":"yhm-主分部A", // 分部名称
                "joblevel":"0", // 职级
                "startdate":"", // 合同开始日期
                "password":"lK1l5Yaeg5csNkZvr/uaYnioLAv02khMFnUS9/pv8Tg=", // 密码 密文
                "subcompanycode":"", // 分部编码
                "jobactivitydesc":"xxxx", // 职责描述
                "bememberdate":"2010-08-08", // 入团日期
                "modified":"2020-09-09 19:46:40", // 修改时间
                "id":"3", // 人员id
                "mobilecall":"123456", // 其他电话
                "nativeplace":"湖北", // 籍贯
                "certificatenum":"1", // 身份证
                "height":"0", // 身高
                "loginid":"yhm01", // 登录名
                "created":"2019-08-28 10:44:12", // 创建日期(旧字段) 
                "degree":"xxx", // 学位
                "bepartydate":"2010-08-10", // 入党日期
                "weight":"110", // 体重
                "telephone":"123", // 办公电话
                "residentplace":"xxxx", // 户口
                "lastname":"yhm01tt", // 人员名称
                "healthinfo":"1", // 健康状况
                "enddate":"", // 合同结束日期
                "maritalstatus":"已婚", // 婚姻状况
                "departmentname":"yhm-主分部A-下级部门一", // 部门名称
                "folk":"汉", // 民族
                "status":"1", // 状态:0试用 1正式 2临时 3试用延期 4解聘 5离职 6退休 7无效 
                "birthday":"2010-10-10", // 生日
                "accounttype":"0", // 主次账号标志：   1 次账号 , 其他 主账号
                "jobcall":"2", // 职称 
                "managerid":"0", // 上级人员id
                "assistantid":"0", // 助理人员id
                "departmentcode":"", // 部门编码
                "belongto":"", // 主账号id （当accounttype 为 1 有效）
                "email":"123123123@123.com", // 邮箱
                "seclevel":"10", // 安全级别
                "policy":"团员", // 政治面貌
                "jobtitle":"2", // 岗位id
                "workcode":"yhm01tt", // 编号
                "sex":"男",  // 性别
                "departmentid":"2", // 部门id
                "homeaddress":"xxxx", // 家庭联系方式
                "mobile":"123123123", // 移动电话
                "lastmoddate":"2020-09-09", // 最后修改日期
                "educationlevel":"3", // 学历
                "islabouunion":"0", // 工会会员
                "base_custom_data":{ // 基本信息自定义数据
                    "field1":"test_yhm01",
                    "field3":"liul部门1,liul部门2",
                    "field2":"测试人员1"
                },
                "locationid":"2", // 办公地点
                "regresidentplace":"武汉", // 户口
                "dsporder":"3.0" // 排序
            }
        ],
        "pageSize":20, // 分页-单页条目数
        "page":1 // 分页-当前页数
    }
}
```
