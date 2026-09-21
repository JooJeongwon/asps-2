import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureDraft,
  requestScore,
  requestSuggestion,
  saveDraft,
  verifyDraft,
  WorkflowContractError,
  type ThousandSchoolWorkflowClient,
} from "../src/workflows/thousand-school.ts";

const targetDate = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

const response = (content: string, date = targetDate) => ({
  id: 101,
  user_id: 7,
  date,
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
    async organizeDailySnippet(_content, stream) { calls.push(`organize:${String(stream)}`); return { date: targetDate, organized_content: "organized content" }; },
    async getDailySnippetFeedback(stream) { calls.push(`feedback:${String(stream)}`); return { date: targetDate, feedback: "feedback text" }; },
  };
}

test("mapped workflow applies the streamed suggestion before feedback without a duplicate final update", async () => {
  const api = client();
  const draft = await ensureDraft(api, { content: "raw content", targetDate, remoteRecordId: null });
  const suggestion = await requestSuggestion(api, "raw content", targetDate);
  await saveDraft(api, String(draft.id), suggestion, targetDate);
  const score = await requestScore(api, targetDate);
  const saved = await verifyDraft(api, String(draft.id), suggestion, targetDate);

  assert.deepEqual(api.calls, ["page-data", "create", "organize:true", "get", "update", "feedback:true", "get"]);
  assert.equal(suggestion, "organized content");
  assert.equal(score, "feedback text");
  assert.equal(saved.content, "organized content");
});

test("workflow rejects a stale suggestion date", async () => {
  const api = client();
  api.organizeDailySnippet = async () => ({ date: "2000-01-01", organized_content: "stale" });
  await assert.rejects(
    () => requestSuggestion(api, "raw content", targetDate),
    (error: unknown) => error instanceof WorkflowContractError,
  );
});

test("workflow never replaces a draft with an empty suggestion", async () => {
  const api = client();
  api.organizeDailySnippet = async () => ({ date: targetDate, organized_content: "   " });
  await assert.rejects(
    () => requestSuggestion(api, "raw content", targetDate),
    (error: unknown) => error instanceof WorkflowContractError,
  );
});

test("workflow rejects a non-current date before calling 1000.school", async () => {
  const api = client();
  await assert.rejects(
    () => ensureDraft(api, { content: "raw content", targetDate: "2000-01-01", remoteRecordId: null }),
    (error: unknown) => error instanceof WorkflowContractError,
  );
  assert.deepEqual(api.calls, []);
});

test("final verification never overwrites changed remote content", async () => {
  const api = client();
  api.getDailySnippet = async () => { api.calls.push("get"); return response("edited elsewhere"); };
  await assert.rejects(
    () => verifyDraft(api, "101", "organized content", targetDate),
    (error: unknown) => error instanceof WorkflowContractError,
  );
  assert.deepEqual(api.calls, ["get"]);
});

test("draft update checks the remote date before PUT", async () => {
  const api = client();
  api.getDailySnippet = async () => { api.calls.push("get"); return response("old", "2000-01-01"); };
  await assert.rejects(
    () => saveDraft(api, "101", "new", targetDate),
    (error: unknown) => error instanceof WorkflowContractError,
  );
  assert.deepEqual(api.calls, ["get"]);
});
