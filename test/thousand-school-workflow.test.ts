import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureDraft,
  requestScore,
  requestSuggestion,
  saveDraft,
  WorkflowContractError,
  type ThousandSchoolWorkflowClient,
} from "../src/workflows/thousand-school.ts";

const response = (content: string) => ({
  id: 101,
  user_id: 7,
  date: "2026-09-19",
  content,
  created_at: "2026-09-19T00:00:00.000Z",
  updated_at: "2026-09-19T00:00:00.000Z",
});

function client(): ThousandSchoolWorkflowClient & { calls: string[] } {
  const calls: string[] = [];
  let content = "";
  return {
    calls,
    async getDailySnippetPageData() { calls.push("page-data"); return { snippet: null, read_only: false, prev_id: null, next_id: null }; },
    async getDailySnippet() { calls.push("get"); return response(content); },
    async createDailySnippet(value) { calls.push("create"); content = value; return response(content); },
    async updateDailySnippet(_id, value) { calls.push("update"); content = value; return response(content); },
    async organizeDailySnippet(_content, stream) { calls.push(`organize:${String(stream)}`); return { date: "2026-09-19", organized_content: "organized content" }; },
    async getDailySnippetFeedback(stream) { calls.push(`feedback:${String(stream)}`); return { date: "2026-09-19", feedback: "feedback text" }; },
  };
}

test("mapped workflow applies the streamed suggestion before feedback without a duplicate final update", async () => {
  const api = client();
  const draft = await ensureDraft(api, { content: "raw content", targetDate: "2026-09-19", remoteRecordId: null });
  const suggestion = await requestSuggestion(api, "raw content", "2026-09-19");
  await saveDraft(api, String(draft.id), suggestion, "2026-09-19");
  const score = await requestScore(api, "2026-09-19");
  const saved = await saveDraft(api, String(draft.id), suggestion, "2026-09-19");

  assert.deepEqual(api.calls, ["page-data", "create", "organize:true", "get", "update", "feedback:true", "get"]);
  assert.equal(suggestion, "organized content");
  assert.equal(score, "feedback text");
  assert.equal(saved.content, "organized content");
});

test("workflow rejects a stale suggestion date", async () => {
  const api = client();
  api.organizeDailySnippet = async () => ({ date: "2026-09-18", organized_content: "stale" });
  await assert.rejects(
    () => requestSuggestion(api, "raw content", "2026-09-19"),
    (error: unknown) => error instanceof WorkflowContractError,
  );
});
