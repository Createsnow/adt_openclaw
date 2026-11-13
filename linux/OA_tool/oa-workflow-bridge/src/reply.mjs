/**
 * 员工在企微里看到的整段回复（replyZh）。插件按回执拼好，模型原样转发，不再自己套模板。
 * 格式要点（企微 Markdown）：状态 emoji 与 `**` 之间留空格；`---` 前后各空一行，否则上一行会被放大成标题。
 */

const SEP = "\n\n---\n\n";

export function attachmentText({ imageCount = 0, documentCount = 0 } = {}) {
  const parts = [];
  if (Number(imageCount) > 0) parts.push(`${Number(imageCount)}份图片`);
  if (Number(documentCount) > 0) parts.push(`${Number(documentCount)}份文档`);
  return parts.join("、");
}

function ticketLines({ summary, location, imageCount, documentCount }) {
  const attachments = attachmentText({ imageCount, documentCount });
  return [
    `💬 问题：${summary || ""}`,
    location ? `📍 地点：${location}` : "",
    attachments ? `📎 附件：${attachments}` : "",
  ].filter(Boolean);
}

const CHOICES = ["**请回复**", "1. 确认提交", "2. 取消"].join("\n");

/** 本会话确认卡。 */
export function confirmCard(card) {
  const guide = attachmentText(card)
    ? "还可以继续改文字，或再发图片、文档。"
    : "内容不对或还缺信息，直接再写一句，或发图片、文档。";
  return ["📋 **当前工单**", "", ...ticketLines(card), "", guide].join("\n") + SEP + CHOICES;
}

/** 在另一个对话里留下的待确认单（私聊 ↔ 群聊、`/new` 之后）。 */
export function otherSessionCard(card) {
  return [
    "🔍 你有一张未提交的确认单（在另一个对话里建的）。",
    "",
    ...ticketLines(card),
  ].join("\n") + SEP + CHOICES + SEP + [
    "> 在这里发的图片、文件不会补到这张单上。",
    "> 直接说新问题，会作废这张、按新问题建单。",
    "> 24 小时内未确认或取消，这张会自动清除。",
  ].join("\n");
}

export function submittedCard({ summary, location, imageCount, documentCount, requestId, handlerNames }) {
  return [
    "✅ **已提交到 OA**",
    "",
    ...ticketLines({ summary, location, imageCount, documentCount }),
    /^\d+$/.test(String(requestId || "")) ? `🎫 工单号：${requestId}` : "",
    handlerNames ? `👤 处理人：${handlerNames}` : "",
  ].filter((line, index) => line || index === 1).join("\n");
}

export function inactiveCard({ handlerNames } = {}) {
  return [
    "ℹ️ **已确认，但还不能创建 OA 工单**",
    "🎫 工单号：待提交 OA",
    handlerNames ? `👤 处理人：${handlerNames}` : "",
  ].filter(Boolean).join("\n");
}

export function reconcileCard({ requestId, handlerNames } = {}) {
  return [
    "⚠️ **OA 需要人工核对**",
    /^\d+$/.test(String(requestId || "")) ? `🎫 工单号：${requestId}` : "",
    handlerNames ? `👤 处理人：${handlerNames}` : "",
  ].filter(Boolean).join("\n");
}

export const CANCELLED = "🗑️ 好的，这张单已取消。\n有新问题直接发给我。";

export const INBOX_EXPIRED = "⏳ 刚才的图片或文件已过期，请重新发送。";

export const NUDGE = [
  "还没有提交哦。",
  "想交请回「1」或「确认提交」，想作废请回「2」或「取消」。",
  "「不用了」我分不清你是想交还是想取消。",
].join("\n");

export const NO_QUERY_BY_NUMBER = "目前还不能按工单号查询处理进度。";

export function replacedOtherPrefix(previousSummary) {
  return `🗑️ **上一张已取消**（${previousSummary || "未提交的确认单"}）${SEP}`;
}

/** 依次拼接非空段落，段落之间空一行。 */
export function joinBlocks(...blocks) {
  return blocks.filter((block) => block && String(block).trim()).join("\n\n");
}
