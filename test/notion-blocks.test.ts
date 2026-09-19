import assert from "node:assert/strict";
import test from "node:test";
import { blocksToPlainText, isNotionReadyStatus, notionResultProperties, toNotionDraft } from "../src/services/notion/blocks.ts";

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

test("Notion result mapping writes the job ID and feedback", () => {
  const properties = notionResultProperties(
    {
      id: "page-1",
      properties: {
        Status: { type: "select" },
        Job: { type: "rich_text" },
        Feedback: { type: "rich_text" },
      },
    },
    { status: "Status", jobId: "Job", score: "Feedback" },
    { status: "처리중", jobId: "job-1", score: "좋습니다" },
  );
  assert.deepEqual(properties, {
    Status: { select: { name: "처리중" } },
    Job: { rich_text: [{ type: "text", text: { content: "job-1" } }] },
    Feedback: { rich_text: [{ type: "text", text: { content: "좋습니다" } }] },
  });
});

test("Notion date-time values become daily dates", async () => {
  const draft = await toNotionDraft(
    { id: "page-2", properties: { Date: { type: "date", date: { start: "2026-09-19T09:30:00.000+09:00" } } } },
    [block("paragraph", { rich_text: [{ plain_text: "content" }] })],
    { date: "Date" },
  );
  assert.equal(draft.targetDate, "2026-09-19");
  assert.equal(draft.warnings.includes("invalid_date_property"), false);
});

test("only 작성완료 starts automation", () => {
  assert.equal(isNotionReadyStatus("작성중"), false);
  assert.equal(isNotionReadyStatus("전송대기"), false);
  assert.equal(isNotionReadyStatus("작성완료"), true);
});
