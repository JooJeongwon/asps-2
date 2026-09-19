import type { NotionBlock, NotionPage } from "./schemas";
import type { NotionClient } from "./client";

export interface NotionPropertyMapping {
  title?: string;
  date?: string;
  status?: string;
  jobId?: string;
  remoteId?: string;
  suggestion?: string;
  score?: string;
  lastError?: string;
}

export interface NotionDraft {
  pageId: string;
  targetDate: string | null;
  status: string | null;
  content: string;
  contentHash: string;
  lastEditedTime: string | null;
  warnings: string[];
}

export function isNotionReadyStatus(status: string | null): boolean {
  return status === "작성완료";
}

export async function hydrateBlockTree(client: NotionClient, blocks: NotionBlock[], depth = 0): Promise<NotionBlock[]> {
  if (depth > 20) return blocks;
  return Promise.all(blocks.map(async (block) => {
    if (!block.has_children) return block;
    const children = await client.listAllBlockChildren(block.id);
    return { ...block, children: await hydrateBlockTree(client, children, depth + 1) };
  }));
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function richText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const entry = object(item);
    if (typeof entry.plain_text === "string") return entry.plain_text;
    return typeof object(entry.text).content === "string" ? object(entry.text).content as string : "";
  }).join("");
}

function blockText(block: NotionBlock): string {
  const data = object(block[block.type]);
  if (block.type === "divider") return "---";
  if (block.type === "child_page" || block.type === "child_database") return String(data.title ?? `[${block.type}]`);
  if (block.type === "equation") return String(data.expression ?? "");
  if (block.type === "code") {
    const language = typeof data.language === "string" ? data.language : "plain text";
    return `\`\`\`${language}\n${richText(data.rich_text)}\n\`\`\``;
  }
  const text = richText(data.rich_text);
  if (text) {
    if (block.type === "bulleted_list_item") return `- ${text}`;
    if (block.type === "numbered_list_item") return `1. ${text}`;
    if (block.type === "quote") return `> ${text}`;
    if (block.type === "to_do") return `[${data.checked === true ? "x" : " "}] ${text}`;
    return text;
  }
  return `[Unsupported block: ${block.type}]`;
}

export function blocksToPlainText(blocks: NotionBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    lines.push(blockText(block));
    if (block.children?.length) {
      lines.push(...blocksToPlainText(block.children).split("\n").map((line) => `  ${line}`));
    }
  }
  return lines.join("\n").trim();
}

export interface NotionResultValues {
  status?: string;
  jobId?: string;
  remoteId?: string;
  suggestion?: string;
  score?: string;
  lastError?: string;
}

function richTextProperty(value: string): { rich_text: Array<{ type: "text"; text: { content: string } }> } {
  return { rich_text: [{ type: "text", text: { content: value } }] };
}

function textProperty(page: NotionPage, name: string, value: string): Record<string, unknown> {
  const type = typeof object(page.properties[name]).type === "string" ? object(page.properties[name]).type as string : "";
  if (type === "title") return { title: [{ type: "text", text: { content: value } }] };
  if (type === "rich_text") return richTextProperty(value);
  throw new Error(`Notion property ${name} must be title or rich_text`);
}

function statusProperty(page: NotionPage, name: string, value: string): Record<string, unknown> {
  const type = typeof object(page.properties[name]).type === "string" ? object(page.properties[name]).type as string : "";
  if (type === "select") return { select: { name: value } };
  if (type === "status") return { status: { name: value } };
  if (type === "rich_text") return richTextProperty(value);
  throw new Error(`Notion property ${name} must be select, status, or rich_text`);
}

function scoreProperty(page: NotionPage, name: string, value: string): Record<string, unknown> {
  const type = typeof object(page.properties[name]).type === "string" ? object(page.properties[name]).type as string : "";
  if (type === "rich_text" || type === "title") return textProperty(page, name, value);
  if (type === "number") {
    const number = Number(value);
    if (Number.isFinite(number)) return { number };
  }
  throw new Error(`Notion property ${name} must be rich_text or numeric feedback`);
}

export function notionResultProperties(
  page: NotionPage,
  mapping: NotionPropertyMapping,
  values: NotionResultValues,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  if (mapping.status && values.status !== undefined && page.properties[mapping.status]) properties[mapping.status] = statusProperty(page, mapping.status, values.status);
  if (mapping.jobId && values.jobId !== undefined && page.properties[mapping.jobId]) properties[mapping.jobId] = textProperty(page, mapping.jobId, values.jobId);
  if (mapping.remoteId && values.remoteId !== undefined && page.properties[mapping.remoteId]) properties[mapping.remoteId] = textProperty(page, mapping.remoteId, values.remoteId);
  if (mapping.suggestion && values.suggestion !== undefined && page.properties[mapping.suggestion]) properties[mapping.suggestion] = textProperty(page, mapping.suggestion, values.suggestion);
  if (mapping.score && values.score !== undefined && page.properties[mapping.score]) properties[mapping.score] = scoreProperty(page, mapping.score, values.score);
  if (mapping.lastError && values.lastError !== undefined && page.properties[mapping.lastError]) properties[mapping.lastError] = textProperty(page, mapping.lastError, values.lastError);
  return properties;
}

function hasUnsupportedBlock(blocks: NotionBlock[]): boolean {
  return blocks.some((block) => blockText(block).startsWith("[Unsupported block:") || (block.children ? hasUnsupportedBlock(block.children) : false));
}

function propertyValue(page: NotionPage, name: string | undefined): unknown {
  return name ? page.properties[name] : undefined;
}

function propertyText(value: unknown): string | null {
  const property = object(value);
  const type = typeof property.type === "string" ? property.type : "";
  const data = object(property[type]);
  if (type === "title" || type === "rich_text") return richText(data.rich_text ?? data.title) || null;
  if (type === "select" || type === "status") return typeof data.name === "string" ? data.name : null;
  if (type === "date") return typeof data.start === "string" ? data.start : null;
  if (type === "number") return typeof data.number === "number" ? String(data.number) : null;
  return null;
}

function dateOnly(value: string | null): string | null {
  const match = value?.match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/);
  return match?.[1] ?? null;
}

export async function toNotionDraft(page: NotionPage, blocks: NotionBlock[], mapping: NotionPropertyMapping): Promise<NotionDraft> {
  const content = blocksToPlainText(blocks);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const contentHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const warnings: string[] = [];
  const rawTargetDate = propertyText(propertyValue(page, mapping.date));
  const targetDate = dateOnly(rawTargetDate);
  const status = propertyText(propertyValue(page, mapping.status));
  if (!rawTargetDate) warnings.push("missing_date_property");
  else if (!targetDate) warnings.push("invalid_date_property");
  if (!content) warnings.push("empty_content");
  if (hasUnsupportedBlock(blocks)) warnings.push("unsupported_block");
  return {
    pageId: page.id,
    targetDate,
    status,
    content,
    contentHash,
    lastEditedTime: page.last_edited_time ?? null,
    warnings,
  };
}
