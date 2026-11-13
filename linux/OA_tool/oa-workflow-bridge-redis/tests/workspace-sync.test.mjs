import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadSystemHandlers, loadSystemOptions, loadTicketTypeSystems } from "../src/config.mjs";

function parseAgentSystemLists(markdown) {
  const all = [];
  let inTable = false;
  for (const line of markdown.split(/\n/)) {
    if (line.startsWith("### 系统 → 建议责任人")) {
      inTable = true;
      continue;
    }
    if (inTable && /^## /.test(line)) break;
    if (!inTable || !line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    const name = cells[0];
    if (!name || name === "所属系统" || /^-+$/.test(name.replace(/\s/g, ""))) continue;
    all.push(name);
  }

  const computers = all.filter((name) => name.startsWith("电脑/打印机/网络问题"));
  const permissionExclude = new Set([...computers, "OA开发支持", "ERP开发支持", "北森招聘系统"]);
  const demandExclude = new Set([...permissionExclude, "邮箱系统（国内）"]);
  return new Map([
    ["运维支持", new Set(all)],
    ["权限申请", new Set(all.filter((name) => !permissionExclude.has(name)))],
    ["IT需求", new Set(all.filter((name) => !demandExclude.has(name)))],
  ]);
}

test("AGENTS.md 三类系统清单与 ticket-type-systems.json 一致", async () => {
  const markdown = await readFile(new URL("../../../openclaw/workspace-rules/AGENTS.md", import.meta.url), "utf8");
  const fromAgents = parseAgentSystemLists(markdown);
  const fromPlugin = await loadTicketTypeSystems();
  for (const ticketType of ["运维支持", "权限申请", "IT需求"]) {
    const expected = [...(fromPlugin.get(ticketType) || [])].sort();
    const actual = [...(fromAgents.get(ticketType) || [])].sort();
    assert.deepEqual(actual, expected, `${ticketType} 系统名不一致`);
  }
});

function keywordLines(markdown, heading) {
  const lines = markdown.split(/\n/);
  const start = lines.findIndex((line) => line.includes(heading));
  assert.notEqual(start, -1, `missing heading ${heading}`);
  const collected = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    const match = line.match(/^- [^：]+：`([^`]+)`/);
    if (match) collected.push(match[1]);
  }
  return collected;
}

test("AGENTS.md 与 MAPPING_RULES.md 关键词表一致", async () => {
  const agents = await readFile(new URL("../../../openclaw/workspace-rules/AGENTS.md", import.meta.url), "utf8");
  const mapping = await readFile(new URL("../../../openclaw/MAPPING_RULES.md", import.meta.url), "utf8");
  assert.deepEqual(keywordLines(agents, "## 匹配规则"), keywordLines(mapping, "## 工单类型关键词").concat(keywordLines(mapping, "## 问题关键词库")));
});

test("AGENTS.md 出现的系统名都能映射到 options 与 handlers", async () => {
  const markdown = await readFile(new URL("../../../openclaw/workspace-rules/AGENTS.md", import.meta.url), "utf8");
  const fromAgents = parseAgentSystemLists(markdown);
  const options = await loadSystemOptions();
  const handlers = await loadSystemHandlers();
  const names = new Set();
  for (const list of fromAgents.values()) {
    for (const name of list) names.add(name);
  }
  for (const name of names) {
    assert.equal(options.has(name), true, `缺少 system-options：${name}`);
    assert.match(handlers.get(name) || "", /^[1-9]\d{0,17}(,[1-9]\d{0,17})*$/, `缺少 handlers：${name}`);
  }
  for (const name of options.keys()) {
    assert.equal(names.has(name), true, `AGENTS.md 缺少系统：${name}`);
  }
});
