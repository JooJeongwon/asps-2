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

test("AI score JSON becomes Korean Markdown for Notion", () => {
  const score = JSON.stringify({
    total_score: 83,
    scores: {
      record_completeness: { score: 13, max_score: 15 },
      learning_signal_detection: { score: 22, max_score: 25 },
      cause_effect_connection: { score: 16, max_score: 20 },
      action_translation: { score: 17, max_score: 20 },
      learning_attitude_consistency: { score: 15, max_score: 20 },
    },
    key_learning: "멈춰 생각하고 기록하면 배움이 깊어진다.",
    next_action: "핵심 내용과 질문을 한 문장씩 정리한다.",
    mentor_comment: "경험과 배움을 잘 연결했어요.",
    next_reflection_mission: "어떤 메모가 가장 도움이 됐는지 돌아본다.",
  });
  const properties = notionResultProperties(
    { id: "page-1", properties: { Feedback: { type: "rich_text" } } },
    { score: "Feedback" },
    { score },
  );
  const content = ((properties.Feedback as { rich_text: Array<{ text: { content: string } }> }).rich_text[0]).text.content;
  assert.equal(content, `# AI 회고 분석

## TOTAL SCORE
**83점**

## 핵심 배움
멈춰 생각하고 기록하면 배움이 깊어진다.

## 상세 분석
- **기록 완성도**: 13 / 15
- **학습 신호 감지**: 22 / 25
- **원인과 결과 연결**: 16 / 20
- **실행 전환**: 17 / 20
- **학습 태도 일관성**: 15 / 20

## 다음 실행 액션
핵심 내용과 질문을 한 문장씩 정리한다.

## 멘토 코멘트
경험과 배움을 잘 연결했어요.

## 다음 회고 미션
어떤 메모가 가장 도움이 됐는지 돌아본다.`);
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

test("empty text blocks are not unsupported content", async () => {
  const draft = await toNotionDraft(
    { id: "page-3", properties: {} },
    [block("paragraph", { rich_text: [] }), block("paragraph", { rich_text: [{ plain_text: "content" }] })],
    {},
  );
  assert.equal(draft.content, "content");
  assert.equal(draft.warnings.includes("unsupported_block"), false);
});

test("only 작성완료 starts automation", () => {
  assert.equal(isNotionReadyStatus("작성중"), false);
  assert.equal(isNotionReadyStatus("전송대기"), false);
  assert.equal(isNotionReadyStatus("작성완료"), true);
});
