import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadSystems } from "../src/config.mjs";

const AGENTS_URL = new URL("../../../workspace-rules/workspace/AGENTS.md", import.meta.url);

/** 读 AGENTS.md「系统 → 建议责任人」表，按文中规则推出三类工单允许的系统。 */
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

test("AGENTS.md 三类系统清单与 systems.json 一致", async () => {
  const fromAgents = parseAgentSystemLists(await readFile(AGENTS_URL, "utf8"));
  const { typeSystems } = await loadSystems();
  for (const ticketType of ["运维支持", "权限申请", "IT需求"]) {
    assert.deepEqual([...fromAgents.get(ticketType)].sort(), [...typeSystems.get(ticketType)].sort(), `${ticketType} 系统名不一致`);
  }
});

test("兜底系统「其他」在三类工单里都允许，且 AGENTS.md 写明了未命中兜底", async () => {
  const markdown = await readFile(AGENTS_URL, "utf8");
  const { typeSystems } = await loadSystems();
  for (const ticketType of ["运维支持", "权限申请", "IT需求"]) {
    assert.equal(typeSystems.get(ticketType).has("其他"), true);
  }
  assert.match(markdown, /未命中兜底/);
});
