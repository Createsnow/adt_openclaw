# xA 提示词规则说明

一页说清：规则放在哪、为什么这样分工、改规则时要同步什么、`openclaw.json` 里哪几项不能漏。

## 1. 分工：模型只做判断，插件做确定的事

| 谁 | 负责 |
| --- | --- |
| 模型（`workspace/AGENTS.md`） | 判断消息属于哪一类（问候 / 问进度 / 口令 / 补件 / 新问题）、按关键词匹配类型与系统、需要时追问、整理 `problemDescription` |
| 插件（`oa_workflow`） | 未命中兜底（运维支持 / 其他）、问题预览截取、A–F 地点翻译、替换旧待确认单、附件收取与去重、幂等、建单，以及**员工看到的整段回复 `replyZh`** |

复盘的教训是「规则堆叠不等于可靠」：原 AGENTS.md 约 3.6 万字、两百多处「禁止 / 不要」，大半是在教模型拼卡片格式。现在卡片由插件按回执生成（`OA_tool/oa-workflow-bridge/src/reply.mjs`），AGENTS.md 约 9 千字，只剩判断规则和没调工具时的几句追问。

## 2. 文件

| 文件 | 用途 |
| --- | --- |
| `workspace/AGENTS.md` | 唯一运行规则：决策树、口令、匹配规则（含未命中兜底）、系统表、区域、追问短句、工具用法 |
| `workspace/IDENTITY.md` / `SOUL.md` / `USER.md` / `MEMORY.md` / `HEARTBEAT.md` | 身份、语气、多用户声明、记忆索引、心跳，都很短 |
| `OA_tool/oa-workflow-bridge/systems.json` | 系统名 → OA 选项 ID、处理人 id、处理人姓名、允许类型 |

OpenClaw 会话开始时注入上述 workspace 文件；热路径**不** `read` 任何文件。

## 3. 改规则时要同步的

| 改什么 | 同步到 |
| --- | --- |
| 系统名、处理人、类型允许清单 | `systems.json` 与 AGENTS.md「系统 → 建议责任人」表；`npm test`（`workspace-sync.test.mjs`）会校验两边一致 |
| 员工看到的卡片文字 | `src/reply.mjs` / `src/hints.mjs`，不是 AGENTS.md |
| 关键词、匹配顺序、追问短句 | 只改 AGENTS.md |

同步到现网：

```bash
cp -r "$REPO/workspace-rules/workspace/." ~/xa/workspace/
```

工作区 Markdown 下一轮对话生效；插件代码或 `systems.json` 改了要重建镜像并 `down && up`（见安装手册第 5 节）。

## 4. `openclaw.json` 里不能漏的

- `agents.defaults.skipBootstrap: true`：防止运行时重新生成官方空规则；不影响注入已有 AGENTS.md。
- `bootstrapMaxChars: 40000` 与 `skills: []` 写在 **defaults 和 `itservicedeskagent` 两处**。只写 defaults 对已绑定 Agent 不生效；不写 `skills: []` 企微插件的 `wecomcli-*` 会进 prompt。
- 两处 `tools.alsoAllow` 只有 `oa_workflow`；Agent `deny` 含 `group:fs` 等。

改完：`config validate` → restart Gateway → 企微里单独发 `/new`，再单独发 `/context detail`。通过标准：`AGENTS.md` 为 `OK`（未截断）、`Skills list` 为 0。字段说明见 [openclaw.json 配置参考.md](../openclaw.json%20配置参考.md) 第 2 节。

## 5. 不要做的事

- 不要把卡片模板写回 AGENTS.md，也不要让模型改写 `replyZh`。
- 不要在提示词里教模型 OA 字段名、接口、数据库表、哈希规则。
- 不要把 `skills.entries.*.enabled: false` 当成 Skill 全关。
- 不要用 `openclaw doctor --fix` 做生产上的第一次试验。
