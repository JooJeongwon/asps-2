import type {
  DailySnippetPageDataResponse,
  DailySnippetResponse,
} from "../services/thousand-school/schemas";

export interface ThousandSchoolWorkflowClient {
  getDailySnippetPageData(params: { date: string }): Promise<DailySnippetPageDataResponse>;
  getDailySnippet(snippetId: number): Promise<DailySnippetResponse>;
  createDailySnippet(content: string): Promise<DailySnippetResponse>;
  updateDailySnippet(snippetId: number, content: string): Promise<DailySnippetResponse>;
  organizeDailySnippet(content: string, stream?: boolean): Promise<{ date: string; organized_content: string }>;
  getDailySnippetFeedback(stream?: boolean): Promise<{ date: string; feedback?: string | null }>;
}

export class WorkflowContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowContractError";
  }
}

function assertDate(actual: string, expected: string, stage: string): void {
  if (actual !== expected) throw new WorkflowContractError(`${stage} result date does not match the job date`);
}

function snippetId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new WorkflowContractError("Stored remote snippet ID is invalid");
  return id;
}

export async function ensureDraft(
  client: ThousandSchoolWorkflowClient,
  input: { content: string; targetDate: string; remoteRecordId: string | null },
): Promise<DailySnippetResponse> {
  if (input.remoteRecordId) {
    const result = await client.updateDailySnippet(snippetId(input.remoteRecordId), input.content);
    assertDate(result.date, input.targetDate, "Draft");
    return result;
  }

  const pageData = await client.getDailySnippetPageData({ date: input.targetDate });
  if (pageData.snippet) {
    assertDate(pageData.snippet.date, input.targetDate, "Existing draft");
    const result = await client.updateDailySnippet(pageData.snippet.id, input.content);
    assertDate(result.date, input.targetDate, "Draft");
    return result;
  }

  const result = await client.createDailySnippet(input.content);
  assertDate(result.date, input.targetDate, "Draft");
  return result;
}

export async function requestSuggestion(
  client: ThousandSchoolWorkflowClient,
  content: string,
  targetDate: string,
): Promise<string> {
  const result = await client.organizeDailySnippet(content, true);
  assertDate(result.date, targetDate, "AI suggestion");
  return result.organized_content;
}

export async function requestScore(
  client: ThousandSchoolWorkflowClient,
  targetDate: string,
): Promise<string> {
  const result = await client.getDailySnippetFeedback(true);
  assertDate(result.date, targetDate, "AI score");
  return result.feedback ?? "";
}

export async function saveDraft(
  client: ThousandSchoolWorkflowClient,
  draftId: string,
  content: string,
  targetDate: string,
): Promise<DailySnippetResponse> {
  const id = snippetId(draftId);
  const current = await client.getDailySnippet(id);
  assertDate(current.date, targetDate, "Saved draft");
  if (current.content === content) return current;
  const result = await client.updateDailySnippet(id, content);
  assertDate(result.date, targetDate, "Saved draft");
  if (result.content !== content) throw new WorkflowContractError("Saved draft content does not match the requested content");
  return result;
}
