import assert from "node:assert/strict";
import test from "node:test";
import { blocksToPlainText, toNotionDraft } from "../src/services/notion/blocks.ts";

const block = (type: string, value: Record<string, unknown>) => ({ id: crypto.randomUUID(), type, [type]: value });

test("Notion blocks preserve order, Korean text, emoji, and unsupported warnings", async () => {
  const blocks = [
    block("paragraph", { rich_text: [{ plain_text: "첫 줄 😀" }] }),
    block("bulleted_list_item", { rich_text: [{ plain_text: "둘째 줄" }] }),
    block("unsupported", {}),
  ];
  assert.equal(blocksToPlainText(blocks), "첫 줄 😀\n- 둘째 줄\n[Unsupported block: unsupported]");
  const draft = await toNotionDraft(
    { id: "page-1", properties: { Date: { type: "date", date: { start: "2026-09-19" } } } },
    blocks,
    { date: "Date" },
  );
  assert.equal(draft.targetDate, "2026-09-19");
  assert.ok(draft.warnings.includes("unsupported_block"));
  assert.equal(draft.contentHash.length, 64);
});
