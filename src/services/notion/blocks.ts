import type { NotionBlock, NotionPage } from "./schemas";
import type { NotionClient } from "./client";

export interface NotionPropertyMapping {
  title?: string;
  date?: string;
  status?: string;
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

export async function toNotionDraft(page: NotionPage, blocks: NotionBlock[], mapping: NotionPropertyMapping): Promise<NotionDraft> {
  const content = blocksToPlainText(blocks);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const contentHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const warnings: string[] = [];
  const targetDate = propertyText(propertyValue(page, mapping.date));
  const status = propertyText(propertyValue(page, mapping.status));
  if (!targetDate) warnings.push("missing_date_property");
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
